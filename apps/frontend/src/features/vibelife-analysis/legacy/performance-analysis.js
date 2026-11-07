/**
 * Read-only performance analysis over the canonical document.
 * Recorded quantities/cash, replay proof and public dated prices stay separate.
 * No function in this module writes facts, changes principal, or repairs imports.
 */
import { buildPortfolioReplay, buildReferencePortfolioTail } from "./portfolio-replay.js?v=f850725fbb";
import { deriveCanonicalFundingReconciliation, prepareCanonicalBenchmarkFunding } from "./canonical-funding.js?v=12b3137d4b";
import { buildCashFlowMatchedBenchmark } from "./cash-flow-benchmark.js?v=c001ae879d";
import { buildUsEquityCalendar } from "./us-market-calendar.js?v=ae06e3196e";

export const PERFORMANCE_START_DATE = "2026-03-20";
const numeric = (x) => (typeof x === "number" || typeof x === "string" && x.trim() !== "") && Number.isFinite(Number(x)) ? Number(x) : null;
const list = (x) => Array.isArray(x) ? x : x && typeof x === "object" ? Object.values(x) : [];
const map = (x) => x instanceof Map ? x : new Map(Object.entries(x || {}));
const text = (x) => typeof x === "string" ? x.trim() : "";
const dayGap = (a, b) => (Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000;
const issue = (code, message, details = {}) => ({ code, message, ...details });
const isCash = (row) => row.type === "cash" || ["CASH", "现金"].includes(text(row.asset).toUpperCase());
const isFund = (row) => row.account === "支付宝基金";
const legacyFund = (row) => isFund(row) && !(numeric(row.marketPrice) > 0) && !text(row.navSource).startsWith("东方财富");

function latestPrice(series, date, maxAge) {
  const values = map(series);
  const exact = numeric(values.get(date));
  if (exact > 0) return { price: exact, date };
  let best = "";
  for (const [day, value] of values) if (day <= date && day > best && numeric(value) > 0) best = day;
  return best && dayGap(best, date) <= maxAge ? { price: Number(values.get(best)), date: best } : null;
}

export function valuationFx(date, currency, market) {
  if (currency === "USD") return { usdPerUnit: 1, date, asOfDate: date, source: "native-usd" };
  const symbol = { CNY: "CNY=X", HKD: "HKD=X" }[currency];
  const source = map(market).get(symbol);
  if (!source || source.currency && source.currency !== currency || source.priceBasis !== "reference-rate") return null;
  const rate = latestPrice(source.series, date, 7);
  return rate ? { date, asOfDate: rate.date, usdPerUnit: 1 / rate.price, source: source.source || "dated-reference-fx" } : null;
}

/** No present-day price, average cost or legacy fund amount is substituted for a historical price. */
export function valueHistoricalState(rows, date, market = new Map()) {
  const prices = map(market), issues = [], navAsOf = [], fxAsOf = [], sources = new Set();
  let totalUsd = 0;
  if (!Array.isArray(rows) || !rows.length) return { totalUsd: null, issues: [issue("valuation-no-rows", "缺少当日持仓与现金", { date })], navAsOf, fxAsOf };
  for (const row of rows) {
    const quantity = numeric(row?.quantity);
    if (quantity === null || quantity < 0) { issues.push(issue("valuation-quantity-invalid", "持仓数量无效", { date, account: row?.account, asset: row?.asset })); continue; }
    if (quantity === 0) continue;
    const currency = text(row.currency).toUpperCase();
    const fx = valuationFx(date, currency, prices);
    if (!fx) { issues.push(issue("valuation-fx-missing", "缺少该日可用汇率", { date, currency })); continue; }
    if (fx.asOfDate !== date) fxAsOf.push({ currency, date: fx.asOfDate });
    sources.add(fx.source);
    if (isCash(row)) { totalUsd += quantity * fx.usdPerUnit; continue; }
    if (legacyFund(row)) {
      issues.push(issue("legacy-fund-amount-basis", "支付宝旧记录为金额，不能当成基金份额重估", { date, account: row.account, asset: row.asset })); continue;
    }
    const symbol = isFund(row) ? text(row.fundCode) : text(row.asset).toUpperCase();
    const series = prices.get(symbol);
    const validBasis = isFund(row) ? series?.priceBasis === "fund-nav"
      : ["unadjusted", "unadjusted-reconstructed-from-splits"].includes(series?.priceBasis);
    if (!validBasis || series?.currency && series.currency !== currency) {
      issues.push(issue("valuation-price-basis-unavailable", "缺少可用于实际持仓的历史价格", { date, symbol, account: row.account })); continue;
    }
    const quote = latestPrice(series.series, date, isFund(row) ? 10 : 0);
    if (!quote) { issues.push(issue("valuation-price-missing", "缺少当日收盘价或已公布净值", { date, symbol, account: row.account })); continue; }
    if (quote.date !== date) navAsOf.push({ code: symbol, date: quote.date });
    sources.add(series.source || (isFund(row) ? "fund-nav" : "historical-close"));
    totalUsd += quantity * quote.price * fx.usdPerUnit;
  }
  if (!Number.isFinite(totalUsd)) issues.push(issue("valuation-overflow", "估值超出有效范围", { date }));
  return { totalUsd: issues.length ? null : totalUsd, issues, navAsOf, fxAsOf, sources: [...sources], estimated: navAsOf.length > 0 || fxAsOf.length > 0 };
}

function netExternalUsd(replay, from, through, market) {
  let amount = 0;
  for (const flow of replay.externalFlows || []) {
    if (flow.date <= from || flow.date > through) continue;
    const fx = valuationFx(flow.date, flow.currency, market);
    if (!fx) return null;
    amount += flow.amountMinor / 100 * fx.usdPerUnit;
  }
  return amount;
}

// Snapshot principal is independent of the QQQ simulation and its price coverage.
function applyCostBasis(points, snapshots, cashFlows, market) {
  const ordered = snapshots.filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s?.date || ""))
    .sort((a, b) => a.date.localeCompare(b.date));
  const last = ordered.at(-1);
  const flows = list(cashFlows).filter((f) => f?.status === "applied"
    && (["externalDeposit", "externalWithdraw"].includes(f.kind)
      || f.kind === "manualCorrection" && f.sourceKind === "manual:cny-principal") && f.flowDate > last?.date)
    .sort((a, b) => a.flowDate.localeCompare(b.flowDate));
  let index = 0, snapshot = null, flowIndex = 0, adjustment = 0, unconverted = false;
  const failedFlows = [];
  for (const point of points) {
    while (index < ordered.length && ordered[index].date <= point.date) snapshot = ordered[index++];
    if (!snapshot) { point.costBasisUsd = null; continue; }
    const principal = numeric(snapshot.principalUsd);
    if (point.date > last.date) {
      while (flowIndex < flows.length && flows[flowIndex].flowDate <= point.date) {
        const flow = flows[flowIndex++], amount = numeric(flow.amountMinor);
        const fx = valuationFx(flow.flowDate, text(flow.currency).toUpperCase(), market);
        if (!fx || amount === null || !Number.isSafeInteger(amount) || amount === 0
          || flow.kind === "externalDeposit" && amount < 0 || flow.kind === "externalWithdraw" && amount > 0) { unconverted = true; failedFlows.push(flow); }
        else if (!unconverted) adjustment += amount / 100 * fx.usdPerUnit;
      }
      point.costBasisEstimated = true;
    }
    point.costBasisUsd = principal === null ? null : principal + (point.date > last.date ? adjustment : 0);
  }
  return failedFlows.length ? [issue("cost-basis-unconverted", `成本基准遇到 ${failedFlows.length} 笔无法换算的流水，之后流水亦未计入：` + failedFlows.slice(0, 3).map((flow) => `${flow.flowDate} ${numeric(flow.amountMinor) === null ? "金额无效" : Number(flow.amountMinor) / 100} ${text(flow.currency) || "币种未知"}`).join("；"))] : [];
}

/** Display-only use of saved estimates and recorded principal changes, never a ledger fact. */
function applyReferenceEstimates(points, snapshots, replay, market, qqq, data, referenceTail) {
  const byDate = new Map();
  const lastPointDate = points.at(-1)?.date;
  for (const snapshot of snapshots) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshot?.date || "") || !lastPointDate || snapshot.date > lastPointDate) continue;
    if (referenceTail?.basisDate && snapshot.date > referenceTail.basisDate) continue;
    // Conflicting checkpoints must not be silently selected.
    if (byDate.has(snapshot.date)) byDate.set(snapshot.date, null);
    else byDate.set(snapshot.date, snapshot);
  }
  for (const point of points) {
    if (referenceTail?.basisDate && point.date > referenceTail.basisDate) continue;
    const snap = byDate.get(point.date);
    const saved = numeric(snap?.totalUsd);
    if (point.totalUsd === null && snap?.estimated === true && saved !== null && saved >= 0) {
      point.totalUsd = point.equityUsd = saved;
      point.estimated = true;
      point.displayHistoryOrigin = "saved-reference-estimate";
      point.reason = "沿用历史估算快照，旧基金按当时记录金额，持仓与资金日期待核实";
    }
  }
  // Build one dated funding schedule for both the portfolio and QQQ. A closed-day
  // contribution uses its recorded-day FX and executes on the next market session.
  const referenceQqqRequired = qqq?.adjusted === true && points.some((p) => p.qqqEquityUsd === null);
  if (referenceQqqRequired) for (const point of points) point.qqqEquityUsd = point.netContributionsUsd = null;
  const rows = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
  const first = points.find((p) => p.totalUsd !== null && byDate.get(p.date) && numeric(byDate.get(p.date).principalCny) !== null);
  if (!first || !(first.totalUsd > 0)) return;
  const startIndex = rows.findIndex(([date]) => date === first.date);
  if (startIndex < 0) return;
  const observed = rows.slice(startIndex), lastObserved = observed.at(-1)[0], scheduled = new Map();
  const stateDate = text(data?.state?.settings?.snapshotDate);
  const recordedEnd = /^\d{4}-\d{2}-\d{2}$/.test(stateDate) && stateDate > lastObserved ? stateDate : lastObserved;
  const lastDate = referenceTail?.lastDate && referenceTail.lastDate > recordedEnd ? referenceTail.lastDate : recordedEnd;
  let brokenAt = null;
  for (let i = 1; i < observed.length; i++) {
    const [prevDate, prev] = observed[i - 1], [curDate, cur] = observed[i];
    const execution = points.find((p) => p.date >= curDate)?.date;
    if (!execution) continue;
    if (numeric(prev?.principalCny) === null || numeric(cur?.principalCny) === null
      || (replay.externalFlows || []).some((f) => f.date > prevDate && f.date <= curDate)) { brokenAt = execution; break; }
    const delta = Math.round((Number(cur.principalCny) - Number(prev.principalCny)) * 100) / 100;
    const fx = delta ? valuationFx(curDate, "CNY", market) : null;
    if (delta && !fx) { brokenAt = execution; break; }
    if (delta) scheduled.set(execution, (scheduled.get(execution) || 0) + delta * fx.usdPerUnit);
  }
  // Beyond the last principal observation, assume no new flow only until the saved
  // state date, and stop if any later funding evidence exists rather than guessing.
  const laterFlow = list(data?.brokerImportLedger?.cashFlows).filter((f) => f?.status !== "ignored"
    && f?.flowDate > lastObserved && f.flowDate <= recordedEnd).sort((a, b) => a.flowDate.localeCompare(b.flowDate))[0];
  if (laterFlow) {
    const flowSession = points.find((p) => p.date >= laterFlow.flowDate)?.date;
    if (flowSession && (!brokenAt || flowSession < brokenAt)) brokenAt = flowSession;
  }
  // Beyond the recorded basis, both curves use the same confirmed external events.
  // Trades, internal transfers and dividends never become QQQ contributions.
  for (const flow of referenceTail?.externalFlows || []) {
    const execution = points.find((point) => point.date >= flow.date)?.date;
    if (!execution) continue;
    const fx = valuationFx(flow.date, flow.currency, market);
    if (!fx) { if (!brokenAt || execution < brokenAt) brokenAt = execution; continue; }
    scheduled.set(execution, (scheduled.get(execution) || 0) + flow.amountMinor / 100 * fx.usdPerUnit);
  }
  if (referenceTail?.blockedAt) {
    const stop = points.find((point) => point.date >= referenceTail.blockedAt)?.date;
    if (stop && (!brokenAt || stop < brokenAt)) brokenAt = stop;
  }
  // A daily estimate also requires observations at both trading-session endpoints;
  // missing or conflicting funding evidence never becomes a zero contribution.
  for (let i = 1; i < points.length; i++) {
    const point = points[i], previous = points[i - 1];
    if (point.dailyProfitUsd !== null || point.totalUsd === null || previous.totalUsd === null || !(previous.totalUsd > 0)) continue;
    if (previous.date < first.date || brokenAt && point.date >= brokenAt
      || numeric(byDate.get(previous.date)?.principalCny) === null || numeric(byDate.get(point.date)?.principalCny) === null
      || (replay.externalFlows || []).some((f) => f.date > previous.date && f.date <= point.date)) continue;
    const flow = scheduled.get(point.date) || 0;
    point.dailyProfitUsd = point.totalUsd - previous.totalUsd - flow;
    point.dailyReturnRate = point.dailyProfitUsd / previous.totalUsd;
    point.netCashFlowUsd = flow;
    point.estimated = true;
    point.referenceFlow = true;
  }
  if (!referenceQqqRequired) return;
  const closes = map(qqq.closes);
  let units = null, netContributionsUsd = first.totalUsd;
  for (const point of points) {
    if (point.date < first.date || point.date > lastDate || brokenAt && point.date >= brokenAt) continue;
    const close = numeric(closes.get(point.date));
    if (!(close > 0)) break; // Missing price is not a market holiday and cannot be bridged.
    if (units === null) units = first.totalUsd / close;
    const flow = scheduled.get(point.date) || 0;
    if (flow < 0 && -flow > units * close + 1e-8) break;
    units += flow / close;
    netContributionsUsd += flow;
    point.qqqEquityUsd = units * close;
    point.netContributionsUsd = netContributionsUsd;
    point.qqqReference = true;
    if (point.date > lastObserved) point.qqqFundingAssumed = true;
  }
}

/** Full fixed-start computation; presentation ranges are applied only by selectPerformancePoints. */
export function buildPerformanceAnalysis({ data, throughDate, market = new Map(), qqq = {}, startDate = PERFORMANCE_START_DATE, reference = false } = {}) {
  qqq = qqq || {};
  const calendar = buildUsEquityCalendar({ startDate, endDate: throughDate });
  const snapshots = list(data?.history?.dailySnapshots);
  const rawDate = data?.state?.settings?.snapshotDate;
  const currentCheckpoint = rawDate && rawDate <= throughDate ? {
    date: rawDate, estimated: false, rows: data.state.rows,
    capturedAt: data.updatedAt, source: data.quoteSource || "当前已保存持仓",
  } : null;
  const replay = buildPortfolioReplay({ history: data?.history, brokerImportLedger: data?.brokerImportLedger,
    dcaSyncLedger: data?.dcaSyncLedger, startDate, throughDate,
    valuationDates: calendar.marketSessions, currentCheckpoint });
  const referenceTail = reference ? buildReferencePortfolioTail({ replay, brokerImportLedger: data?.brokerImportLedger,
    dcaSyncLedger: data?.dcaSyncLedger, throughDate, valuationDates: calendar.marketSessions }) : null;
  const fxByDate = new Map();
  for (const flow of list(data?.brokerImportLedger?.cashFlows)) {
    if (!flow?.flowDate) continue;
    fxByDate.set(flow.flowDate, Object.fromEntries(["CNY", "HKD"].map((currency) => [currency, valuationFx(flow.flowDate, currency, market)])));
  }
  const openingCheckpoint = snapshots.filter((x) => x?.estimated === false && x.date < startDate && Array.isArray(x.rows))
    .sort((a, b) => a.date.localeCompare(b.date)).at(-1);
  const eventsBeforeStart = [...list(data?.brokerImportLedger?.trades).map((x) => ({ ...x, date: x.tradeDate })),
    ...list(data?.brokerImportLedger?.cashFlows).map((x) => ({ ...x, date: x.flowDate }))]
    .some((x) => x.status !== "ignored" && openingCheckpoint && x.date > openingCheckpoint.date && x.date < startDate);
  const openingValue = openingCheckpoint && !eventsBeforeStart ? valueHistoricalState(openingCheckpoint.rows, startDate, market) : null;
  const openingValuation = openingValue?.totalUsd !== null && openingValue?.totalUsd !== undefined ? {
    date: startDate, checkpointDate: openingCheckpoint.date, totalUsd: openingValue.totalUsd,
    sourceRefs: ["history.dailySnapshots:" + openingCheckpoint.date, ...(openingValue.sources || [])],
    includesStartDateFlows: false,
  } : null;
  const reconciliation = deriveCanonicalFundingReconciliation({ data, replay, startDate, throughDate, fxByDate, openingValuation });
  const funding = prepareCanonicalBenchmarkFunding({ data, startDate, throughDate, fxByDate, reconciliation });
  const benchmark = buildCashFlowMatchedBenchmark({
    ...funding.benchmarkInput, closes: qqq?.adjusted === true ? qqq.closes : new Map(),
    marketSessions: calendar.marketSessions, calendarCoverage: calendar.calendarCoverage,
    priceBasis: "adjusted",
  });
  const states = new Map(replay.dailyStates.map((s) => [s.date, s]));
  if (reference) {
    // Matching endpoints do not prove the individual fee dates; this branch is display-only.
    const eligible = new Map(replay.checkpoints.filter((p) => !p.ok && p.holdingsMatch && p.cashMatch
      && !p.differences.length && p.issues.length && p.issues.every((x) => x.code === "trade-cash-estimated"))
      .map((p) => [p.from + "/" + p.to, p]));
    for (const state of replay.candidateStates) {
      const proof = eligible.get(state.intervalAudit?.from + "/" + state.intervalAudit?.to);
      if (!proof || states.has(state.date)) continue;
      states.set(state.date, { ...state, origin: "reference-estimated-fees", intervalAudit: { ...state.intervalAudit, ok: true, reference: true } });
    }
    for (const proof of eligible.values()) {
      const state = states.get(proof.to);
      if (state) states.set(proof.to, { ...state, intervalAudit: { ...state.intervalAudit, ok: true, reference: true } });
    }
  }
  if (referenceTail) for (const state of referenceTail.dailyStates) states.set(state.date, state);
  const valuations = [], points = [];
  const benchmarkByDate = new Map((benchmark.points || []).map((p) => [p.date, p]));
  for (const date of calendar.marketSessions) {
    const state = states.get(date);
    const value = state ? valueHistoricalState(state.rows, date, market) : { totalUsd: null, issues: [], navAsOf: [], fxAsOf: [] };
    valuations.push(...value.issues);
    // A quote from a different future day may have accompanied different holdings.
    // Keep this explicit gap instead of silently moving the snapshot to that date.
    const dateMismatch = state?.recordedValuationDateMismatch === true && state?.sourceQuoteDate > state?.checkpointDate;
    const totalUsd = dateMismatch ? null : value.totalUsd;
    const bench = benchmarkByDate.get(date);
    points.push({
      date, label: date, totalUsd, equityUsd: totalUsd,
      qqqEquityUsd: numeric(bench?.equityUsd), qqqProfitUsd: numeric(bench?.profitUsd),
      netContributionsUsd: numeric(bench?.netContributionsUsd),
      returnUsd: null, returnRate: null, excessUsd: null, dailyProfitUsd: null, dailyReturnRate: null,
      benchmarkReturn: null, comparisonReturn: null,
      estimated: Boolean(value.estimated || state?.intervalAudit?.reference), displayNavAsOf: value.navAsOf, displayFxAsOf: value.fxAsOf,
      displayHistoryOrigin: state?.origin || "missing-records",
      intervalAudit: state?.intervalAudit || null,
      source: state?.source || "", capturedAt: state?.capturedAt || "",
      checkpointDate: state?.checkpointDate || null,
      referenceBasisDate: state?.referenceBasisDate || null, referenceTail: Boolean(state?.referenceTail),
      reason: dateMismatch ? "快照日期与行情来源不一致" : value.issues[0]?.message || (!state
        ? referenceTail?.blockedAt && date >= referenceTail.blockedAt ? "存在待核实的已登记变动，参考续算暂停" : "该日交易与现金尚未闭合" : ""),
    });
  }
  for (let i = 1; i < points.length; i++) {
    const point = points[i], previous = points[i - 1], proof = point.intervalAudit;
    if (point.totalUsd === null || previous.totalUsd === null || !proof?.ok || previous.date < proof.from || point.date > proof.to) continue;
    const flowUsd = netExternalUsd(replay, previous.date, point.date, market);
    if (flowUsd === null || !(previous.totalUsd > 0)) continue;
    const profit = point.totalUsd - previous.totalUsd - flowUsd;
    point.dailyProfitUsd = profit;
    point.dailyReturnRate = profit / previous.totalUsd;
    point.netCashFlowUsd = flowUsd;
  }
  if (reference) applyReferenceEstimates(points, snapshots, replay, market, qqq, data, referenceTail);
  const costBasisIssues = applyCostBasis(points, snapshots, data?.brokerImportLedger?.cashFlows, market);
  const fullyComparable = !reference && funding.status === "available" && benchmark.status === "available"
    && replay.status === "reconciled" && points.length > 0 && points.every((p) => p.totalUsd !== null && p.qqqEquityUsd !== null);
  if (fullyComparable) for (const point of points) {
    point.returnUsd = point.totalUsd - point.netContributionsUsd;
    point.excessUsd = point.totalUsd - point.qqqEquityUsd;
  }
  const lastValued = [...points].reverse().find((p) => p.totalUsd !== null);
  const headline = fullyComparable ? points.at(-1) : null;
  const rawTradeCount = list(data?.brokerImportLedger?.trades).length;
  return {
    status: fullyComparable ? "available" : "partial", startDate, throughDate,
    sourceUpdatedAt: data?.updatedAt || null, calendar, replay, funding, benchmark, points,
    referenceTail: referenceTail ? { basisDate: referenceTail.basisDate, throughDate: referenceTail.lastDate,
      blockedAt: referenceTail.blockedAt, issues: referenceTail.issues, days: referenceTail.dailyStates.length } : null,
    asOfDate: lastValued?.date || null, headline, valuations,
    stats: { trades: rawTradeCount, cashFlows: list(data?.brokerImportLedger?.cashFlows).length,
      recordedSnapshots: replay.counts.recordedSnapshots, excludedEstimates: replay.counts.estimatedSnapshotsExcluded,
      reconciledSegments: replay.counts.reconciledSegments, failedSegments: replay.counts.failedSegments,
      valuedDays: points.filter((p) => p.totalUsd !== null).length,
      cashConflicts: replay.issues.filter((x) => x.code === "trade-cash-conflict").length },
    issues: [...costBasisIssues, ...(calendar.reasons || []), ...(reconciliation.issues || []), ...funding.reasons, ...(benchmark.reasons || []),
      ...replay.issues, ...(referenceTail?.issues || []), ...replay.checkpoints.filter((x) => !x.ok).map((x) =>
        issue("checkpoint-not-reconciled", "持仓或现金尚未对上", { from: x.from, date: x.to, differences: x.differences })),
      ...(qqq?.adjusted === true ? [] : [issue("qqq-total-return-unavailable", "QQQ 含分红行情尚不可用")])],
    quoteStatus: { source: qqq.source || "", stale: Boolean(qqq.stale), refreshFailed: Boolean(qqq.refreshFailed), adjusted: qqq?.adjusted === true },
  };
}

/** Select a display range without rebuying QQQ or resetting matched dollar results. */
export function selectPerformancePoints(report, { start = "", end = "", grain = "day", metric = "returnUsd", comparable = false, qqqCloses = new Map() } = {}) {
  let selected = (report?.points || []).filter((p) => (!start || p.date >= start) && (!end || p.date <= end)).map((p) => ({ ...p }));
  if (comparable) {
    let run = [], latest = [];
    for (const point of selected) {
      if (point.totalUsd === null || !(numeric(map(qqqCloses).get(point.date)) > 0)) { if (run.length > 1) latest = run; run = []; continue; }
      if (run.length && point.dailyReturnRate === null) { if (run.length > 1) latest = run; run = []; }
      run.push(point);
    }
    selected = run.length > 1 ? run : latest;
  }
  if (metric === "returnRate" && selected.length) {
    const closes = map(qqqCloses);
    let product = 1, base = null, previous = false, segment = 0;
    for (let i = 0; i < selected.length; i++) {
      const point = selected[i], close = numeric(closes.get(point.date));
      point.comparisonReturn = point.benchmarkReturn = null;
      point.comparisonSegment = null;
      if (point.totalUsd === null || !(close > 0)) { previous = false; continue; }
      if (!previous || point.dailyReturnRate === null) {
        segment += 1; product = 1; base = close;
      } else product *= 1 + point.dailyReturnRate;
      point.comparisonReturn = product - 1;
      point.benchmarkReturn = close / base - 1;
      point.comparisonSegment = segment;
      previous = true;
    }
  }
  if (grain === "day") return selected;
  const grouped = new Map();
  for (const point of selected) {
    const label = point.date.slice(0, grain === "month" ? 7 : 4);
    grouped.set(label, { ...point, label });
  }
  const endpoints = [...grouped.values()];
  if (metric === "returnRate" && selected.length && endpoints[0]?.date !== selected[0].date) endpoints.unshift({ ...selected[0] });
  return endpoints;
}
