/**
 * Read-only, cash-flow-matched QQQ scenario. This module does not infer deposits
 * from principal balances, portfolio snapshots, trades or fund/DCA cost changes.
 * The caller must reconcile the opening capital and complete funding history.
 * Audit flags may be established from existing records; they do not require new
 * persisted fields or repeated user confirmation. Quote and FX provenance stays
 * the caller's responsibility.
 */
const text = (value) => typeof value === "string" ? value.trim() : "";
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const isMoney = (value) => isNumber(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER / 100;
const isDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
// Only absorb an absolute floating-point residue, never a balance-scaled
// monetary difference. Any accepted negative residue is explicitly set to zero.
const closeEnough = (left, right) => Math.abs(left - right) <= 1e-8;
const reason = (code, message, detail = {}) => ({ code, message, ...detail });
const increment = (map, key) => map.set(key, (map.get(key) || 0) + 1);
const internalKinds = new Set([
  "trade", "buy", "sell", "T", "tradeSettlement", "internalTransfer", "fx",
  "dividend", "interest", "taxFee",
]);
const externalKinds = new Set(["externalDeposit", "externalWithdraw"]);

/**
 * Inspect the existing ledger without upgrading its records to the engine's
 * explicit `confirmed` inputs. This structural summary does not inspect opening
 * snapshots or reconcile the complete source evidence. Its unavailable status
 * means it cannot calculate the benchmark, not that historical records are absent.
 * Opening and completeness audit results can be established from existing data.
 * Manual principal entries remain bookkeeping facts.
 */
export function summarizeRecordedFunding(brokerImportLedger = {}) {
  const stats = {
    totalCount: 0, appliedExternalCount: 0, appliedDepositCount: 0,
    appliedWithdrawalCount: 0, candidateExternalCount: 0,
    evidenceExternalCount: 0, proposedExternalCount: 0,
    manualPrincipalCount: 0, manualDepositCount: 0, manualWithdrawalCount: 0,
    ignoredInternalCount: 0, ignoredRecordCount: 0,
    invalidCount: 0, unresolvedCount: 0, nonUsdExternalCount: 0,
    pendingKinds: {},
  };
  const pendingKinds = new Map();
  const issues = [];
  const missingInputs = [
    reason("dated-opening-capital-missing", "尚未将起点资本与已有投入记录核对；迁移本金基线不可直接替代期初资本"),
    reason("funding-completeness-unconfirmed", "本摘要尚未核对指定区间的外部资金时间线，不代表已有流水缺失"),
  ];
  const cashFlows = brokerImportLedger?.cashFlows;
  const invalid = (raw, code, message) => {
    stats.invalidCount += 1;
    increment(pendingKinds, text(raw?.kind) || "unknown");
    issues.push(reason(code, message, text(raw?.id) ? { flowId: text(raw.id) } : {}));
  };
  if (cashFlows !== undefined && (!cashFlows || typeof cashFlows !== "object" || Array.isArray(cashFlows))) {
    invalid(null, "invalid-cash-flow-map", "已登记现金流不是有效的 ID 对象映射");
  } else {
    for (const [recordId, raw] of Object.entries(cashFlows || {})) {
      stats.totalCount += 1;
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || !text(raw.id) || raw.id !== recordId) {
        invalid(raw, "invalid-record-id", "现金流记录身份不一致"); continue;
      }
      if (raw.status === "ignored") { stats.ignoredRecordCount += 1; continue; }
      if (!isDate(raw.flowDate) || !text(raw.account) || !Number.isSafeInteger(raw.amountMinor)
        || !Number.isSafeInteger(raw.principalDeltaCnyFen) || !["USD", "HKD", "CNY"].includes(raw.currency)
        || !["applied", "evidence", "proposed"].includes(raw.status)) {
        invalid(raw, "invalid-funding-record", "现金流记录缺少有效日期、账户、币种、整数金额或有效状态"); continue;
      }
      const kind = text(raw.kind);
      if (raw.sourceKind === "manual:cny-principal") {
        if (kind !== "manualCorrection" || raw.status !== "applied" || raw.broker !== "manual"
          || raw.currency !== "CNY" || raw.amountMinor === 0 || raw.amountMinor !== raw.principalDeltaCnyFen) {
          invalid(raw, "invalid-manual-principal", "手工本金记录与其记账口径不一致"); continue;
        }
        stats.manualPrincipalCount += 1;
        if (raw.amountMinor > 0) stats.manualDepositCount += 1;
        else stats.manualWithdrawalCount += 1;
        continue;
      }
      if (externalKinds.has(kind)) {
        if (raw.amountMinor === 0 || (kind === "externalDeposit" && raw.amountMinor < 0)
          || (kind === "externalWithdraw" && raw.amountMinor > 0)
          || (raw.principalDeltaCnyFen !== 0 && (raw.status !== "applied"
            || Math.sign(raw.principalDeltaCnyFen) !== Math.sign(raw.amountMinor)))) {
          invalid(raw, "funding-direction-inconsistent", "外部资金流金额或本金增量与入出金方向不一致"); continue;
        }
        if (raw.status === "applied") {
          stats.appliedExternalCount += 1;
          if (kind === "externalDeposit") stats.appliedDepositCount += 1;
          else stats.appliedWithdrawalCount += 1;
          if (raw.currency !== "USD") stats.nonUsdExternalCount += 1;
        } else {
          stats.candidateExternalCount += 1;
          if (raw.status === "evidence") stats.evidenceExternalCount += 1;
          else stats.proposedExternalCount += 1;
          increment(pendingKinds, kind);
        }
        continue;
      }
      const reconciliation = kind === "manualCorrection" && raw.sourceKind === "manual:cash-reconciliation";
      if (internalKinds.has(kind) || reconciliation) {
        if (raw.principalDeltaCnyFen !== 0) {
          invalid(raw, "internal-principal-conflict", "内部现金变动不应改变外部投入本金"); continue;
        }
        stats.ignoredInternalCount += 1;
      } else {
        stats.unresolvedCount += 1;
        increment(pendingKinds, kind || "unknown");
        issues.push(reason("funding-kind-unresolved", "尚未归类为外部或内部的资金记录", { flowId: raw.id }));
      }
    }
  }
  if (stats.candidateExternalCount) missingInputs.push(reason("external-candidates-unconfirmed", "仍有外部入出金候选尚未确认", { count: stats.candidateExternalCount }));
  if (stats.manualPrincipalCount) missingInputs.push(reason("manual-principal-dates-unverified", "手工本金记录使用记账日，需要核对实际入出金日期及美元换算", { count: stats.manualPrincipalCount }));
  if (stats.nonUsdExternalCount) missingInputs.push(reason("dated-usd-conversion-missing", "非美元外部资金流需要核对已有换汇记录或资金流当日的汇率依据", { count: stats.nonUsdExternalCount }));
  if (stats.invalidCount || stats.unresolvedCount) missingInputs.push(reason("funding-records-need-review", "存在无效或尚未归类的资金记录", { count: stats.invalidCount + stats.unresolvedCount }));
  stats.pendingKinds = Object.fromEntries(pendingKinds);
  return {
    status: "unavailable", stats, missingInputs, issues,
    note: "这里只统计已登记资金记录；尚未完成时间线核对，不能据此判断历史资料缺失。",
  };
}

function evidenceIssue(flow) {
  const evidence = flow.usdEvidence;
  if (!evidence || typeof evidence !== "object" || !text(evidence.source)) return "缺少美元金额或换算来源依据";
  if (evidence.kind === "user-confirmed") {
    return evidence.confirmed === true ? null : "美元金额尚未得到明确确认";
  }
  if (!Number.isSafeInteger(evidence.amountMinor)) return "原币金额必须是有符号的最小货币单位整数";
  let expected;
  if (evidence.kind === "native-usd") {
    if (evidence.currency !== "USD") return "美元原币依据的币种不一致";
    expected = evidence.amountMinor / 100;
  } else if (evidence.kind === "dated-fx") {
    if (!["CNY", "HKD"].includes(evidence.currency) || evidence.date !== flow.date
      || !isDate(evidence.date) || !isNumber(evidence.usdPerUnit) || evidence.usdPerUnit <= 0) {
      return "外币换算缺少资金流当日的有效美元汇率依据";
    }
    expected = evidence.amountMinor / 100 * evidence.usdPerUnit;
  } else return "不支持或未确认的美元换算依据";
  return isMoney(expected) && closeEnough(flow.amountUsd, expected) ? null : "美元金额与原币及换算依据不一致";
}

/**
 * flows: [{ id, date, kind: externalDeposit|externalWithdraw,
 *           status: 'confirmed', amountUsd: signed number, usdEvidence }]
 * usdEvidence must include source and one of:
 *   { kind:'native-usd', currency:'USD', amountMinor:signed integer }
 *   { kind:'dated-fx', currency:'CNY'|'HKD', amountMinor:signed integer,
 *     date:flow.date, usdPerUnit:positive number }
 *   { kind:'user-confirmed', confirmed:true }
 * Internal events are counted but never fund QQQ. Unknown/unconfirmed events
 * in the requested period block the result; outside-period flows are reported.
 */
export function assessFundingCoverage({
  startDate, throughDate, initialUsd, openingConfirmed = false,
  fundingComplete = false, flows = [],
} = {}) {
  const reasons = [];
  const validWindow = isDate(startDate) && isDate(throughDate) && startDate <= throughDate;
  if (!validWindow) reasons.push(reason("invalid-period", "需要有效且顺序正确的固定起始日期和截止日期"));
  if (openingConfirmed !== true) reasons.push(reason("opening-unconfirmed", "期初资本尚未明确确认"));
  if (!isMoney(initialUsd) || initialUsd < 0) reasons.push(reason("initial-capital-unavailable", "缺少有效的期初美元资本；不能用迁移基线或当前本金代替"));
  if (fundingComplete !== true) reasons.push(reason("funding-incomplete", "指定区间的外部入出金记录尚未确认完整"));
  const stats = {
    inputCount: Array.isArray(flows) ? flows.length : 0,
    confirmedExternalCount: 0, depositCount: 0, withdrawalCount: 0,
    depositUsd: 0, withdrawalUsd: 0, netExternalUsd: 0,
    ignoredInternalCount: 0, ignoredRecordCount: 0, beforeStartCount: 0,
    afterThroughCount: 0, pendingCount: 0, duplicateCount: 0, conflictingIdCount: 0,
    ignoredKinds: {}, pendingKinds: {}, usdEvidenceKinds: {},
  };
  const ignoredKinds = new Map();
  const pendingKinds = new Map();
  const evidenceKinds = new Map();
  const byId = new Map();
  const conflictingIds = new Set();
  const pending = (record, code, message) => {
    stats.pendingCount += 1;
    increment(pendingKinds, text(record?.kind) || "unknown");
    reasons.push(reason(code, message, {
      ...(text(record?.id) ? { flowId: text(record.id) } : {}),
      ...(isDate(record?.date) ? { date: record.date } : {}),
    }));
  };
  if (!Array.isArray(flows)) reasons.push(reason("invalid-flow-list", "外部资金流必须使用明确传入的记录列表"));
  // Check confirmed external IDs before trimming the requested period. A changed
  // date can otherwise count the same funding once in opening capital and again
  // inside the window. Conflicts wholly outside this window remain irrelevant.
  const globalIdentities = new Map();
  for (const raw of Array.isArray(flows) ? flows : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || raw.status !== "confirmed" || !externalKinds.has(text(raw.kind)) || !text(raw.id)) continue;
    const id = text(raw.id);
    const inWindow = validWindow && isDate(raw.date) && raw.date >= startDate && raw.date <= throughDate;
    const previous = globalIdentities.get(id);
    if (!previous) globalIdentities.set(id, { first: raw, conflict: false, inWindow: inWindow ? raw : null });
    else {
      if (previous.first.date !== raw.date || text(previous.first.kind) !== text(raw.kind)
        || previous.first.amountUsd !== raw.amountUsd) previous.conflict = true;
      if (inWindow) previous.inWindow = raw;
    }
  }
  for (const [id, identity] of globalIdentities) {
    if (identity.conflict && identity.inWindow) {
      conflictingIds.add(id); stats.conflictingIdCount += 1;
      pending(identity.inWindow, "flow-id-conflict", "同一资金流 ID 存在跨日期、方向或金额的矛盾事实，不能重复或任意选用");
    }
  }
  for (const raw of Array.isArray(flows) ? flows : []) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      pending(raw, "invalid-flow", "存在无法识别的资金流记录"); continue;
    }
    if (raw.status === "ignored") { stats.ignoredRecordCount += 1; continue; }
    const kind = text(raw.kind);
    if (internalKinds.has(kind) || (kind === "manualCorrection" && raw.sourceKind === "manual:cash-reconciliation")) {
      stats.ignoredInternalCount += 1; increment(ignoredKinds, kind); continue;
    }
    if (validWindow && isDate(raw.date) && raw.date < startDate) { stats.beforeStartCount += 1; continue; }
    if (validWindow && isDate(raw.date) && raw.date > throughDate) { stats.afterThroughCount += 1; continue; }
    if (!externalKinds.has(kind)) {
      pending(raw, "flow-kind-unresolved", "存在尚未确认是否属于外部资金流的记录"); continue;
    }
    const id = text(raw.id);
    if (conflictingIds.has(id)) continue;
    if (!id || !isDate(raw.date)) {
      pending(raw, "flow-identity-unavailable", "外部资金流缺少稳定 ID 或有效实际日期"); continue;
    }
    if (raw.status !== "confirmed") {
      pending(raw, "flow-unconfirmed", "外部资金流尚未确认；登记或证据状态不能自动升级"); continue;
    }
    if (!isMoney(raw.amountUsd) || raw.amountUsd === 0
      || (kind === "externalDeposit" && raw.amountUsd < 0)
      || (kind === "externalWithdraw" && raw.amountUsd > 0)) {
      pending(raw, "flow-amount-invalid", "外部资金流美元金额无效或与入出金方向不一致"); continue;
    }
    const issue = evidenceIssue(raw);
    if (issue) { pending(raw, "flow-usd-evidence-unavailable", issue); continue; }
    const flow = {
      id, date: raw.date, kind, amountUsd: raw.amountUsd,
      usdEvidenceKind: raw.usdEvidence.kind, usdSource: text(raw.usdEvidence.source),
    };
    const previous = byId.get(id);
    if (previous) {
      if (previous.date === flow.date && previous.kind === flow.kind && previous.amountUsd === flow.amountUsd) {
        stats.duplicateCount += 1;
      } else if (!conflictingIds.has(id)) {
        conflictingIds.add(id); stats.conflictingIdCount += 1;
        pending(raw, "flow-id-conflict", "同一资金流 ID 存在矛盾事实，不能重复或任意选用");
      }
    } else byId.set(id, flow);
  }
  const externalFlows = [...byId.values()].filter((flow) => !conflictingIds.has(flow.id))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  for (const flow of externalFlows) {
    stats.confirmedExternalCount += 1;
    if (flow.amountUsd > 0) { stats.depositCount += 1; stats.depositUsd += flow.amountUsd; }
    else { stats.withdrawalCount += 1; stats.withdrawalUsd -= flow.amountUsd; }
    increment(evidenceKinds, flow.usdEvidenceKind);
  }
  stats.netExternalUsd = stats.depositUsd - stats.withdrawalUsd;
  stats.ignoredKinds = Object.fromEntries(ignoredKinds);
  stats.pendingKinds = Object.fromEntries(pendingKinds);
  stats.usdEvidenceKinds = Object.fromEntries(evidenceKinds);
  return { status: reasons.length ? "unavailable" : "available", reasons, externalFlows, flowStats: stats };
}

function quoteMap(closes) {
  const values = new Map();
  const conflicts = new Set();
  const records = closes instanceof Map ? [...closes.entries()]
    : Array.isArray(closes) ? closes.map((item) => Array.isArray(item) ? item
      : [item?.date, item?.close ?? item?.price]) : [];
  for (const [date, price] of records) {
    if (!isDate(date)) continue;
    if (values.has(date) && values.get(date) !== price) conflicts.add(date);
    else values.set(date, price);
  }
  return { values, conflicts };
}

function nextSession(sessions, date) {
  let low = 0;
  let high = sessions.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (sessions[mid] < date) low = mid + 1;
    else high = mid;
  }
  return sessions[low] || null;
}

/**
 * Full replay always starts at startDate, then rangeStart/rangeEnd only slice the
 * finished points. marketSessions is an authoritative array/Set of session dates,
 * with calendarCoverage {startDate,endDate,confirmed:true} covering the requested
 * period. A quote is mandatory for EVERY included session; a missing quote never
 * becomes a holiday or causes a flow to move to another session.
 *
 * Cash moves at the corresponding session close; closed-day flows move to the
 * next known session. Same-session flows are netted at that close. Adjusted-price
 * balances use equivalent units, not actual brokerage shares. `close` must be a
 * split-consistent price series; raw closes across a split are not valid input.
 * No tax/fee model.
 */
export function buildCashFlowMatchedBenchmark(input = {}) {
  const {
    startDate, throughDate, initialUsd, marketSessions, calendarCoverage,
    closes, priceBasis, rangeStart, rangeEnd,
  } = input;
  const coverage = assessFundingCoverage(input);
  const reasons = [...coverage.reasons];
  const unitLabel = priceBasis === "adjusted" ? "等效单位" : "模拟价格单位";
  const base = {
    status: "unavailable", reasons, startDate, throughDate,
    priceBasis, unitLabel, points: [], summary: null, scheduledFlows: [],
    replayPointCount: 0, visibleRange: { startDate: rangeStart || startDate, endDate: rangeEnd || throughDate },
    flowStats: { ...coverage.flowStats, deferredCount: 0, executedExternalCount: 0 },
    method: {
      execution: "session-close", closedDayPolicy: "next-market-session",
      sameSessionFlows: "net-at-close", feesAndTaxes: "not-modeled",
      splits: "must-be-embedded-in-price-series",
      dividends: priceBasis === "adjusted" ? "included-in-adjusted-price" : "not-included",
    },
  };
  if (!["adjusted", "close"].includes(priceBasis)) reasons.push(reason("price-basis-unavailable", "需要明确 QQQ 序列是复权价格还是不含分红的收盘价格"));
  if (!calendarCoverage || calendarCoverage.confirmed !== true
    || !isDate(calendarCoverage.startDate) || !isDate(calendarCoverage.endDate)
    || !isDate(startDate) || !isDate(throughDate)
    || calendarCoverage.startDate > startDate || calendarCoverage.endDate < throughDate) {
    reasons.push(reason("calendar-coverage-unavailable", "缺少覆盖整个区间的已确认市场交易日历，不能把缺价当休市"));
  }
  const sessionList = Array.isArray(marketSessions) ? marketSessions
    : marketSessions instanceof Set ? [...marketSessions] : null;
  if (!sessionList || sessionList.some((date) => !isDate(date))) reasons.push(reason("market-sessions-unavailable", "市场交易日列表缺失或含无效日期"));
  const sessions = [...new Set((sessionList || []).filter(isDate))].sort();
  const replaySessions = sessions.filter((date) => date >= startDate && date <= throughDate);
  if (!replaySessions.length) reasons.push(reason("no-market-session", "指定区间内没有可执行期初买入的已确认交易日"));
  if ((rangeStart !== undefined && !isDate(rangeStart)) || (rangeEnd !== undefined && !isDate(rangeEnd))
    || (isDate(rangeStart) && isDate(rangeEnd) && rangeStart > rangeEnd)) {
    reasons.push(reason("invalid-visible-range", "展示日期范围无效"));
  }
  const quotes = quoteMap(closes);
  for (const date of replaySessions) {
    if (quotes.conflicts.has(date)) reasons.push(reason("quote-conflict", "同一交易日存在矛盾的 QQQ 价格", { date }));
    else if (!isNumber(quotes.values.get(date)) || quotes.values.get(date) <= 0) {
      reasons.push(reason("quote-unavailable", "已确认交易日缺少有效 QQQ 价格；不能顺延绕过缺价", { date }));
    }
  }
  const flowByExecutionDate = new Map();
  for (const flow of coverage.externalFlows) {
    const executionDate = nextSession(sessions, flow.date);
    if (!executionDate || executionDate > throughDate) {
      reasons.push(reason("flow-awaiting-session", "区间内有外部资金流尚未到下一个可执行交易日", { flowId: flow.id, date: flow.date, executionDate }));
      continue;
    }
    if (executionDate !== flow.date) base.flowStats.deferredCount += 1;
    const scheduled = { ...flow, executionDate, deferred: executionDate !== flow.date };
    base.scheduledFlows.push(scheduled);
    if (!flowByExecutionDate.has(executionDate)) flowByExecutionDate.set(executionDate, []);
    flowByExecutionDate.get(executionDate).push(scheduled);
  }
  if (reasons.length) return base;
  let units = 0;
  let netContributionsUsd = initialUsd;
  let netExternalUsd = 0;
  const allPoints = [];
  const initialExecutionDate = replaySessions[0];
  for (const date of replaySessions) {
    const price = quotes.values.get(date);
    if (date === initialExecutionDate) units = initialUsd / price;
    const flows = flowByExecutionDate.get(date) || [];
    const depositUsd = flows.reduce((sum, flow) => sum + Math.max(flow.amountUsd, 0), 0);
    const withdrawalUsd = flows.reduce((sum, flow) => sum + Math.max(-flow.amountUsd, 0), 0);
    const existingEquity = date === initialExecutionDate ? initialUsd : units * price;
    const availableUsd = existingEquity + depositUsd;
    const remainingEquity = availableUsd - withdrawalUsd;
    if (remainingEquity < -1e-8) {
      return {
        ...base, status: "invalid", reasons: [reason("insufficient-benchmark-balance", "相同出金要求超过 QQQ 对照账户可用权益，不能虚构负份额或借款", { date, availableUsd, withdrawalUsd })],
      };
    }
    const externalFlowUsd = depositUsd - withdrawalUsd;
    const equityUsd = Math.max(0, remainingEquity);
    if (depositUsd || withdrawalUsd) units = equityUsd / price;
    netExternalUsd += externalFlowUsd;
    netContributionsUsd = initialUsd + netExternalUsd;
    const profitUsd = equityUsd - netContributionsUsd;
    if (![units, equityUsd, netContributionsUsd, profitUsd].every(Number.isFinite)
      || units < 0 || equityUsd < 0 || (equityUsd > 0 && units === 0)) {
      return { ...base, status: "invalid", reasons: [reason("numeric-overflow", "金额或价格超出可安全计算的范围", { date })] };
    }
    allPoints.push({
      date, price, units, equityUsd, netContributionsUsd, profitUsd,
      externalFlowUsd, depositUsd, withdrawalUsd,
      executionFlowIds: flows.map((flow) => flow.id),
    });
  }
  const final = allPoints.at(-1);
  return {
    ...base, status: "available", reasons: [], initialExecutionDate,
    points: allPoints.filter((point) => point.date >= base.visibleRange.startDate && point.date <= base.visibleRange.endDate),
    replayPointCount: allPoints.length,
    flowStats: { ...base.flowStats, executedExternalCount: coverage.externalFlows.length },
    summary: {
      startDate, initialExecutionDate, asOfDate: final.date, initialUsd,
      equityUsd: final.equityUsd, netContributionsUsd: final.netContributionsUsd,
      profitUsd: final.profitUsd, units: final.units,
      netExternalUsd, depositUsd: coverage.flowStats.depositUsd,
      withdrawalUsd: coverage.flowStats.withdrawalUsd,
    },
  };
}
