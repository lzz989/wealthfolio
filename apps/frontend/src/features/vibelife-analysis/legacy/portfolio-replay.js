/** Read-only native-currency holdings/cash replay. It never infers deposits from principal. */
import { classifyImportedTrade, operationIdentityParts } from "./operation-history.js?v=a33f660010";

const list = (value) => Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [];
const number = (value) => (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isFinite(Number(value)) ? Number(value) : null;
const integer = (value) => { const n = number(value); return Number.isSafeInteger(n) ? n : null; };
const text = (value) => typeof value === "string" ? value.trim() : "";
const isoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value || "") && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const isCash = (row) => row?.type === "cash" || ["现金", "CASH"].includes(text(row?.asset).toUpperCase());
const cashKey = (account, currency) => `cash|${account}|${currency}`;
const positionKey = (account, instrumentId, currency) => `position|${account}|${instrumentId}|${currency}`;
const issue = (code, details = {}) => ({ code, ...details });
const cloneState = (state) => new Map([...state].map(([key, value]) => [key, { ...value, row: { ...value.row } }]));
const rowsFromState = (state) => [...state.values()].map((entry) => ({ ...entry.row, quantity: entry.units / (entry.scale || (entry.cash ? 100 : 1e8)), ...(entry.basis === "legacy-amount" ? { replayQuantityBasis: "legacy-amount" } : {}) }));

function readState(rows, date, sourceId = date) {
  const state = new Map();
  const issues = [];
  if (!Array.isArray(rows) || !rows.length) return { state, issues: [issue("checkpoint-rows-unavailable", { date, sourceId })] };
  rows.forEach((row, index) => {
    const currency = text(row?.currency).toUpperCase();
    const quantity = number(row?.quantity);
    if (!text(row?.account) || !/^[A-Z]{3}$/.test(currency) || quantity === null || quantity < 0) {
      issues.push(issue("checkpoint-row-invalid", { date, sourceId, index })); return;
    }
    const identity = operationIdentityParts({ ...row, currency });
    const cash = isCash(row);
    if (!cash && !identity.instrumentId) {
      issues.push(issue("checkpoint-instrument-missing", { date, sourceId, index })); return;
    }
    const legacyAmount = !cash && identity.account === "支付宝基金" && !(number(row.marketPrice) > 0)
      && !text(row.navSource).startsWith("东方财富");
    const scale = cash || legacyAmount ? 100 : 1e8;
    const units = Math.round(quantity * scale);
    if (!Number.isSafeInteger(units)) { issues.push(issue("checkpoint-quantity-invalid", { date, sourceId, index })); return; }
    const key = cash ? cashKey(identity.account, currency) : positionKey(identity.account, identity.instrumentId, currency);
    if (state.has(key)) { issues.push(issue("checkpoint-duplicate-row", { date, sourceId, key })); return; }
    state.set(key, { key, cash, units, scale, basis: legacyAmount ? "legacy-amount" : cash ? "cash" : "shares", ...identity,
      row: { ...row, account: identity.account, currency } });
  });
  return { state, issues };
}

function compareStateMaps(actual, expected, date, tolerance = 1) {
  const differences = [];
  for (const key of new Set([...actual.keys(), ...expected.keys()])) {
    const a = actual.get(key), e = expected.get(key), entry = a || e;
    const predictedUnits = a?.units ?? 0, recordedUnits = e?.units ?? 0;
    const delta = recordedUnits - predictedUnits;
    const common = { key, account: entry.account, currency: entry.currency, instrumentId: entry.cash ? "cash" : entry.instrumentId,
      kind: entry.cash ? "cash" : "position" };
    if (a?.basis === "legacy-amount" || e?.basis === "legacy-amount") {
      differences.push({ ...common, kind: "basis", predicted: null, recorded: null, difference: null,
        reason: "legacy-fund-amount-basis", predictedBasis: a?.basis || "absent", recordedBasis: e?.basis || "absent" });
    } else if (entry.cash && a?.cashKnown === false) {
      differences.push({ ...common, predicted: null, recorded: recordedUnits / 100, difference: null, differenceMinor: null,
        reason: "cash-amount-unavailable" });
    } else if (Math.abs(delta) > (entry.cash ? tolerance : 0)) differences.push({
      ...common, predicted: predictedUnits / (entry.cash ? 100 : 1e8),
      recorded: recordedUnits / (entry.cash ? 100 : 1e8), difference: delta / (entry.cash ? 100 : 1e8),
      ...(entry.cash ? { differenceMinor: delta } : { differenceUnits: delta }),
    });
  }
  return differences;
}

/** Exact quantity differences and cash differences in native cents; prices/costs are not holdings. */
export function comparePortfolioStates(actualRows, expectedRows, { date = "", cashToleranceMinor = 1 } = {}) {
  const actual = readState(actualRows, date, "replay");
  const expected = readState(expectedRows, date, "recorded");
  const tolerance = Number.isSafeInteger(cashToleranceMinor) && cashToleranceMinor >= 0 ? cashToleranceMinor : 1;
  const differences = compareStateMaps(actual.state, expected.state, date, tolerance);
  const issues = [...actual.issues, ...expected.issues];
  return { ok: !issues.length && !differences.length, differences, issues };
}

function tradeEvent(raw) {
  const trade = classifyImportedTrade(raw);
  const date = text(raw?.tradeDate), id = text(raw?.id);
  const currency = text(raw?.priceCurrency || raw?.currency).toUpperCase();
  const units = integer(raw?.quantityUnits ?? raw?.qty1e8);
  const gross = integer(raw?.grossMinor), fee = integer(raw?.feeMinor), cash = integer(raw?.netCashMinor);
  if (!id || !isoDate(date) || !text(raw?.account) || !/^[A-Z]{3}$/.test(currency) || trade.role !== "canonical"
    || trade.accuracy !== "exact" || units === null || units <= 0 || gross === null || gross <= 0 || fee === null || fee < 0 || cash === null
    || number(trade.unitPrice) === null || trade.unitPrice <= 0) {
    return { error: issue("trade-incomplete", { date, id, account: trade.account }) };
  }
  const signedCash = trade.side === "buy" ? -gross - fee : gross - fee;
  const cashConflict = cash !== signedCash || Math.abs(Math.round(units / 1e8 * trade.unitPrice * 100) - gross) > 1;
  const warnings = [];
  if (cashConflict) warnings.push(issue("trade-cash-conflict", { date, id, account: trade.account,
    recordedNetCashMinor: cash, grossMinor: gross, feeMinor: fee, arithmeticNetCashMinor: signedCash }));
  else if (raw.feeAccuracy === "estimated") warnings.push(issue("trade-cash-estimated", { date, id, account: trade.account }));
  return { date, id, type: "trade", account: trade.account, currency, instrumentId: trade.instrumentId,
    quantityUnits: trade.side === "buy" ? units : -units, cashMinor: cashConflict ? null : cash, trade, raw, warnings };
}

function collectEvents(ledger, startDate, throughDate) {
  const events = [], issues = [], ignored = [];
  const trades = new Map();
  const flows = new Map();
  const ids = new Map();
  const conflicts = new Set();
  function unique(raw, type) {
    const id = text(raw?.id);
    if (!id) return true; // Validation supplies a record-specific missing-ID issue.
    const key = `${type}|${id}`;
    const signature = JSON.stringify(raw);
    if (ids.has(key)) {
      if (ids.get(key) !== signature) { conflicts.add(key); issues.push(issue("record-id-conflict", { id, type })); }
      return false;
    }
    ids.set(key, signature); return true;
  }
  for (const raw of list(ledger?.trades)) {
    if (!unique(raw, "trade") || raw?.status === "ignored") continue;
    const date = text(raw?.tradeDate);
    if (!isoDate(date)) { issues.push(issue("trade-date-invalid", { id: text(raw?.id) })); continue; }
    if (date <= startDate || date > throughDate) continue;
    if (!["accepted", "applied"].includes(raw?.status)) {
      issues.push(issue("trade-not-confirmed", { date, id: text(raw?.id), status: raw?.status })); continue;
    }
    const event = tradeEvent(raw);
    if (event.error) { issues.push(event.error); continue; }
    issues.push(...event.warnings);
    trades.set(event.id, event); events.push(event);
  }
  for (const raw of list(ledger?.cashFlows)) {
    if (!unique(raw, "flow") || raw?.status === "ignored") continue;
    const date = text(raw?.flowDate), id = text(raw?.id);
    if (!isoDate(date)) { issues.push(issue("cash-flow-date-invalid", { id })); continue; }
    if (date <= startDate || date > throughDate) continue;
    if (raw.sourceKind === "manual:cny-principal") { ignored.push({ id, date, reason: "principal-bookkeeping-only" }); continue; }
    if (raw?.status !== "applied") {
      issues.push(issue("cash-flow-not-confirmed", { date, id, kind: raw?.kind, status: raw?.status })); continue;
    }
    const currency = text(raw?.currency).toUpperCase(), amount = integer(raw?.amountMinor);
    const identity = operationIdentityParts({ account: raw?.account, currency, asset: "CASH" });
    if (!id || !text(raw?.account) || !/^[A-Z]{3}$/.test(currency) || amount === null) {
      issues.push(issue("cash-flow-invalid", { date, id })); continue;
    }
    const event = { date, id, type: "cash", account: identity.account, currency, cashMinor: amount, kind: raw.kind, raw };
    flows.set(id, event);
  }
  for (const flow of flows.values()) {
    if (flow.raw.sourceKind === "manual:cash-reconciliation") {
      // A balance observation cannot explain its own unexplained movement.
      const actual = integer(flow.raw.actualBalanceMinor), book = integer(flow.raw.bookBalanceMinor);
      if (actual === null || book === null || actual - book !== flow.cashMinor || flow.raw.checkpointMode !== "eod") {
        issues.push(issue("cash-checkpoint-incomplete", { date: flow.date, id: flow.id })); continue;
      }
      events.push({ ...flow, type: "cash-observation", actualMinor: actual, bookMinor: book });
      continue;
    }
    if (flow.kind === "tradeSettlement") {
      const trade = trades.get(text(flow.raw.pairedFlowId));
      if (trade && trade.account === flow.account && trade.currency === flow.currency && trade.cashMinor === flow.cashMinor) {
        ignored.push({ id: flow.id, date: flow.date, reason: "already-in-trade-net-cash" });
      } else issues.push(issue("settlement-not-linked", { date: flow.date, id: flow.id }));
      continue;
    }
    if (["internalTransfer", "fx"].includes(flow.kind)) {
      const pair = flows.get(text(flow.raw.pairedFlowId));
      const valid = pair && pair.kind === flow.kind && text(pair.raw.pairedFlowId) === flow.id
        && pair.date === flow.date && pair.cashMinor * flow.cashMinor < 0
        && (flow.kind === "fx" ? pair.account === flow.account && pair.currency !== flow.currency
          : pair.currency === flow.currency && pair.account !== flow.account && pair.cashMinor === -flow.cashMinor);
      if (!valid) { issues.push(issue("transfer-pair-unresolved", { date: flow.date, id: flow.id, kind: flow.kind })); continue; }
    } else if (!["externalDeposit", "externalWithdraw", "dividend", "interest", "taxFee"].includes(flow.kind)) {
      issues.push(issue("cash-flow-kind-unresolved", { date: flow.date, id: flow.id, kind: flow.kind })); continue;
    }
    if (flow.kind === "externalDeposit" && flow.cashMinor <= 0 || flow.kind === "externalWithdraw" && flow.cashMinor >= 0) {
      issues.push(issue("cash-flow-direction-conflict", { date: flow.date, id: flow.id })); continue;
    }
    if (flow.kind === "taxFee" && text(flow.raw.pairedFlowId) && trades.has(text(flow.raw.pairedFlowId))) {
      const trade = trades.get(text(flow.raw.pairedFlowId));
      if (trade.account === flow.account && trade.currency === flow.currency && flow.cashMinor === -Number(trade.raw.feeMinor)) {
        ignored.push({ id: flow.id, date: flow.date, reason: "already-in-trade-net-cash" }); continue;
      }
      issues.push(issue("trade-fee-conflict", { date: flow.date, id: flow.id })); continue;
    }
    events.push(flow);
  }
  return { events: events.filter((event) => !conflicts.has(`${event.type === "trade" ? "trade" : "flow"}|${event.id}`)), issues, ignored };
}

function applyDay(state, events, metadata) {
  const next = cloneState(state), issues = [];
  const deltas = new Map();
  for (const event of events.filter((event) => event.type !== "cash-observation")) {
    const key = cashKey(event.account, event.currency);
    if (!next.has(key)) next.set(key, { key, cash: true, units: 0, account: event.account, currency: event.currency,
      row: { account: event.account, currency: event.currency, asset: "现金", type: "cash", quantity: 0, costPrice: "", marketPrice: "", riskMultiplier: 0 } });
    if (event.cashMinor === null) next.get(key).cashKnown = false;
    else deltas.set(key, (deltas.get(key) || 0) + event.cashMinor);
    if (event.type === "trade") {
      const pkey = positionKey(event.account, event.instrumentId, event.currency);
      if (!next.has(pkey)) {
        let template = metadata.get(pkey);
        if (!template && /^equity:[^|]+$/.test(event.instrumentId)) {
          const symbol = event.instrumentId.slice(7);
          // Identity metadata comes from the executed fill. No price, risk multiplier,
          // cost basis, opening quantity, or cash balance is invented.
          template = { key: pkey, cash: false, units: 0, scale: 1e8, basis: "shares", account: event.account,
            instrumentId: event.instrumentId, currency: event.currency, row: { account: event.account,
              asset: symbol, quoteSymbol: symbol, currency: event.currency, quantity: 0, type: "risk",
              costPrice: "", marketPrice: "", replayMetadataSource: "canonical-trade-identity" } };
        }
        if (!template) { issues.push(issue("position-metadata-missing", { date: event.date, id: event.id, key: pkey })); continue; }
        next.set(pkey, { ...template, units: 0, row: { ...template.row, quantity: 0 } });
      }
      if (next.get(pkey)?.basis === "legacy-amount") {
        issues.push(issue("legacy-fund-amount-basis", { date: event.date, id: event.id, key: pkey })); continue;
      }
      deltas.set(pkey, (deltas.get(pkey) || 0) + event.quantityUnits);
    }
  }
  for (const [key, delta] of deltas) {
    const entry = next.get(key);
    if (!entry) continue;
    const units = entry.units + delta;
    if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(units) || units < 0 && (!entry.cash || entry.cashKnown !== false)) {
      issues.push(issue(entry.cash ? "cash-balance-negative" : "position-balance-negative", { key, predictedUnits: units })); continue;
    }
    entry.units = units;
  }
  for (const event of events.filter((event) => event.type === "cash-observation")) {
    const predicted = next.get(cashKey(event.account, event.currency))?.units ?? 0;
    if (Math.abs(predicted - event.actualMinor) > 1) issues.push(issue("cash-observation-difference", {
      date: event.date, id: event.id, account: event.account, currency: event.currency,
      predictedMinor: predicted, recordedMinor: event.actualMinor, differenceMinor: event.actualMinor - predicted,
    }));
  }
  return { state: next, issues };
}

/**
 * Replay only facts already present in the canonical ledger. Reconciliation is against the
 * next recorded checkpoint; inferred/estimated snapshot rows are never an opening position.
 * dailyStates contains observed checkpoints and reconciled intermediate states only.
 * `reconciled` means recorded events explain checkpoint holdings/cash; it is not a claim
 * that broker source coverage has independently been proved complete.
 */
export function buildPortfolioReplay({ history = {}, brokerImportLedger = {}, dcaSyncLedger = {},
  startDate = "2026-03-20", throughDate, valuationDates = [], currentCheckpoint = null } = {}) {
  const output = { status: "unavailable", startDate, throughDate, dailyStates: [], candidateStates: [], checkpoints: [], issues: [], dateWarnings: [], basisWarnings: [], externalFlows: [],
    ignoredRecords: [], counts: { recordedSnapshots: 0, estimatedSnapshotsExcluded: 0, trades: 0, cashFlows: 0, reconciledSegments: 0, failedSegments: 0 },
    coverage: { firstRecordedDate: null, lastRecordedDate: null, startsAtRequestedDate: false, reconciledThrough: null } };
  if (!isoDate(startDate) || !isoDate(throughDate) || startDate > throughDate) {
    output.issues.push(issue("invalid-replay-range")); return output;
  }
  const supplied = [...list(history?.dailySnapshots), ...(currentCheckpoint ? [currentCheckpoint] : [])];
  const byDate = new Map(), conflictingDates = new Set(), metadata = new Map();
  for (const snapshot of supplied) {
    if (!isoDate(snapshot?.date) || snapshot.date > throughDate) continue;
    if (snapshot.estimated === true) { output.counts.estimatedSnapshotsExcluded++; continue; }
    // Keep absent legacy flags visible instead of upgrading them to an independently observed fact.
    if (snapshot.estimated !== false) { output.issues.push(issue("checkpoint-provenance-unspecified", { date: snapshot.date })); continue; }
    const parsed = readState(snapshot.rows, snapshot.date);
    if (parsed.issues.length) { output.issues.push(...parsed.issues); continue; }
    if (byDate.has(snapshot.date)) {
      const previous = byDate.get(snapshot.date);
      if (!comparePortfolioStates(rowsFromState(parsed.state), rowsFromState(previous.state), { date: snapshot.date }).ok) {
        conflictingDates.add(snapshot.date); output.issues.push(issue("checkpoint-same-date-conflict", { date: snapshot.date }));
      }
      continue;
    }
    const quoteDateMatch = text(snapshot.source).match(/截至\s*(\d{2})\/(\d{2})/);
    const quoteDate = quoteDateMatch ? `${snapshot.date.slice(0, 4)}-${quoteDateMatch[1]}-${quoteDateMatch[2]}` : null;
    const dateProvenance = { source: text(snapshot.source), capturedAt: text(snapshot.capturedAt),
      dateBasis: "recorded-bookkeeping-date", sourceQuoteDate: isoDate(quoteDate) ? quoteDate : null,
      recordedValuationDateMismatch: Boolean(isoDate(quoteDate) && quoteDate !== snapshot.date), holdingsDateConfirmed: false };
    if (dateProvenance.recordedValuationDateMismatch) output.dateWarnings.push(issue("recorded-valuation-date-mismatch", {
      date: snapshot.date, sourceQuoteDate: quoteDate, capturedAt: dateProvenance.capturedAt }));
    const basisWarnings = [...parsed.state.values()].filter((entry) => entry.basis === "legacy-amount")
      .map((entry) => issue("legacy-fund-amount-basis", { date: snapshot.date, key: entry.key, account: entry.account, instrumentId: entry.instrumentId, currency: entry.currency }));
    output.basisWarnings.push(...basisWarnings);
    const record = { date: snapshot.date, snapshot, state: parsed.state, dateProvenance, basisWarnings };
    byDate.set(snapshot.date, record);
    for (const [key, entry] of parsed.state) if (!entry.cash && entry.basis !== "legacy-amount") metadata.set(key, entry);
  }
  const checkpoints = [...byDate.values()].filter((item) => !conflictingDates.has(item.date)).sort((a, b) => a.date.localeCompare(b.date));
  output.counts.recordedSnapshots = checkpoints.length;
  output.coverage.firstRecordedDate = checkpoints[0]?.date || null;
  output.coverage.lastRecordedDate = checkpoints.at(-1)?.date || null;
  if (!checkpoints.length) { output.issues.push(issue("recorded-opening-unavailable", { date: startDate })); return output; }
  const openingIndex = checkpoints.findLastIndex((item) => item.date <= startDate);
  const firstIndex = openingIndex >= 0 ? openingIndex : 0;
  const usable = checkpoints.slice(firstIndex);
  const first = usable[0];
  output.coverage.startsAtRequestedDate = first.date <= startDate;
  if (first.date > startDate) output.issues.push(issue("opening-interval-unavailable", { startDate, nextRecordedDate: first.date }));
  const collected = collectEvents(brokerImportLedger, first.date, throughDate);
  output.issues.push(...collected.issues);
  output.ignoredRecords = collected.ignored;
  output.counts.trades = collected.events.filter((event) => event.type === "trade").length;
  output.counts.cashFlows = collected.events.filter((event) => event.type !== "trade").length;
  output.externalFlows = collected.events.filter((event) => ["externalDeposit", "externalWithdraw"].includes(event.kind))
    .map(({ id, date, kind, account, currency, cashMinor }) => ({ id, date, kind, account, currency, amountMinor: cashMinor }));
  const dcaRecords = list(dcaSyncLedger?.entries || dcaSyncLedger?.records || dcaSyncLedger);
  for (const record of dcaRecords) {
    const date = text(record?.executionDate || record?.confirmationDate || record?.date || record?.syncDate);
    if (isoDate(date) && date > first.date && date <= throughDate && record?.status !== "ignored") {
      // Plan/sync entries do not prove an actual dated subscription or its cash source.
      output.issues.push(issue("dca-execution-unresolved", { date, id: text(record?.id || record?.key) }));
    }
  }
  const dates = [...new Set(valuationDates.filter(isoDate))].filter((date) => date >= startDate && date <= throughDate).sort();
  const states = new Map();
  for (const checkpoint of usable) if (checkpoint.date >= startDate) states.set(checkpoint.date, {
    date: checkpoint.date, rows: rowsFromState(checkpoint.state), origin: "recorded-checkpoint", checkpointDate: checkpoint.date,
    eventIds: [], confidence: "recorded-date-unverified", basisWarnings: checkpoint.basisWarnings, ...checkpoint.dateProvenance });
  let continuous = output.coverage.startsAtRequestedDate;
  for (let i = 0; i < usable.length - 1; i++) {
    const source = usable[i], target = usable[i + 1];
    const localIssues = output.issues.filter((problem) => !problem.date && problem.code !== "opening-interval-unavailable"
      || problem.date > source.date && problem.date <= target.date);
    const events = collected.events.filter((event) => event.date > source.date && event.date <= target.date);
    const allDates = [...new Set([...dates.filter((date) => date > source.date && date <= target.date), ...events.map((event) => event.date), target.date])].sort();
    let state = cloneState(source.state);
    let calculationValid = true;
    const candidates = [];
    const eventIds = [];
    for (const date of allDates) {
      const day = events.filter((event) => event.date === date);
      const result = applyDay(state, day, metadata);
      result.issues.forEach((problem) => localIssues.push({ date, ...problem }));
      if (result.issues.some((problem) => ["cash-balance-negative", "position-balance-negative", "position-metadata-missing"].includes(problem.code))) calculationValid = false;
      state = result.state;
      eventIds.push(...day.map((event) => event.id));
      if (dates.includes(date) && date < target.date) candidates.push({ date, rows: rowsFromState(state),
        origin: "reconciled-transactions", checkpointDate: source.date, reconciledToDate: target.date, eventIds: [...eventIds],
        confidence: "checkpoint-reconciled", source: source.dateProvenance.source, capturedAt: source.dateProvenance.capturedAt,
        dateBasis: "recorded-bookkeeping-date", holdingsDateConfirmed: false,
        sourceQuoteDate: source.dateProvenance.sourceQuoteDate,
        recordedValuationDateMismatch: source.dateProvenance.recordedValuationDateMismatch,
        calculationValid, cashKnown: [...state.values()].filter((entry) => entry.cash).every((entry) => entry.cashKnown !== false),
        netExternalByCurrency: Object.fromEntries([...new Set(day.filter((event) => ["externalDeposit", "externalWithdraw"].includes(event.kind)).map((event) => event.currency))]
          .map((currency) => [currency, day.filter((event) => event.currency === currency && ["externalDeposit", "externalWithdraw"].includes(event.kind)).reduce((sum, event) => sum + event.cashMinor, 0)])) });
    }
    const differences = compareStateMaps(state, target.state, target.date);
    const comparison = { ok: !differences.length, differences, issues: [] };
    // One unknown cash date in an account/currency can be checked against both native
    // balance observations. Multiple unknown dates cannot be apportioned from an endpoint.
    const cashDerivations = [];
    const resolvedEstimatedIds = new Set();
    const estimatedGroups = new Map();
    for (const event of events.filter((event) => event.warnings?.some((problem) => problem.code === "trade-cash-estimated"))) {
      const key = cashKey(event.account, event.currency);
      if (!estimatedGroups.has(key)) estimatedGroups.set(key, []);
      estimatedGroups.get(key).push(event);
    }
    if (comparison.ok && localIssues.every((problem) => problem.code === "trade-cash-estimated")) {
      for (const [key, group] of estimatedGroups) {
        if (new Set(group.map((event) => event.date)).size !== 1) continue;
        const sourceCash = source.state.get(key)?.units ?? 0, targetCash = target.state.get(key)?.units ?? 0;
        const otherCash = events.filter((event) => cashKey(event.account, event.currency) === key && event.type !== "cash-observation"
          && !group.some((estimated) => estimated.id === event.id)).reduce((sum, event) => sum + event.cashMinor, 0);
        const observed = targetCash - sourceCash - otherCash;
        const estimated = group.reduce((sum, event) => sum + event.cashMinor, 0);
        if (observed !== estimated) continue; // Derivation does not silently fix even a one-cent difference.
        group.forEach((event) => resolvedEstimatedIds.add(event.id));
        cashDerivations.push({ account: group[0].account, currency: group[0].currency, date: group[0].date,
          eventIds: group.map((event) => event.id), netCashMinor: observed, from: source.date, to: target.date,
          method: "one-cash-date-reconciled-to-recorded-balances" });
      }
    }
    const blockingIssues = localIssues.filter((problem) => !(problem.code === "trade-cash-estimated" && resolvedEstimatedIds.has(problem.id)));
    const ok = !blockingIssues.length && comparison.ok;
    const proof = { from: source.date, to: target.date, ok, cashDerivations,
      holdingsMatch: !comparison.differences.some((difference) => ["position", "basis"].includes(difference.kind))
        && !localIssues.some((problem) => ["position-balance-negative", "position-metadata-missing", "trade-incomplete", "trade-not-confirmed", "legacy-fund-amount-basis"].includes(problem.code)),
      cashMatch: !comparison.differences.some((difference) => difference.kind === "cash")
        && !localIssues.some((problem) => ["cash-balance-negative", "cash-observation-difference"].includes(problem.code)),
      cashAccuracy: localIssues.some((problem) => ["trade-cash-conflict", "cash-flow-not-confirmed", "cash-flow-kind-unresolved", "cash-flow-invalid"].includes(problem.code))
        ? "unavailable" : blockingIssues.some((problem) => problem.code === "trade-cash-estimated") ? "estimated"
          : resolvedEstimatedIds.size ? "checkpoint-reconciled" : "exact",
      eventIds, differences: comparison.differences, issues: [...localIssues, ...comparison.issues] };
    output.checkpoints.push(proof);
    const intervalAudit = { from: source.date, to: target.date, ok, holdingsMatch: proof.holdingsMatch, cashMatch: proof.cashMatch,
      cashAccuracy: proof.cashAccuracy, cashDerivations };
    const targetPoint = states.get(target.date);
    if (targetPoint) { targetPoint.intervalAudit = intervalAudit; if (ok) targetPoint.reconciledFromDate = source.date; }
    if (ok) { output.counts.reconciledSegments++; for (const candidate of candidates) states.set(candidate.date, { ...candidate, intervalAudit }); }
    else {
      output.counts.failedSegments++; continuous = false;
      for (const candidate of candidates.filter((point) => point.cashKnown && point.calculationValid)) output.candidateStates.push({ ...candidate,
        origin: "unreconciled-transactions", confidence: "unreconciled", intervalAudit });
    }
    if (continuous) output.coverage.reconciledThrough = target.date;
  }
  if (usable.at(-1).date < throughDate) output.issues.push(issue("closing-checkpoint-unavailable", { date: throughDate, lastRecordedDate: usable.at(-1).date }));
  output.dailyStates = [...states.values()].filter((item) => item.date >= startDate && item.date <= throughDate).sort((a, b) => a.date.localeCompare(b.date));
  const ready = output.coverage.startsAtRequestedDate && usable.at(-1).date === throughDate
    && !output.basisWarnings.some((problem) => problem.date >= startDate && problem.date <= throughDate)
    && output.counts.failedSegments === 0 && output.issues.every((problem) => problem.code === "trade-cash-estimated"
      && output.checkpoints.some((checkpoint) => checkpoint.ok && checkpoint.eventIds.includes(problem.id)));
  output.status = ready ? "reconciled" : output.dailyStates.length ? "partial" : "unavailable";
  return output;
}

/**
 * Display-only continuation after the latest recorded checkpoint. Absence of a new
 * ledger event is an explicit coverage assumption, never proof of no real activity.
 * Reuse the canonical event parser; strict replay and stored checkpoints are untouched.
 */
export function buildReferencePortfolioTail({ replay, brokerImportLedger = {}, dcaSyncLedger = {},
  throughDate, valuationDates = [] } = {}) {
  const basisDate = replay?.coverage?.lastRecordedDate || null;
  const output = { basisDate, throughDate, lastDate: basisDate, dailyStates: [], externalFlows: [], issues: [], blockedAt: null };
  if (!isoDate(basisDate) || !isoDate(throughDate) || throughDate <= basisDate) return output;
  const sessions = [...new Set(valuationDates.filter(isoDate))].filter((date) => date > basisDate && date <= throughDate).sort();
  const firstSession = sessions[0] || throughDate;
  const basis = (replay.dailyStates || []).find((state) => state.date === basisDate && state.origin === "recorded-checkpoint");
  if (!basis || basis.recordedValuationDateMismatch && basis.sourceQuoteDate > basisDate) {
    output.issues.push(issue("reference-tail-basis-unavailable", { date: firstSession }));
    output.blockedAt = firstSession; return output;
  }
  const parsed = readState(basis.rows, basisDate);
  if (parsed.issues.length) {
    output.issues.push(...parsed.issues); output.blockedAt = firstSession; return output;
  }
  const collected = collectEvents(brokerImportLedger, basisDate, throughDate);
  output.issues.push(...collected.issues);
  // Principal-only annotations and DCA sync dates cannot establish actual dated cash/shares.
  for (const raw of list(brokerImportLedger.cashFlows)) {
    if (raw?.status !== "ignored" && raw?.sourceKind === "manual:cny-principal"
      && raw.flowDate > basisDate && raw.flowDate <= throughDate) {
      output.issues.push(issue("reference-principal-flow-unresolved", { date: raw.flowDate, id: text(raw.id) }));
    }
  }
  for (const raw of list(dcaSyncLedger.entries || dcaSyncLedger.records || dcaSyncLedger)) {
    const date = text(raw?.executionDate || raw?.confirmationDate || raw?.date || raw?.syncDate);
    if (raw?.status !== "ignored" && isoDate(date) && date > basisDate && date <= throughDate) {
      output.issues.push(issue("dca-execution-unresolved", { date, id: text(raw.id || raw.key) }));
    }
  }
  const blocking = () => output.issues.filter((problem) => problem.code !== "trade-cash-estimated");
  const dates = [...new Set([...sessions, ...collected.events.map((event) => event.date),
    ...blocking().map((problem) => isoDate(problem.date) ? problem.date : firstSession)])]
    .filter((date) => date > basisDate && date <= throughDate).sort();
  const metadata = new Map([...parsed.state].filter(([, entry]) => !entry.cash && entry.basis !== "legacy-amount"));
  let state = parsed.state;
  for (const date of dates) {
    if (blocking().some((problem) => !isoDate(problem.date) || problem.date <= date)) {
      output.blockedAt = date; break;
    }
    const result = applyDay(state, collected.events.filter((event) => event.date === date), metadata);
    if (result.issues.length || [...result.state.values()].some((entry) => entry.cash && entry.cashKnown === false)) {
      output.issues.push(...result.issues.map((problem) => ({ ...problem, date })));
      if (!result.issues.length) output.issues.push(issue("reference-tail-cash-unavailable", { date }));
      output.blockedAt = date; break;
    }
    state = result.state;
    if (sessions.includes(date)) {
      output.dailyStates.push({ date, rows: rowsFromState(state), origin: "reference-carried-holdings",
        checkpointDate: basisDate, referenceBasisDate: basisDate, referenceTail: true,
        confidence: "registered-events-only", source: basis.source, capturedAt: basis.capturedAt,
        intervalAudit: { from: basisDate, to: throughDate, ok: true, reference: true } });
      output.lastDate = date;
    }
  }
  output.externalFlows = collected.events.filter((event) => ["externalDeposit", "externalWithdraw"].includes(event.kind)
    && (!output.blockedAt || event.date < output.blockedAt))
    .map(({ id, date, kind, account, currency, cashMinor }) => ({ id, date, kind, account, currency, amountMinor: cashMinor }));
  return output;
}
