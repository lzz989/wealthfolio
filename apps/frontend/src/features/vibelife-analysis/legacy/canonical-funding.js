/**
 * Project the canonical funding ledger into the cash-matched benchmark contract.
 * This is a read-only adapter: principal balances, DCA cost, and estimated
 * snapshots are never promoted to dated external funding. A replay audit may
 * supply opening/completeness evidence derived from the SAME canonical payload.
 */
const object = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value) => typeof value === "string" ? value.trim() : "";
const number = (value) => typeof value === "number" && Number.isFinite(value);
const money = (value) => number(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER / 100;
const date = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const currencies = new Set(["USD", "CNY", "HKD"]);
const externals = new Set(["externalDeposit", "externalWithdraw"]);
const internals = new Set(["tradeSettlement", "internalTransfer", "fx", "dividend", "interest", "taxFee"]);
const sourceRef = (id) => `brokerImportLedger.cashFlows.${id}`;
const issue = (code, message, fields = {}) => ({ code, message, ...fields });
const inPeriod = (value, from, through) => date(value) && value >= from && value <= through;
const sources = (value) => Array.isArray(value) && value.length > 0 && value.every((item) => text(item));

function usdValue(record, actualDate, fxByDate) {
  const source = sourceRef(record.id);
  if (record.currency === "USD") return {
    amountUsd: record.amountMinor / 100,
    usdEvidence: { kind: "native-usd", currency: "USD", amountMinor: record.amountMinor, source },
  };
  const day = fxByDate instanceof Map ? fxByDate.get(actualDate) : fxByDate?.[actualDate];
  const rate = day?.[record.currency];
  // The rate's valuation date is the actual cash-flow date. A provider may name
  // the last published fixing separately as asOfDate; never silently use today.
  if (!object(rate) || rate.date !== actualDate || !number(rate.usdPerUnit)
    || rate.usdPerUnit <= 0 || !text(rate.source)
    || (rate.asOfDate !== undefined && (!date(rate.asOfDate) || rate.asOfDate > actualDate))) return null;
  const amountUsd = record.amountMinor / 100 * rate.usdPerUnit;
  if (!money(amountUsd)) return null;
  return {
    amountUsd,
    usdEvidence: { kind: "dated-fx", currency: record.currency, amountMinor: record.amountMinor,
      date: actualDate, usdPerUnit: rate.usdPerUnit, source: `${source}; ${rate.source}` },
  };
}

/**
 * Project only actual canonical records. `resolutions` is an ephemeral replay
 * audit result, not a new persisted schema or a blanket user-confirmation flag.
 * Each resolution must bind the original fingerprint and list its source refs.
 * It may classify a bookkeeping record as internal, as a duplicate of another
 * external record, or establish its actual date and external direction.
 */
export function projectCanonicalFunding({ data, startDate, throughDate, fxByDate = {}, resolutions = {} } = {}) {
  const flows = [];
  const pending = [];
  const ignored = [];
  const stats = { recordCount: 0, externalCount: 0, depositCount: 0, withdrawalCount: 0,
    outsidePeriodCount: 0, ignoredCount: 0, pendingCount: 0, manualPrincipalCount: 0,
    candidateCount: 0, invalidCount: 0, duplicateCount: 0 };
  const addPending = (code, message, record, extra = {}) => {
    const entry = issue(code, message, {
      ...(text(record?.id) ? { flowId: record.id, sourceRef: sourceRef(record.id) } : {}),
      ...(date(record?.flowDate) ? { date: record.flowDate } : {}),
      ...(text(record?.account) ? { account: record.account } : {}),
      ...(currencies.has(record?.currency) ? { currency: record.currency } : {}),
      ...(Number.isSafeInteger(record?.amountMinor) ? { amountMinor: record.amountMinor } : {}),
      ...extra,
    });
    pending.push(entry);
  };
  if (!date(startDate) || !date(throughDate) || startDate > throughDate) {
    addPending("invalid-period", "资金核对日期范围无效");
    return { status: "unavailable", flows, pending, ignored, possibleInternalPairs: [], stats: { ...stats, pendingCount: pending.length } };
  }
  const ledger = data?.brokerImportLedger;
  const records = ledger?.cashFlows;
  if (!object(data) || !object(ledger) || !object(records)) {
    addPending("canonical-cash-flow-map-unavailable", "正式数据没有可读取的现金流对象映射");
    return { status: "unavailable", flows, pending, ignored, possibleInternalPairs: [], stats: { ...stats, pendingCount: pending.length } };
  }
  const normalized = new Map();
  const possibleInternalPairs = [];
  const usable = Object.values(records).filter((record) => object(record)
    && record.status !== "ignored" && date(record.flowDate)
    && Number.isSafeInteger(record.amountMinor) && record.amountMinor !== 0);
  // Equal amounts alone are not evidence of ownership or an actual paired
  // transfer. Surface these candidates for reconciliation; never silently net.
  for (const incoming of usable.filter((item) => item.kind === "externalDeposit" && item.amountMinor > 0)) {
    for (const outgoing of usable.filter((item) => ["unresolved", "internalTransfer"].includes(item.kind) && item.amountMinor < 0)) {
      if (incoming.account !== outgoing.account && incoming.flowDate === outgoing.flowDate
        && incoming.currency === outgoing.currency && incoming.amountMinor === -outgoing.amountMinor) {
        possibleInternalPairs.push({ date: incoming.flowDate, currency: incoming.currency,
          amountMinor: incoming.amountMinor, incomingFlowId: incoming.id, outgoingFlowId: outgoing.id,
          inPeriod: inPeriod(incoming.flowDate, startDate, throughDate) });
      }
    }
  }
  for (const [id, raw] of Object.entries(records)) {
    stats.recordCount += 1;
    if (!object(raw) || !text(id) || raw.id !== id) {
      stats.invalidCount += 1; addPending("cash-flow-id-invalid", "资金记录 ID 与对象映射不一致", raw); continue;
    }
    if (raw.status === "ignored") { stats.ignoredCount += 1; ignored.push({ flowId: id, reason: "ignored" }); continue; }
    if (!date(raw.flowDate) || !text(raw.account) || !currencies.has(raw.currency)
      || !Number.isSafeInteger(raw.amountMinor) || !Number.isSafeInteger(raw.principalDeltaCnyFen)
      || !["applied", "evidence", "proposed"].includes(raw.status)
      || !/^[a-f0-9]{64}$/.test(text(raw.fingerprint))) {
      stats.invalidCount += 1; addPending("cash-flow-record-invalid", "资金记录缺少有效日期、原币整数金额、来源身份或状态", raw); continue;
    }
    const resolution = object(resolutions) ? resolutions[id] : undefined;
    if (resolution !== undefined && (!object(resolution) || resolution.fingerprint !== raw.fingerprint
      || !sources(resolution.sourceRefs))) {
      stats.invalidCount += 1; addPending("cash-flow-resolution-stale", "该资金记录的核对结果与当前来源不一致", raw); continue;
    }
    const actualDate = resolution?.date ?? raw.flowDate;
    if (!date(actualDate)) { stats.invalidCount += 1; addPending("cash-flow-date-invalid", "资金核对结果没有有效实际日期", raw); continue; }
    if (!inPeriod(actualDate, startDate, throughDate)) {
      stats.outsidePeriodCount += 1; continue;
    }
    if (resolution?.disposition === "internal") {
      stats.ignoredCount += 1; ignored.push({ flowId: id, reason: "reconciled-internal", sourceRefs: [...resolution.sourceRefs] }); continue;
    }
    if (resolution?.disposition === "duplicate") {
      normalized.set(id, { raw, resolution, actualDate, duplicateOf: text(resolution.duplicateOf) }); continue;
    }
    const manualPrincipal = raw.sourceKind === "manual:cny-principal";
    if (manualPrincipal) stats.manualPrincipalCount += 1;
    const cashReconciliation = raw.kind === "manualCorrection" && raw.sourceKind === "manual:cash-reconciliation";
    if (internals.has(raw.kind) || cashReconciliation) {
      if (raw.principalDeltaCnyFen !== 0) {
        stats.invalidCount += 1; addPending("internal-principal-conflict", "内部资金记录意外改变了外部累计本金", raw);
      } else {
        stats.ignoredCount += 1; ignored.push({ flowId: id, reason: cashReconciliation ? "cash-checkpoint" : raw.kind });
      }
      continue;
    }
    const externalResolution = resolution?.disposition === "external";
    const kind = externalResolution ? resolution.kind : raw.kind;
    if (!externals.has(kind)) {
      addPending(manualPrincipal ? "manual-principal-needs-match" : "cash-flow-kind-unresolved",
        manualPrincipal ? "手工本金记账尚未与实际入金日期和到账依据对应" : "该资金记录尚未明确为外部入出金或内部变动", raw);
      continue;
    }
    if (!externalResolution && raw.status !== "applied") {
      stats.candidateCount += 1; addPending("external-flow-not-applied", "已有外部资金证据尚未与入账结果核对", raw); continue;
    }
    if (raw.amountMinor === 0 || (kind === "externalDeposit" ? raw.amountMinor < 0 : raw.amountMinor > 0)
      || (raw.principalDeltaCnyFen !== 0 && Math.sign(raw.principalDeltaCnyFen) !== Math.sign(raw.amountMinor))) {
      stats.invalidCount += 1; addPending("external-flow-direction-conflict", "外部资金的金额、本金增量与方向不一致", raw); continue;
    }
    const usd = usdValue(raw, actualDate, fxByDate);
    if (!usd) { addPending("external-flow-fx-unavailable", "该笔非美元入出金尚缺实际日期对应的美元换算依据", raw, { date: actualDate }); continue; }
    normalized.set(id, { raw, resolution, actualDate,
      flow: { id, date: actualDate, kind, status: "confirmed", ...usd,
        sourceRefs: [sourceRef(id), ...(resolution?.sourceRefs || [])] } });
  }
  for (const [id, entry] of normalized) {
    if (entry.duplicateOf !== undefined) {
      const target = normalized.get(entry.duplicateOf);
      if (!entry.duplicateOf || entry.duplicateOf === id || !target?.flow
        || target.flow.date !== entry.actualDate
        || target.raw.amountMinor !== entry.raw.amountMinor || target.raw.currency !== entry.raw.currency) {
        addPending("funding-duplicate-unresolved", "重复资金记录没有指向日期、币种和金额一致的已核对记录", entry.raw);
      } else {
        stats.duplicateCount += 1; stats.ignoredCount += 1;
        ignored.push({ flowId: id, reason: "reconciled-duplicate", duplicateOf: entry.duplicateOf });
      }
    } else if (entry.flow) {
      flows.push(entry.flow); stats.externalCount += 1;
      if (entry.flow.amountUsd > 0) stats.depositCount += 1; else stats.withdrawalCount += 1;
    }
  }
  const pairWarnings = new Set();
  for (const pair of possibleInternalPairs) {
    if (!pair.inPeriod || pairWarnings.has(pair.incomingFlowId)) continue;
    const resolved = resolutions?.[pair.incomingFlowId];
    if (resolved?.fingerprint === records[pair.incomingFlowId]?.fingerprint
      && sources(resolved.sourceRefs) && ["external", "internal", "duplicate"].includes(resolved.disposition)) continue;
    pairWarnings.add(pair.incomingFlowId);
    addPending("possible-internal-transfer", "该入账与另一投资账户同日同币种转出相符，需核对是否为内部互转",
      records[pair.incomingFlowId], { pairedCandidateId: pair.outgoingFlowId });
  }
  const byExternalRef = new Map();
  for (const entry of normalized.values()) {
    if (!entry.flow || !text(entry.raw.externalRef)) continue;
    const key = [entry.raw.broker, entry.raw.account, entry.raw.externalRef].map(text).join("|");
    const previous = byExternalRef.get(key);
    if (previous) addPending("funding-external-reference-conflict",
      "多笔资金记录共用同一账户来源编号，尚未核对是否为重复记录", entry.raw, { conflictingFlowId: previous.id });
    else byExternalRef.set(key, entry.raw);
  }
  flows.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  stats.pendingCount = pending.length;
  return { status: pending.length ? "unavailable" : "projected", flows, pending, ignored, stats, possibleInternalPairs };
}

/**
 * Attach replay evidence to projected funding. The proof is computed, ephemeral
 * output from reconciliation, never a new canonical field or an owner checkbox.
 * A matching checkpoint by itself is not proof that cash flows were complete.
 */
export function prepareCanonicalBenchmarkFunding({ data, startDate, throughDate,
  fxByDate = {}, reconciliation, replay, openingValuation } = {}) {
  const audit = reconciliation ?? deriveCanonicalFundingReconciliation({ data, replay,
    startDate, throughDate, fxByDate, openingValuation });
  const projected = projectCanonicalFunding({ data, startDate, throughDate, fxByDate,
    resolutions: audit.cashFlowResolutions || {} });
  const reasons = [...projected.pending];
  const opening = audit.opening;
  const coverage = audit.fundingCoverage;
  const openingConfirmed = object(opening) && opening.date === startDate
    && opening.status === "reconciled" && money(opening.initialUsd) && opening.initialUsd >= 0
    && sources(opening.sourceRefs) && opening.includesStartDateFlows === false;
  const fundingComplete = object(coverage) && coverage.status === "reconciled"
    && date(coverage.startDate) && date(coverage.throughDate)
    && coverage.startDate <= startDate && coverage.throughDate >= throughDate
    && sources(coverage.sourceRefs) && coverage.scope === "whole-portfolio"
    && Array.isArray(coverage.unresolved) && coverage.unresolved.length === 0;
  const snapshots = Array.isArray(data?.history?.dailySnapshots) ? data.history.dailySnapshots : [];
  const firstRecorded = snapshots.filter((item) => date(item?.date) && item.estimated === false
    && Array.isArray(item.rows) && item.rows.length).sort((a, b) => a.date.localeCompare(b.date))[0];
  const startSnapshot = snapshots.find((item) => item?.date === startDate);
  if (!openingConfirmed) reasons.push(issue("opening-capital-unreconciled",
    startSnapshot?.estimated === true
      ? "固定起点现存快照属于估算，尚不能确定当时实际资本"
      : "尚未从期初持仓、现金和实际入金核对固定起点资本",
    { date: startDate, ...(firstRecorded ? { firstRecordedDate: firstRecorded.date } : {}),
      ...(startSnapshot ? { startSnapshotEstimated: startSnapshot.estimated === true } : {}) }));
  if (!fundingComplete) reasons.push(issue("external-funding-coverage-unreconciled",
    "尚未完成全部投资账户在所选期间的外部资金核对", { startDate, throughDate }));
  return {
    ...projected, status: reasons.length ? "unavailable" : "available", reasons,
    benchmarkInput: { startDate, throughDate,
      initialUsd: openingConfirmed ? opening.initialUsd : undefined,
      openingConfirmed, fundingComplete: fundingComplete && projected.pending.length === 0,
      flows: projected.flows },
    evidence: { opening: openingConfirmed ? structuredClone(opening) : null,
      fundingCoverage: fundingComplete ? structuredClone(coverage) : null },
    reconciliation: audit,
  };
}

/**
 * Derive the adapter proof automatically from the existing canonical snapshots
 * and the replay engine's account/currency closure. This proves reconciliation
 * of the REGISTERED event stream, not that a third party audited every source.
 * A statement's coverageComplete flag is deliberately not used: in the current
 * importer it may only mean that a filename supplied a date interval.
 *
 * openingValuation is the valuation engine's calculated opening BEFORE the
 * separately projected start-date flows. Its rows must come from a recorded
 * checkpoint at/before the start, replayed forward or deterministically reversed
 * through exact start-day events. The valuation engine supplies historical FX /
 * prices; stored principalUsd is never read here.
 */
export function deriveCanonicalFundingReconciliation({ data, replay, startDate,
  throughDate, fxByDate = {}, openingValuation } = {}) {
  const projection = projectCanonicalFunding({ data, startDate, throughDate, fxByDate });
  const issues = [];
  const snapshots = Array.isArray(data?.history?.dailySnapshots) ? data.history.dailySnapshots : [];
  const recorded = snapshots.filter((item) => date(item?.date) && item.estimated === false
    && Array.isArray(item.rows) && item.rows.length);
  const openingCheckpoint = recorded.find((item) => item.date === openingValuation?.checkpointDate);
  const openingReady = object(openingValuation) && openingValuation.date === startDate
    && date(openingValuation.checkpointDate) && openingValuation.checkpointDate <= startDate
    && Boolean(openingCheckpoint) && money(openingValuation.totalUsd) && openingValuation.totalUsd >= 0
    && openingValuation.includesStartDateFlows === false && sources(openingValuation.sourceRefs);
  const closingReady = object(replay) && replay.status === "reconciled"
    && replay.coverage?.startsAtRequestedDate === true
    && date(replay.coverage?.reconciledThrough) && replay.coverage.reconciledThrough >= throughDate
    && Array.isArray(replay.checkpoints) && replay.checkpoints.every((item) => item?.ok === true)
    && (startDate === throughDate || replay.checkpoints.length > 0);
  if (!openingReady) issues.push(issue("opening-valuation-unavailable",
    "尚无由真实期初持仓、现金及历史价格换算得到的起点资本", { date: startDate,
      firstRecordedDate: recorded.map((item) => item.date).sort()[0] || "" }));
  if (!closingReady) issues.push(issue("registered-event-stream-not-reconciled",
    "已登记事件尚未从固定起点逐段核对到截止日的持仓和现金", {
      startDate, throughDate, reconciledThrough: replay?.coverage?.reconciledThrough || "" }));
  if (projection.pending.length) issues.push(...projection.pending);
  const sourceRefs = [...new Set([
    ...recorded.filter((item) => item.date >= startDate && item.date <= throughDate)
      .map((item) => `history.dailySnapshots[${item.date}]`),
    ...projection.flows.flatMap((item) => item.sourceRefs),
    ...(openingReady ? openingValuation.sourceRefs : []),
  ])];
  const ready = openingReady && closingReady && projection.pending.length === 0;
  return {
    status: ready ? "reconciled" : "unavailable", issues,
    basis: "registered-events-and-recorded-checkpoints",
    note: "按已有正式记录核对；不把结单日期覆盖标记当作完整现金流水审计。",
    cashFlowResolutions: {},
    opening: openingReady ? { status: "reconciled", date: startDate,
      initialUsd: openingValuation.totalUsd, includesStartDateFlows: false,
      sourceRefs: [...openingValuation.sourceRefs] } : null,
    fundingCoverage: { status: ready ? "reconciled" : "unavailable", startDate, throughDate,
      scope: "whole-portfolio", sourceRefs, unresolved: issues.map((item) => ({ ...item })),
      basis: "registered-events-and-recorded-checkpoints" },
    stats: { ...projection.stats },
  };
}
