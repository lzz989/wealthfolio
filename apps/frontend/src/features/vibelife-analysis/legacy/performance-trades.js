import { classifyImportedTrade } from "./operation-history.js?v=a33f660010";

/** Read-only display projection. Never infer executions from portfolio snapshots. */
const text = (value) => typeof value === "string" ? value.trim() : "";
const isDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const isNumberLike = (value) => (typeof value === "number" || (typeof value === "string" && value.trim() !== ""))
  && Number.isFinite(Number(value));
const isPositiveInteger = (value) => isNumberLike(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
const isExecutionTime = (value) => typeof value === "string" && isDate(value.slice(0, 10))
  && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d|[+-]14:00)$/.test(value)
  && Number.isFinite(Date.parse(value));
const money = (value, { signed = false } = {}) => {
  if (!isNumberLike(value)) return null;
  const minor = Number(value);
  return Number.isSafeInteger(minor) && (signed || minor >= 0) ? minor / 100 : null;
};
const entries = (value) => Array.isArray(value)
  ? value.map((record) => [null, record])
  : value && typeof value === "object" ? Object.entries(value) : [];
const lexical = (a, b) => String(a).localeCompare(String(b), "zh-Hans-CN");
const kindForSides = (trades) => {
  const sides = new Set(trades.map((trade) => trade.side));
  return sides.size > 1 ? "both" : sides.has("buy") ? "buy" : "sell";
};
const labelForKind = (kind) => ({ buy: "B", sell: "S", both: "T", mixed: "B/S" })[kind];
const eventSignature = (event) => JSON.stringify([
  event.date, event.account, event.instrumentId, event.currency, event.side,
  event.quantityUnits, event.unitPrice, event.grossAmount, event.feeAmount,
  event.netCashAmount, event.executedAt,
]);
const quality = (event) => (event.status === "applied" ? 2 : 0)
  + (event.feeAccuracy === "exact" ? 1 : 0);

/**
 * Output days contain actual trade dates, never moved to a chart trading day.
 * T means both directions in ONE account/instrument/currency on that date.
 * It does not assert a matched round trip, execution order or realized profit.
 * Amounts remain in their native currency; no cross-currency sum is produced.
 */
export function buildPerformanceTradeDays({ brokerImportLedger = {}, dcaSyncLedger = {} } = {}) {
  const excludedReasons = {};
  let excludedCount = 0;
  let duplicateCount = 0;
  let conflictCount = 0;
  const reject = (reason, count = 1) => {
    excludedReasons[reason] = (excludedReasons[reason] || 0) + count;
    excludedCount += count;
  };
  const byId = new Map();
  for (const [recordKey, raw] of entries(brokerImportLedger?.trades)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { reject("invalid-record"); continue; }
    const id = text(raw.id);
    if (!id || (recordKey !== null && recordKey !== id)) { reject("invalid-record-id"); continue; }
    const date = text(raw.tradeDate);
    if (!isDate(date)) { reject("invalid-trade-date"); continue; }
    if (!isPositiveInteger(raw.quantityUnits)) { reject("invalid-quantity"); continue; }
    const trade = classifyImportedTrade(raw, brokerImportLedger?.cutovers || {});
    if (trade.role !== "canonical") {
      reject(trade.role === "pending" ? "pending" : trade.role === "invalid" ? "invalid-record" : "unconfirmed");
      continue;
    }
    const recordedCurrency = text(raw.priceCurrency || raw.currency).toUpperCase();
    if (!text(raw.account) || !trade.account || trade.account === "未标账户"
      || !["USD", "HKD", "CNY"].includes(recordedCurrency)
      || !text(trade.instrumentId) || !["USD", "HKD", "CNY"].includes(trade.currency)) {
      reject("invalid-identity"); continue;
    }
    const rawPrice = raw.priceMicros ?? raw.price1e6 ?? raw.unitPrice ?? raw.price;
    if (!isNumberLike(rawPrice) || trade.accuracy !== "exact" || !Number.isFinite(trade.unitPrice) || trade.unitPrice <= 0) {
      reject("price-not-confirmed"); continue;
    }
    const feeAmount = money(raw.feeMinor);
    const feeAccuracy = feeAmount === null ? "pending"
      : ["exact", "estimated"].includes(raw.feeAccuracy) ? raw.feeAccuracy : "pending";
    const executedAt = trade.sequenceAccuracy === "exact"
      && isExecutionTime(trade.executedAt) ? trade.executedAt : "";
    const notes = [];
    if (feeAccuracy === "estimated") notes.push("费用为估算值");
    else if (feeAccuracy !== "exact") notes.push("费用待核实");
    if (trade.settlementStatus === "estimated") notes.push("结算金额待核实");
    if (!executedAt) notes.push("未记录精确成交时间");
    const event = {
      id, date, account: trade.account, instrumentId: trade.instrumentId, asset: trade.asset,
      currency: trade.currency, side: trade.side, label: trade.side === "buy" ? "B" : "S",
      quantityUnits: Number(raw.quantityUnits), quantity: Number(raw.quantityUnits) / 1e8,
      unitPrice: trade.unitPrice, priceAccuracy: "exact",
      grossAmount: money(raw.grossMinor), feeAmount, feeAccuracy,
      netCashAmount: money(raw.netCashMinor, { signed: true }),
      executedAt, sequenceAccuracy: executedAt ? "exact" : "unknown",
      source: "broker", sourceLabel: "已登记券商成交", status: trade.status,
      settlementStatus: trade.settlementStatus, notes,
    };
    const signature = eventSignature(event);
    const previous = byId.get(id);
    if (!previous) byId.set(id, { event, signature, copies: 1, conflict: false });
    else {
      previous.copies += 1;
      if (previous.signature !== signature) previous.conflict = true;
      if (!previous.conflict && quality(event) > quality(previous.event)) previous.event = event;
    }
  }
  const events = [];
  for (const item of byId.values()) {
    if (item.conflict) { conflictCount += 1; reject("conflicting-trade-id", item.copies); }
    else { events.push(item.event); duplicateCount += item.copies - 1; }
  }
  events.sort((a, b) => lexical(a.date, b.date)
    || lexical(a.account, b.account) || lexical(a.instrumentId, b.instrumentId)
    || lexical(a.currency, b.currency)
    || ((a.executedAt ? Date.parse(a.executedAt) : Infinity) - (b.executedAt ? Date.parse(b.executedAt) : Infinity))
    || lexical(a.id, b.id));
  const dayMap = new Map();
  for (const event of events) {
    if (!dayMap.has(event.date)) dayMap.set(event.date, new Map());
    const groups = dayMap.get(event.date);
    const key = JSON.stringify([event.account, event.instrumentId, event.currency]);
    if (!groups.has(key)) groups.set(key, {
      key, account: event.account, instrumentId: event.instrumentId, asset: event.asset,
      currency: event.currency, trades: [],
    });
    groups.get(key).trades.push(event);
  }
  const days = [...dayMap].map(([date, groupsByKey]) => {
    const groups = [...groupsByKey.values()].map((group) => {
      const kind = kindForSides(group.trades);
      return { ...group, kind, label: labelForKind(kind), tradeCount: group.trades.length };
    });
    const groupKinds = new Set(groups.map((group) => group.kind));
    const kind = groupKinds.size === 1 ? groups[0].kind : "mixed";
    return {
      date, kind, label: labelForKind(kind),
      tradeCount: groups.reduce((sum, group) => sum + group.tradeCount, 0),
      assetCount: new Set(groups.map((group) => group.instrumentId)).size,
      groupCount: groups.length, groups,
    };
  });

  // Applied DCA records prove a holding update, not an independently confirmed
  // execution date. Do not turn a bookkeeping/plan date into a B/S marker.
  let unplottedDcaCount = 0;
  let unverifiedDcaCount = 0;
  for (const [, record] of entries(dcaSyncLedger?.records)) {
    if (!record || typeof record !== "object" || !Array.isArray(record.assets) || !record.assets.length) continue;
    if (record.status === "applied") unplottedDcaCount += record.assets.length;
    else if (record.status === "legacyUnverified") unverifiedDcaCount += record.assets.length;
  }
  const coverage = ["仅标记已确认的登记成交，不含快照推断或未入账交易"];
  if (excludedCount) coverage.push(`${excludedCount} 条券商记录待核实或无效，未标记`);
  if (unplottedDcaCount) coverage.push(`${unplottedDcaCount} 项基金同步记录缺少独立成交日期依据，未标记`);
  if (unverifiedDcaCount) coverage.push(`${unverifiedDcaCount} 项旧基金同步记录尚未核实，未标记`);
  return {
    days, excludedCount, excludedReasons, duplicateCount, conflictCount,
    unplottedDcaCount, unverifiedDcaCount,
    sourceCounts: { broker: events.length, dca: 0 },
    coverageNote: `${coverage.join("；")}。`,
  };
}
