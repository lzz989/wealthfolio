export const OPERATION_EPSILON = 0.000001;
export const QUANTITY_SCALE = 100000000;
export const PRICE_MICROS_SCALE = 1000000;
export const MONEY_MINOR_SCALE = 100;

const numberValue = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const accountName = (value) => {
  const raw = String(value || "").trim();
  if (["ZA 银行", "ZA银行", "众安银行", "众安"].includes(raw)) return "众安";
  if (["象象", "天星", "现象象", "天星银行", "象象银行", "象象证券", "Airstar", "Airstar Bank", "Elebank"].includes(raw)) return "象象";
  return raw;
};

const brokerAccount = (trade = {}) => accountName(trade.account) || ({
  hsbc: "汇丰",
  schwab: "嘉信",
  za: "众安",
  airstar: "象象",
  elebank: "象象",
}[String(trade.broker || "").toLowerCase()] || "未标账户");

const fundCode = (row) => String(row?.fundCode || row?.fund_code || "").trim();
const currencyOf = (row) => String(row?.currency || "USD").toUpperCase();
const isAlipay = (row) => accountName(row?.account) === "支付宝基金";
const isCash = (row) => row?.type === "cash" || ["现金", "CASH"].includes(String(row?.asset || "").trim().toUpperCase());
const hasNav = (row) => isAlipay(row) && numberValue(row?.marketPrice) > 0;
const hasEastmoneyNav = (row) => isAlipay(row) && String(row?.navSource || "").startsWith("东方财富");
const normalizedRow = (row = {}) => ({ ...row, account: accountName(row.account), currency: currencyOf(row) });
const formatNumber = (value) => numberValue(value).toLocaleString("en-US", { maximumFractionDigits: 4 });
const priceText = (value, currency) => Number.isFinite(Number(value)) && Number(value) > 0
  ? `${formatNumber(value)} ${String(currency || "USD").toUpperCase()}`
  : "价格未知";
const assetName = (row) => fundCode(row)
  ? `${fundCode(row)} · ${String(row?.asset || "基金")}`
  : String(row?.asset || "未标资产");
const rowLabel = (row) => `${accountName(row?.account) || "未标账户"} · ${assetName(row)}`;
const tone = (value) => value > 0 ? "good" : value < 0 ? "bad" : "neutral";

export function operationSystemForRow(row) {
  return isAlipay(row) ? "alipay" : "broker";
}

export function operationInstrumentId(row) {
  const code = fundCode(row);
  if (/^\d{6}$/.test(code)) return `fund:${code}`;
  if (isAlipay(row)) return "";
  const symbol = String(row?.quoteSymbol || row?.asset || "").trim().toUpperCase();
  return symbol ? `equity:${symbol}` : "";
}

/** Identity = normalized account + instrumentId + currency (type excluded). */
export function operationIdentityParts(row) {
  const account = accountName(row?.account) || "未标账户";
  const instrumentId = operationInstrumentId(row)
    || (fundCode(row) || String(row?.asset || "未标资产")).trim().toUpperCase();
  const currency = currencyOf(row);
  return { account, instrumentId, currency };
}

export function operationRowKey(row) {
  const { account, instrumentId, currency } = operationIdentityParts(row);
  return [account, instrumentId, currency].join("|");
}

export function quantityToEpsilonUnits(quantity) {
  return Math.round(numberValue(quantity) / OPERATION_EPSILON);
}

/** Snapshot/import quantity as exact 1e8 integer units. */
export function quantityToUnits(quantity) {
  return Math.round(numberValue(quantity) * QUANTITY_SCALE);
}

export function quantityFromUnits(units) {
  return numberValue(units) / QUANTITY_SCALE;
}

export function priceFromMicros(micros) {
  const parsed = Number(micros);
  return Number.isFinite(parsed) ? parsed / PRICE_MICROS_SCALE : null;
}

const isSafeInteger = (value) => Number.isSafeInteger(Number(value));
const isIsoDate = (value) => {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
};
const optionalValuePresent = (value) => value !== undefined && value !== null && value !== "";

/** Validate and calculate one cash reconciliation without touching rows or persistence. */
export function cashReconciliationPreview(input = {}) {
  const account = accountName(input.account);
  const currency = String(input.currency || "").trim().toUpperCase();
  const flowDate = String(input.flowDate || "").trim();
  const checkpointMode = String(input.checkpointMode || "").trim();
  const bookBalanceMinor = Number(input.bookBalanceMinor);
  const actualBalanceMinor = Number(input.actualBalanceMinor);
  if (!account) return { ok: false, error: "缺少账户" };
  if (!["USD", "HKD", "CNY"].includes(currency)) return { ok: false, error: "币种无效" };
  if (!isIsoDate(flowDate)) return { ok: false, error: "核对截止日无效" };
  if (!["eod", "intraday"].includes(checkpointMode)) return { ok: false, error: "核对时点类型无效" };
  if (!isSafeInteger(bookBalanceMinor) || bookBalanceMinor < 0) return { ok: false, error: "账本现金无效" };
  if (!isSafeInteger(actualBalanceMinor) || actualBalanceMinor < 0) return { ok: false, error: "真实现金无效" };

  const result = {
    ok: true,
    account,
    currency,
    flowDate,
    checkpointMode,
    bookBalanceMinor,
    actualBalanceMinor,
    amountMinor: actualBalanceMinor - bookBalanceMinor,
    fxTheoreticalReceivedMinor: null,
    fxFrictionMinor: null,
  };
  const fxFields = [input.fxCnyFen, input.fxReceivedMinor, input.fxReferenceCnyPerUnitMicros];
  const fxPresent = fxFields.map(optionalValuePresent);
  if (!fxPresent.some(Boolean)) return result;
  if (!fxPresent.every(Boolean)) return { ok: false, error: "换汇依据需同时填写 CNY、实际到账和基准汇率" };
  if (currency === "CNY") return { ok: false, error: "换汇摩擦只用于 CNY 兑入外币" };
  const fxCnyFen = Number(input.fxCnyFen);
  const fxReceivedMinor = Number(input.fxReceivedMinor);
  const fxReferenceCnyPerUnitMicros = Number(input.fxReferenceCnyPerUnitMicros);
  if (!isSafeInteger(fxCnyFen) || fxCnyFen <= 0
    || !isSafeInteger(fxReceivedMinor) || fxReceivedMinor <= 0
    || !isSafeInteger(fxReferenceCnyPerUnitMicros) || fxReferenceCnyPerUnitMicros <= 0) {
    return { ok: false, error: "换汇依据无效" };
  }
  const numerator = BigInt(fxCnyFen) * 1000000n;
  const denominator = BigInt(fxReferenceCnyPerUnitMicros);
  const theoretical = (numerator + denominator / 2n) / denominator;
  const friction = theoretical - BigInt(fxReceivedMinor);
  if (theoretical > BigInt(Number.MAX_SAFE_INTEGER)
    || friction > BigInt(Number.MAX_SAFE_INTEGER)
    || friction < BigInt(Number.MIN_SAFE_INTEGER)) {
    return { ok: false, error: "换汇计算超出安全整数范围" };
  }
  return {
    ...result,
    fxCnyFen,
    fxReceivedMinor,
    fxReferenceCnyPerUnitMicros,
    fxTheoreticalReceivedMinor: Number(theoretical),
    fxFrictionMinor: Number(friction),
  };
}

/** True only when a cash event is provably after a reconciliation checkpoint. */
export function cashEventAfterCheckpoint(checkpoint = {}, event = {}, { eventType = "" } = {}) {
  const checkpointDate = String(checkpoint.flowDate || "");
  const eventDate = String(event.tradeDate || event.flowDate || "");
  if (!isIsoDate(checkpointDate) || !isIsoDate(eventDate)) return false;
  if (eventDate > checkpointDate) return true;
  if (eventDate < checkpointDate || checkpoint.checkpointMode !== "intraday" || eventType !== "trade") return false;
  const eventTime = Date.parse(String(event.executedAt || ""));
  const checkpointTime = Date.parse(String(checkpoint.appliedAt || ""));
  return Number.isFinite(eventTime) && Number.isFinite(checkpointTime) && eventTime > checkpointTime;
}

/** Stable event key across adjacent snapshots. */
export function operationEventKey({
  previousDate = "",
  date = "",
  account = "",
  instrumentId = "",
  currency = "",
  beforeQty = 0,
  afterQty = 0,
} = {}) {
  return [
    previousDate,
    date,
    account,
    instrumentId,
    currency,
    quantityToEpsilonUnits(beforeQty),
    quantityToEpsilonUnits(afterQty),
  ].join("|");
}

const cashKey = (row) => `${accountName(row?.account)}|${currencyOf(row)}`;

const rowsByKey = (rows = []) => {
  const result = new Map();
  rows.map(normalizedRow).forEach((row) => {
    const key = operationRowKey(row);
    const quantity = Number(row.quantity);
    if (!Number.isFinite(quantity)) {
      result.set(key, row);
      return;
    }
    if (Math.abs(quantity) <= 0.0000001 && !result.has(key)) return;
    result.set(key, row);
  });
  return result;
};

const cashTotals = (rows = []) => {
  const result = new Map();
  rows.map(normalizedRow).filter(isCash).forEach((row) => {
    result.set(cashKey(row), numberValue(result.get(cashKey(row))) + numberValue(row.quantity));
  });
  return result;
};

const operationTitle = (row, kind, full = false) => {
  if (isAlipay(row)) return kind === "buy" ? (full ? "申购" : "追加申购") : "赎回";
  return kind === "buy" ? (full ? "新开仓" : "加仓") : (full ? "清仓" : "减仓");
};

export function inferredAddedCost(beforeQty, beforeCost, afterQty, afterCost) {
  const previousQuantity = Number(beforeQty);
  const nextQuantity = Number(afterQty);
  const nextCost = Number(afterCost);
  if (![previousQuantity, nextQuantity, nextCost].every(Number.isFinite)) return null;
  const quantityDelta = nextQuantity - previousQuantity;
  if (quantityDelta <= OPERATION_EPSILON || nextCost <= 0) return null;
  let totalCost = nextQuantity * nextCost;
  if (Math.abs(previousQuantity) > OPERATION_EPSILON) {
    const previousCost = Number(beforeCost);
    if (!Number.isFinite(previousCost) || previousCost <= 0) return null;
    totalCost -= previousQuantity * previousCost;
  }
  const unitCost = totalCost / quantityDelta;
  if (![totalCost, unitCost].every(Number.isFinite) || totalCost <= 0 || unitCost <= 0) return null;
  return { quantityDelta, totalCost, unitCost };
}

const toUsd = (value, currency, snapshot) => {
  if (currency === "HKD") return value / Math.max(numberValue(snapshot?.usdHkd, 7.8359), 0.0001);
  if (currency === "CNY") return value / Math.max(numberValue(snapshot?.usdCny, 7.1), 0.0001);
  return value;
};

const resolveEffectiveDate = (previous, current, row, eventKey, options = {}) => {
  const overrides = options.effectiveDateOverrides || options.effectiveDates || null;
  if (!overrides) return null;
  if (typeof overrides === "function") {
    const resolved = overrides({ previous, current, row, eventKey, date: current?.date, previousDate: previous?.date });
    return resolved ? String(resolved) : null;
  }
  const direct = overrides[eventKey]
    || overrides[current?.date]
    || overrides[`${previous?.date}->${current?.date}`]
    || overrides[`${previous?.date}|${current?.date}`];
  if (direct && typeof direct === "object") return direct.effectiveTradeDate ? String(direct.effectiveTradeDate) : null;
  return direct ? String(direct) : null;
};

const isNonTradingPending = (previous, current, row, eventKey, options = {}) => {
  const nonTrading = typeof options.isTradingDate === "function"
    ? !options.isTradingDate(current?.date, row)
    : typeof options.isNonTradingDate === "function" && options.isNonTradingDate(current?.date, row);
  if (!nonTrading) return false;
  return !resolveEffectiveDate(previous, current, row, eventKey, options);
};

const eventBase = (row, date, kind, rowKey, {
  previousDate = "",
  beforeQty = 0,
  afterQty = 0,
  pending = false,
  effectiveDate = null,
} = {}) => {
  const identity = operationIdentityParts(row);
  const instrumentId = identity.instrumentId;
  const id = operationEventKey({
    previousDate,
    date,
    account: identity.account,
    instrumentId,
    currency: identity.currency,
    beforeQty,
    afterQty,
  });
  return {
    id,
    eventKey: id,
    instrumentId,
    rowKey,
    positionKey: rowKey,
    account: identity.account,
    asset: String(row.asset || "未标资产"),
    fundCode: fundCode(row),
    date,
    effectiveDate: effectiveDate || date,
    kind,
    system: operationSystemForRow(row),
    priceCurrency: identity.currency,
    lotId: null,
    pendingConfirmation: pending,
    provisional: pending,
    chartable: !pending,
    lotEligible: !pending,
  };
};

export function inferOperationDay(previous, current, options = {}) {
  const previousRows = Array.isArray(previous?.rows) ? previous.rows.map(normalizedRow) : [];
  const currentRows = Array.isArray(current?.rows) ? current.rows.map(normalizedRow) : [];
  const previousMap = rowsByKey(previousRows);
  const currentMap = rowsByKey(currentRows);
  const previousCash = cashTotals(previousRows);
  const currentCash = cashTotals(currentRows);
  const operations = [];
  const sellGroups = new Map();
  const buyGroups = new Set();
  const estimated = Boolean(previous?.estimated || current?.estimated || previous?.alipayEstimated || current?.alipayEstimated);
  const addSell = (key, operation) => {
    if (!sellGroups.has(key)) sellGroups.set(key, []);
    sellGroups.get(key).push(operation);
    operations.push(operation);
  };

  [...new Set([...previousMap.keys(), ...currentMap.keys()])].sort().forEach((key) => {
    const before = previousMap.get(key);
    const after = currentMap.get(key);
    const row = after || before;
    if (!row || isCash(row)) return;
    if ((before && !Number.isFinite(Number(before.quantity))) || (after && !Number.isFinite(Number(after.quantity)))) return;
    if (before && after && isAlipay(before) && !hasNav(before) && !hasEastmoneyNav(before) && hasEastmoneyNav(after) && numberValue(after.marketPrice) > 0) return;
    if (isAlipay(row) && !hasNav(before) && !hasNav(after)) return;

    const beforeQty = numberValue(before?.quantity);
    const afterQty = numberValue(after?.quantity);
    const delta = afterQty - beforeQty;
    const beforeCost = numberValue(before?.costPrice);
    const afterCost = numberValue(after?.costPrice);
    const groupKey = cashKey(row);
    const identity = operationIdentityParts(row);
    const provisionalEventKey = operationEventKey({
      previousDate: previous?.date || "",
      date: current?.date || "",
      account: identity.account,
      instrumentId: identity.instrumentId,
      currency: identity.currency,
      beforeQty,
      afterQty,
    });
    const operationPending = isNonTradingPending(previous, current, row, provisionalEventKey, options);
    const operationEffectiveDate = resolveEffectiveDate(previous, current, row, provisionalEventKey, options) || current?.date;
    const baseOpts = {
      previousDate: previous?.date || "",
      beforeQty,
      afterQty,
      pending: operationPending,
      effectiveDate: operationEffectiveDate,
    };

    if ((!before && afterQty > OPERATION_EPSILON) || delta > OPERATION_EPSILON) {
      const full = !before || beforeQty <= OPERATION_EPSILON;
      const addedCost = inferredAddedCost(beforeQty, beforeCost, afterQty, afterCost);
      const base = eventBase(row, current.date, "buy", key, baseOpts);
      const lotId = operationPending ? null : `${operationEffectiveDate || current.date}|${key}`;
      const costLabel = isAlipay(row) ? "本次申购隐含净值（推算）" : "本次加仓隐含成本（推算）";
      const pendingLabel = isAlipay(row) ? "本次申购隐含净值（待估）" : "本次加仓隐含成本（待估）";
      const averageLabel = isAlipay(row) ? "调仓后平均成本净值" : "调仓后平均成本";
      operations.push({
        ...base,
        lotId,
        tone: "neutral",
        accountCurrencyKey: groupKey,
        title: operationTitle(row, "buy", full),
        label: rowLabel(row),
        quantityDelta: delta,
        addedQuantity: delta,
        soldQuantity: 0,
        unitPrice: addedCost?.unitCost ?? null,
        priceStatus: addedCost ? "inferred" : "pending",
        endingAverageCost: afterCost > 0 ? afterCost : null,
        estimated,
        includesEstimatedSnapshot: estimated,
        addedCost,
        realizedUsd: null,
        realizedNative: null,
        realizedEvidence: false,
        meta: addedCost
          ? `${formatNumber(beforeQty)} -> ${formatNumber(afterQty)}，新增 ${formatNumber(delta)}，${costLabel} ${priceText(addedCost.unitCost, row.currency)}，${averageLabel} ${priceText(afterCost, row.currency)}${estimated ? "，含估算日" : ""}${operationPending ? "，非交易日待确认" : ""}`
          : `${formatNumber(beforeQty)} -> ${formatNumber(afterQty)}，新增 ${formatNumber(delta)}，${pendingLabel}${estimated ? "，含估算日" : ""}${operationPending ? "，非交易日待确认" : ""}`,
      });
      buyGroups.add(groupKey);
      return;
    }

    if ((before && !after && beforeQty > OPERATION_EPSILON) || delta < -OPERATION_EPSILON) {
      const full = !after || afterQty <= OPERATION_EPSILON;
      const soldQuantity = full ? beforeQty : Math.abs(delta);
      addSell(groupKey, {
        ...eventBase(before || row, current.date, "sell", key, baseOpts),
        tone: "neutral",
        accountCurrencyKey: groupKey,
        row: after || before,
        title: operationTitle(after || before, "sell", full),
        label: rowLabel(after || before),
        quantityDelta: -soldQuantity,
        addedQuantity: 0,
        soldQuantity,
        positionClosed: full,
        costPrice: beforeCost,
        unitPrice: null,
        priceStatus: "pending",
        endingAverageCost: afterCost > 0 ? afterCost : null,
        estimated,
        includesEstimatedSnapshot: estimated,
        realizedUsd: null,
        realizedNative: null,
        realizedEvidence: false,
        meta: `${formatNumber(beforeQty)} -> ${formatNumber(afterQty)}${full ? "" : `，卖出 ${formatNumber(soldQuantity)}`}${operationPending ? "，非交易日待确认" : ""}`,
      });
    }
  });

  sellGroups.forEach((group, key) => {
    const cashDelta = numberValue(currentCash.get(key)) - numberValue(previousCash.get(key));
    const cashBased = group.length === 1 && !buyGroups.has(key) && cashDelta > OPERATION_EPSILON;
    group.forEach((operation) => {
      const fallback = numberValue(operation.row?.marketPrice) || numberValue(previousMap.get(operation.rowKey)?.marketPrice);
      const salePrice = cashBased ? cashDelta / Math.max(operation.soldQuantity, OPERATION_EPSILON) : fallback;
      operation.unitPrice = salePrice > 0 ? salePrice : null;
      if (cashBased && operation.unitPrice) {
        // Cash-difference prices are estimates only; never exact or realized-profit evidence.
        operation.priceStatus = "estimated";
        operation.estimated = true;
        operation.priceSource = "cash-difference-estimate";
        operation.realizedEvidence = false;
      } else {
        operation.priceStatus = operation.unitPrice ? "inferred" : "pending";
        operation.priceSource = operation.unitPrice ? "market-price-fallback" : null;
      }
      if (salePrice > 0 && operation.costPrice > 0) {
        const realizedNative = Math.abs(operation.soldQuantity * (salePrice - operation.costPrice)) < 0.005
          ? 0
          : operation.soldQuantity * (salePrice - operation.costPrice);
        if (cashBased) {
          operation.realizedNative = null;
          operation.realizedUsd = null;
          operation.realizedEvidence = false;
          operation.estimatedRealizedNative = realizedNative;
          operation.estimatedRealizedUsd = toUsd(realizedNative, operation.priceCurrency, current);
          operation.tone = "neutral";
          operation.meta += `，现金变化推断估价 ${priceText(salePrice, operation.priceCurrency)}（非实盈证据）`;
        } else {
          operation.realizedNative = realizedNative;
          operation.realizedUsd = toUsd(realizedNative, operation.priceCurrency, current);
          operation.realizedEvidence = true;
          operation.tone = tone(operation.realizedUsd);
          operation.meta += `，现价估算 ${priceText(salePrice, operation.priceCurrency)}，推断 ${formatNumber(realizedNative)} ${operation.priceCurrency}`;
        }
      } else {
        operation.meta += "，盈亏无法估算";
      }
    });
  });

  if (!operations.length) return null;
  const realized = operations.filter((item) => item.realizedEvidence && Number.isFinite(item.realizedUsd));
  const realizedUsd = realized.reduce((sum, item) => sum + item.realizedUsd, 0);
  const usdCny = Math.max(numberValue(current?.usdCny, 7.1), 0.0001);
  const pendingConfirmation = operations.some((operation) => operation.pendingConfirmation);
  const effectiveDates = [...new Set(operations.map((operation) => operation.effectiveDate).filter(Boolean))];
  return {
    date: current.date,
    previousDate: previous.date,
    effectiveDate: effectiveDates.length === 1 ? effectiveDates[0] : current.date,
    pendingConfirmation,
    provisional: pendingConfirmation,
    usdCny,
    operations,
    realizedKnown: realized.length > 0,
    realizedUsd,
    realizedCny: realizedUsd * usdCny,
    tone: realized.length ? tone(realizedUsd) : "neutral",
  };
}

const asObjectList = (value) => {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value && typeof value === "object") {
    return Object.entries(value).map(([key, item]) => {
      if (!item || typeof item !== "object") return null;
      return { id: item.id || item.key || key, ...item };
    }).filter(Boolean);
  }
  return [];
};

const cashRowsFor = (rows, account, currency) => rows.filter((row) => (
  isCash(row)
  && accountName(row?.account) === accountName(account)
  && currencyOf(row) === String(currency || "").toUpperCase()
));

/** Apply one confirmed balance to a cloned row set. */
export function applyCashReconciliationToRows(rows = [], record = {}) {
  const originalRows = rows.map(normalizedRow);
  const preview = cashReconciliationPreview(record);
  if (!preview.ok) return { ok: false, rows: originalRows, errors: [{ reason: preview.error }] };
  const matches = cashRowsFor(originalRows, preview.account, preview.currency);
  if (matches.length !== 1) {
    return {
      ok: false,
      rows: originalRows,
      errors: [{ reason: matches.length ? "同一账户和币种存在重复现金行" : "未找到对应现金行" }],
    };
  }
  const nextRows = originalRows.map((row) => ({ ...row }));
  const target = cashRowsFor(nextRows, preview.account, preview.currency)[0];
  target.quantity = preview.actualBalanceMinor / MONEY_MINOR_SCALE;
  target.asset = target.asset || preview.currency;
  target.type = "cash";
  target.currency = preview.currency;
  target.costPrice = "";
  target.marketPrice = "";
  target.riskMultiplier = 0;
  return { ok: true, rows: nextRows, preview, errors: [] };
}

const reconciliationFlows = (ledger, account, currency) => asObjectList(ledger?.cashFlows)
  .filter((flow) => flow?.status === "applied"
    && flow?.sourceKind === "manual:cash-reconciliation"
    && accountName(flow.account) === accountName(account)
    && String(flow.currency || "").toUpperCase() === String(currency || "").toUpperCase())
  .sort((a, b) => String(a.flowDate || "").localeCompare(String(b.flowDate || ""))
    || String(a.appliedAt || "").localeCompare(String(b.appliedAt || ""))
    || String(a.id || "").localeCompare(String(b.id || "")));

const addPrioritizedFee = (groups, key, priority, amountMinor, source) => {
  if (!key || !Number.isSafeInteger(amountMinor) || amountMinor < 0) return;
  const current = groups.get(key);
  if (!current || priority > current.priority) {
    groups.set(key, { priority, amounts: new Set([amountMinor]), sources: [source] });
  } else if (priority === current.priority) {
    current.amounts.add(amountMinor);
    current.sources.push(source);
  }
};

/** Summarize one account/currency without applying any diagnostic amount again. */
export function cashReconciliationSummary(rows = [], ledger = {}, { account = "", currency = "" } = {}) {
  const normalizedAccount = accountName(account);
  const normalizedCurrency = String(currency || "").toUpperCase();
  const matches = cashRowsFor(rows.map(normalizedRow), normalizedAccount, normalizedCurrency);
  const currentMinor = matches.length === 1 ? Math.round(numberValue(matches[0].quantity) * MONEY_MINOR_SCALE) : null;
  const reconciliations = reconciliationFlows(ledger, normalizedAccount, normalizedCurrency);
  const latest = reconciliations.at(-1) || null;

  const feeGroups = new Map();
  const tradeFeeKeys = new Map();
  asObjectList(ledger?.trades).forEach((trade) => {
    if (accountName(trade?.account) !== normalizedAccount
      || String(trade?.priceCurrency || trade?.currency || "").toUpperCase() !== normalizedCurrency
      || trade?.feeAccuracy !== "exact"
      || !["accepted", "applied"].includes(String(trade?.status || ""))) return;
    const amount = Number(trade.feeMinor);
    const reference = String(trade?.externalRef || trade?.id || "");
    const priority = trade.status === "applied" ? 2 : 1;
    const key = `${normalizedAccount}|${normalizedCurrency}|${reference}`;
    tradeFeeKeys.set(String(trade.id || ""), key);
    addPrioritizedFee(feeGroups, key, priority, amount, trade.id);
  });
  asObjectList(ledger?.cashFlows).forEach((flow) => {
    if (accountName(flow?.account) !== normalizedAccount
      || String(flow?.currency || "").toUpperCase() !== normalizedCurrency
      || flow?.status !== "applied"
      || flow?.kind !== "taxFee") return;
    const amount = Math.abs(Number(flow.amountMinor));
    const reference = String(flow?.pairedFlowId || flow?.externalRef || flow?.id || "");
    const key = tradeFeeKeys.get(String(flow?.pairedFlowId || ""))
      || `${normalizedAccount}|${normalizedCurrency}|${reference}`;
    addPrioritizedFee(feeGroups, key, 3, amount, flow.id);
  });
  let confirmedFeeMinor = 0;
  let feeConflict = false;
  feeGroups.forEach((group) => {
    if (group.amounts.size !== 1) {
      feeConflict = true;
      return;
    }
    confirmedFeeMinor += [...group.amounts][0];
  });

  const fxGroups = new Map();
  reconciliations.forEach((flow) => {
    if (!flow.pairedFlowId) return;
    const preview = cashReconciliationPreview(flow);
    if (!preview.ok || preview.fxFrictionMinor === null) return;
    if (!fxGroups.has(flow.pairedFlowId)) fxGroups.set(flow.pairedFlowId, new Set());
    fxGroups.get(flow.pairedFlowId).add(preview.fxFrictionMinor);
  });
  let fxFrictionMinor = 0;
  let fxConflict = false;
  fxGroups.forEach((amounts) => {
    if (amounts.size !== 1) {
      fxConflict = true;
      return;
    }
    fxFrictionMinor += [...amounts][0];
  });

  return {
    account: normalizedAccount,
    currency: normalizedCurrency,
    cashRowCount: matches.length,
    currentBookBalanceMinor: Number.isSafeInteger(currentMinor) && currentMinor >= 0 ? currentMinor : null,
    lastActualBalanceMinor: latest && Number.isSafeInteger(Number(latest.actualBalanceMinor)) ? Number(latest.actualBalanceMinor) : null,
    lastBookBalanceMinor: latest && Number.isSafeInteger(Number(latest.bookBalanceMinor)) ? Number(latest.bookBalanceMinor) : null,
    lastUnattributedDeltaMinor: latest && Number.isSafeInteger(Number(latest.amountMinor)) ? Number(latest.amountMinor) : null,
    lastDate: latest?.flowDate || "",
    lastCheckpointMode: latest?.checkpointMode || "",
    latestRecord: latest,
    confirmedFeeMinor,
    confirmedFeeGroupCount: feeGroups.size,
    fxFrictionMinor,
    fxFrictionGroupCount: fxGroups.size,
    feeConflict,
    fxConflict,
  };
}

const tradeSide = (trade) => {
  const raw = String(trade?.side || trade?.kind || trade?.action || "").trim().toLowerCase();
  if (["buy", "b", "买入", "申购", "新开仓", "加仓"].includes(raw)) return "buy";
  if (["sell", "s", "卖出", "赎回", "减仓", "清仓"].includes(raw)) return "sell";
  return "";
};

const tradeInstrumentId = (trade) => {
  const direct = String(trade?.instrumentId || "").trim();
  if (direct) return direct;
  const code = String(trade?.fundCode || trade?.fund_code || "").trim();
  if (/^\d{6}$/.test(code)) return `fund:${code}`;
  const symbol = String(trade?.quoteSymbol || trade?.symbol || trade?.asset || "").trim().toUpperCase();
  return symbol ? `equity:${symbol}` : "";
};

const tradeCurrency = (trade) => String(trade?.priceCurrency || trade?.currency || "USD").toUpperCase();

const tradeDateOf = (trade) => {
  const raw = String(trade?.tradeDate || trade?.effectiveDate || trade?.date || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
};

const tradeQuantityUnits = (trade) => {
  if (Number.isFinite(Number(trade?.quantityUnits))) return Math.round(Number(trade.quantityUnits));
  if (Number.isFinite(Number(trade?.qty1e8))) return Math.round(Number(trade.qty1e8));
  if (Number.isFinite(Number(trade?.quantity))) return quantityToUnits(trade.quantity);
  return null;
};

const coverageComplete = (trade) => Boolean(
  trade?.executionCoverageComplete === true
  || trade?.coverageComplete === true
  || trade?.authoritativeCoverage === true
  || trade?.reconciled === true
  || ["complete", "authoritative", "covered", "full"].includes(String(trade?.coverageStatus || trade?.reconciliationStatus || trade?.coverage || "").toLowerCase())
);

const settlementOf = (trade) => String(trade?.settlementStatus || trade?.settlement || "").trim().toLowerCase();
const accuracyOf = (trade) => {
  const raw = String(trade?.accuracy || trade?.priceAccuracy || trade?.priceStatus || "").trim().toLowerCase();
  if (raw === "exact" || raw === "estimated" || raw === "pending") return raw;
  if (trade?.exact === true) return "exact";
  if (trade?.estimated === true) return "estimated";
  return Number.isFinite(Number(trade?.priceMicros)) || numberValue(trade?.unitPrice || trade?.price) > 0 ? "exact" : "pending";
};

const cutoverDateForAccount = (account, cutovers = []) => {
  const name = accountName(account);
  const matches = asObjectList(cutovers).filter((item) => accountName(item?.account) === name);
  if (!matches.length) return "";
  const dates = matches.map((item) => String(item.goLiveDate || item.effectiveDate || item.cutoverDate || item.date || "").trim())
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  return dates[0] || "";
};

/** Classify imported trade for merge/display. Defensive against partial schema. */
export function classifyImportedTrade(trade = {}, cutovers = []) {
  const account = brokerAccount(trade);
  const instrumentId = tradeInstrumentId(trade);
  const currency = tradeCurrency(trade);
  const side = tradeSide(trade);
  const tradeDate = tradeDateOf(trade);
  const quantityUnits = tradeQuantityUnits(trade);
  const settlement = settlementOf(trade);
  const status = String(trade?.status || "evidence").trim().toLowerCase();
  const accuracy = accuracyOf(trade);
  const complete = coverageComplete(trade);
  const cutoverDate = cutoverDateForAccount(account, cutovers);
  const preCutover = Boolean(cutoverDate && tradeDate && tradeDate < cutoverDate);
  const postCutover = Boolean(cutoverDate && tradeDate && tradeDate >= cutoverDate);
  const noCutover = !cutoverDate;
  let role = "unresolved";
  if (status === "ignored" || !tradeDate || !side || !instrumentId || !Number.isFinite(quantityUnits) || quantityUnits <= 0) {
    role = "invalid";
  } else if (!["accepted", "applied"].includes(status)) {
    role = settlement === "pending" ? "pending" : "unresolved";
  } else if (settlement === "pending") {
    role = "pending";
  } else if (settlement === "evidenceonly" || settlement === "evidence_only" || settlement === "evidence") {
    role = "unresolved";
  } else if (status === "accepted") {
    role = complete ? "canonical" : "unresolved";
  } else if (preCutover) {
    role = complete ? "canonical" : "unresolved";
  } else if (postCutover || noCutover) {
    role = (["settled", "estimated"].includes(settlement) || !settlement) && complete ? "canonical" : "unresolved";
  }
  const unitPrice = priceFromMicros(trade?.priceMicros ?? trade?.price1e6);
  const fallbackPrice = numberValue(trade?.unitPrice || trade?.price, NaN);
  const price = unitPrice != null ? unitPrice : (Number.isFinite(fallbackPrice) && fallbackPrice > 0 ? fallbackPrice : null);
  const stableId = String(
    trade?.id
    || trade?.key
    || trade?.sourceRefHash
    || [tradeDate, account, instrumentId, side, quantityUnits, trade?.priceMicros ?? price ?? ""].join("|"),
  );
  return {
    id: stableId,
    account,
    instrumentId,
    currency,
    side,
    tradeDate,
    quantityUnits,
    quantity: quantityFromUnits(quantityUnits || 0),
    unitPrice: price,
    accuracy,
    settlementStatus: settlement || (role === "canonical" ? "settled" : settlement),
    coverageComplete: complete,
    status,
    role,
    preCutover,
    postCutover,
    sourceKind: String(trade?.sourceKind || trade?.source || "broker-import"),
    asset: String(trade?.asset || trade?.symbol || trade?.quoteSymbol || instrumentId.split(":")[1] || "未标资产"),
    fundCode: String(trade?.fundCode || trade?.fund_code || "").trim(),
    feeMinor: trade?.feeMinor,
    feeAccuracy: String(trade?.feeAccuracy || ""),
    grossMinor: trade?.grossMinor,
    netCashMinor: trade?.netCashMinor,
    executionCoverageComplete: Boolean(trade?.executionCoverageComplete),
    sequenceAccuracy: String(trade?.sequenceAccuracy || ""),
    executedAt: String(trade?.executedAt || ""),
    raw: trade,
  };
}

const rowForTrade = (rows, trade) => rows.find((row) => {
  const identity = operationIdentityParts(row);
  return !isCash(row)
    && identity.account === trade.account
    && identity.instrumentId === trade.instrumentId
    && identity.currency === trade.currency;
});

const cashRowsForTrade = (rows, trade) => rows.filter((row) => (
  isCash(row)
  && accountName(row.account) === trade.account
  && currencyOf(row) === trade.currency
));

const moneyFromMinor = (value) => Number(value) / 100;
const roundedCost = (value) => Math.round(value * PRICE_MICROS_SCALE) / PRICE_MICROS_SCALE;

const validExecutionTime = (trade) => (
  trade?.sequenceAccuracy === "exact"
  && trade?.executedAt
  && Number.isFinite(Date.parse(trade.executedAt))
);

export function ambiguousSameDayTradeIds(trades = []) {
  const normalized = trades.map((trade) => trade?.role ? trade : classifyImportedTrade(trade));
  const groups = new Map();
  normalized.forEach((trade) => {
    if (!trade.tradeDate || !trade.account || !trade.instrumentId || !["buy", "sell"].includes(trade.side)) return;
    const key = `${trade.account}|${trade.instrumentId}|${trade.currency}|${trade.tradeDate}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  });
  const ambiguous = new Set();
  groups.forEach((group) => {
    if (new Set(group.map((trade) => trade.side)).size < 2) return;
    const exactTimes = group.filter(validExecutionTime).map((trade) => trade.executedAt);
    if (exactTimes.length !== group.length || new Set(exactTimes).size !== group.length) {
      group.forEach((trade) => ambiguous.add(trade.id));
    }
  });
  return [...ambiguous];
}

const orderedBrokerTrades = (trades = []) => trades
  .map((trade) => trade?.role ? trade : classifyImportedTrade(trade))
  .sort((a, b) => (
    a.tradeDate.localeCompare(b.tradeDate)
    || String(a.executedAt || "").localeCompare(String(b.executedAt || ""))
    || a.id.localeCompare(b.id)
  ));

/** Apply canonical broker fills to a cloned row set. No DOM and no persistence. */
export function applyBrokerTradesToRows(rows = [], trades = [], { metadataRows = rows } = {}) {
  const originalRows = rows.map(normalizedRow);
  const nextRows = originalRows.map((row) => ({ ...row }));
  const templates = metadataRows.map(normalizedRow);
  const errors = [];
  const appliedIds = [];
  const orderedTrades = orderedBrokerTrades(trades);
  const ambiguousIds = ambiguousSameDayTradeIds(orderedTrades);
  if (ambiguousIds.length) {
    return {
      ok: false,
      rows: originalRows,
      errors: ambiguousIds.map((id) => ({ id, reason: "同日买卖缺少唯一的精确执行顺序" })),
      appliedIds: [],
    };
  }
  for (const trade of orderedTrades) {
    const rawTrade = trade.raw || trade;
    if (trade.role === "invalid" || !["buy", "sell"].includes(trade.side)) {
      errors.push({ id: trade.id, reason: "成交字段不完整" });
      continue;
    }
    const quantityUnits = Math.abs(Math.round(Number(trade.quantityUnits || 0)));
    const quantity = quantityFromUnits(quantityUnits);
    const unitPrice = Number(trade.unitPrice);
    const grossMinor = Number(trade.grossMinor ?? rawTrade?.grossMinor);
    const feeMinor = Number(trade.feeMinor ?? rawTrade?.feeMinor ?? 0);
    const netCashMinor = Number(trade.netCashMinor ?? rawTrade?.netCashMinor);
    if (!quantityUnits || !Number.isFinite(unitPrice) || unitPrice <= 0
      || !Number.isInteger(grossMinor) || grossMinor <= 0
      || !Number.isInteger(feeMinor) || feeMinor < 0
      || !Number.isInteger(netCashMinor)) {
      errors.push({ id: trade.id, reason: "成交数量、价格或净现金非法" });
      continue;
    }
    let position = rowForTrade(nextRows, trade);
    if (!position && trade.side === "buy") {
      const template = rowForTrade(templates, trade);
      if (template) {
        position = { ...template, quantity: 0, costPrice: 0 };
        nextRows.push(position);
      }
    }
    if (!position) {
      errors.push({ id: trade.id, reason: trade.side === "buy" ? "新标的缺少类型/风险倍率元数据" : "未找到可卖出持仓" });
      continue;
    }
    const cashMatches = cashRowsForTrade(nextRows, trade);
    if (cashMatches.length !== 1) {
      errors.push({
        id: trade.id,
        reason: cashMatches.length
          ? `${trade.account} ${trade.currency} 存在重复现金行`
          : `缺少 ${trade.account} ${trade.currency} 现金行`,
      });
      continue;
    }
    const cash = cashMatches[0];
    const beforeUnits = quantityToUnits(position.quantity);
    if (trade.side === "sell" && quantityUnits > beforeUnits) {
      errors.push({ id: trade.id, reason: "卖出数量超过持仓" });
      continue;
    }
    const currentCashMinor = Math.round(numberValue(cash.quantity) * MONEY_MINOR_SCALE);
    const nextCashMinor = currentCashMinor + netCashMinor;
    if (!Number.isSafeInteger(currentCashMinor) || currentCashMinor < 0
      || !Number.isSafeInteger(nextCashMinor) || nextCashMinor < 0) {
      errors.push({ id: trade.id, reason: `${trade.account} ${trade.currency} 成交后现金不能为负` });
      continue;
    }
    if (trade.side === "buy") {
      const beforeQty = quantityFromUnits(beforeUnits);
      const afterUnits = beforeUnits + quantityUnits;
      const totalCost = beforeQty * numberValue(position.costPrice) + moneyFromMinor(grossMinor + feeMinor);
      position.quantity = quantityFromUnits(afterUnits);
      position.costPrice = roundedCost(totalCost / position.quantity);
    } else {
      position.quantity = quantityFromUnits(beforeUnits - quantityUnits);
    }
    cash.quantity = nextCashMinor / MONEY_MINOR_SCALE;
    appliedIds.push(trade.id);
  }
  nextRows.filter(isCash).forEach((row) => {
    const minor = Math.round(numberValue(row.quantity) * MONEY_MINOR_SCALE);
    if (!Number.isSafeInteger(minor) || minor < 0) {
      errors.push({ id: "", reason: `${accountName(row.account)} ${currencyOf(row)} 现金不能为负` });
    }
  });
  return errors.length
    ? { ok: false, rows: originalRows, errors, appliedIds: [] }
    : { ok: true, rows: nextRows, errors, appliedIds };
}

const decimalPlaces = (value) => {
  const text = String(value ?? "");
  return text.includes(".") ? text.split(".")[1].length : 0;
};

const accountStateMatches = (actualRows, expectedRows, account, cashToleranceMinor) => {
  const actual = actualRows.filter((row) => accountName(row.account) === account);
  const expected = expectedRows.filter((row) => accountName(row.account) === account);
  const stateKey = (row) => isCash(row) ? `cash|${cashKey(row)}` : `position|${operationRowKey(row)}`;
  const indexRows = (items) => {
    const indexed = new Map();
    for (const row of items) {
      const key = stateKey(row);
      if (indexed.has(key)) return null;
      indexed.set(key, row);
    }
    return indexed;
  };
  const actualByKey = indexRows(actual);
  const expectedByKey = indexRows(expected);
  if (!actualByKey || !expectedByKey) return false;
  const keys = new Set([...actualByKey.keys(), ...expectedByKey.keys()]);
  for (const key of keys) {
    const a = actualByKey.get(key);
    const e = expectedByKey.get(key);
    if (isCash(a || e)) {
      if (Math.abs(Math.round(numberValue(a?.quantity) * 100) - Math.round(numberValue(e?.quantity) * 100)) > cashToleranceMinor) return false;
      continue;
    }
    if (quantityToUnits(a?.quantity) !== quantityToUnits(e?.quantity)) return false;
    if (quantityToUnits(a?.quantity) > 0) {
      const digits = decimalPlaces(a?.costPrice);
      if (Number(numberValue(e?.costPrice).toFixed(digits)) !== Number(numberValue(a?.costPrice).toFixed(digits))) return false;
    }
  }
  return true;
};

/** Find the unique mail prefix already absorbed by current rows. */
export function reconcileBrokerActivation(snapshotRows = [], currentRows = [], trades = [], { cashToleranceMinor = 1 } = {}) {
  const normalizedTrades = trades.map((trade) => classifyImportedTrade(trade));
  const decisions = {};
  const errors = [];
  const accounts = [...new Set(normalizedTrades.map((trade) => trade.account))];
  accounts.forEach((account) => {
    const accountTrades = normalizedTrades.filter((trade) => trade.account === account).sort((a, b) => (
      a.tradeDate.localeCompare(b.tradeDate)
      || String(a.raw?.executedAt || "").localeCompare(String(b.raw?.executedAt || ""))
      || a.id.localeCompare(b.id)
    ));
    const mixedWithoutTime = new Set(ambiguousSameDayTradeIds(accountTrades));
    if (mixedWithoutTime.size) {
      accountTrades.forEach((trade) => {
        decisions[trade.id] = mixedWithoutTime.has(trade.id) ? "review_required" : "accepted";
      });
      errors.push({ account, reason: "同日买卖缺少精确执行顺序" });
      return;
    }
    const matches = [];
    for (let prefix = 0; prefix <= accountTrades.length; prefix += 1) {
      const simulated = applyBrokerTradesToRows(snapshotRows, accountTrades.slice(0, prefix), { metadataRows: currentRows });
      if (simulated.ok && accountStateMatches(currentRows, simulated.rows, account, cashToleranceMinor)) matches.push(prefix);
    }
    if (matches.length !== 1) {
      accountTrades.forEach((trade) => { decisions[trade.id] = "review_required"; });
      errors.push({ account, reason: matches.length ? "存在多个可能的已吸收前缀" : "邮件成交无法唯一重建当前仓位/现金" });
      return;
    }
    accountTrades.forEach((trade, index) => { decisions[trade.id] = index < matches[0] ? "accepted" : "applied"; });
  });
  return { ok: errors.length === 0, decisions, errors };
}

export function listBrokerImportTrades(ledgerOrTrades = null, cutovers = null) {
  const ledger = ledgerOrTrades && !Array.isArray(ledgerOrTrades) && typeof ledgerOrTrades === "object" && (ledgerOrTrades.trades || ledgerOrTrades.cutovers)
    ? ledgerOrTrades
    : null;
  const trades = ledger ? ledger.trades : ledgerOrTrades;
  const resolvedCutovers = cutovers ?? ledger?.cutovers ?? [];
  return asObjectList(trades).map((trade) => classifyImportedTrade(trade, resolvedCutovers));
}

const importEventFromTrade = (trade, { role = trade.role, replaceInferred = false } = {}) => {
  const kind = trade.side;
  const full = false;
  const quantity = trade.quantity;
  const exact = trade.accuracy === "exact" && trade.unitPrice != null && trade.unitPrice > 0;
  const estimated = trade.accuracy === "estimated";
  const pendingSettlement = role === "pending";
  const unresolved = role === "unresolved" || pendingSettlement;
  const priceStatus = exact ? "exact" : estimated ? "estimated" : "pending";
  const lotEligible = role === "canonical" && exact && kind === "buy" && trade.unitPrice != null && trade.unitPrice > 0;
  const title = kind === "buy"
    ? (accountName(trade.account) === "支付宝基金" ? "申购" : "买入")
    : (accountName(trade.account) === "支付宝基金" ? "赎回" : "卖出");
  const badge = pendingSettlement
    ? "待结算"
    : unresolved
      ? "待对账证据"
      : trade.sourceKind === "manual:owner-confirmed-trade"
        ? `手工确认成交${exact ? "" : estimated ? "（价格估算）" : "（价格待核实）"}`
        : exact
          ? "邮件精确成交"
          : "邮件推算成交";
  const id = `import|${trade.id || `${trade.tradeDate}|${trade.account}|${trade.instrumentId}|${kind}|${trade.quantityUnits}`}`;
  const rowKey = [trade.account, trade.instrumentId, trade.currency].join("|");
  const moneyMeta = [
    Number.isInteger(Number(trade.grossMinor)) ? `成交额 ${(Number(trade.grossMinor) / 100).toFixed(2)}` : "",
    Number.isInteger(Number(trade.feeMinor)) ? `费用 ${(Number(trade.feeMinor) / 100).toFixed(2)}${trade.feeAccuracy === "estimated" ? "(估)" : ""}` : "",
    Number.isInteger(Number(trade.netCashMinor)) ? `净现金 ${(Number(trade.netCashMinor) / 100).toFixed(2)}` : "",
  ].filter(Boolean).join(" · ");
  return {
    id,
    eventKey: id,
    instrumentId: trade.instrumentId,
    rowKey,
    positionKey: rowKey,
    account: trade.account,
    asset: trade.asset,
    fundCode: trade.fundCode,
    date: trade.tradeDate,
    effectiveDate: trade.tradeDate,
    kind,
    system: accountName(trade.account) === "支付宝基金" ? "alipay" : "broker",
    priceCurrency: trade.currency,
    lotId: lotEligible ? `import-lot|${trade.id || id}` : null,
    pendingConfirmation: false,
    provisional: false,
    chartable: Boolean(trade.tradeDate && trade.unitPrice != null && trade.unitPrice > 0 && trade.currency),
    lotEligible,
    tone: "neutral",
    title,
    label: `${trade.account} · ${trade.asset}`,
    quantityDelta: kind === "buy" ? quantity : -quantity,
    addedQuantity: kind === "buy" ? quantity : 0,
    soldQuantity: kind === "sell" ? quantity : 0,
    positionClosed: false,
    unitPrice: trade.unitPrice,
    priceStatus,
    exact,
    endingAverageCost: null,
    estimated: Boolean(estimated && !exact),
    includesEstimatedSnapshot: false,
    addedCost: lotEligible ? {
      quantityDelta: quantity,
      totalCost: quantity * trade.unitPrice,
      unitCost: trade.unitPrice,
    } : null,
    realizedUsd: null,
    realizedNative: null,
    realizedEvidence: false,
    source: "broker-import",
    sourceKind: trade.sourceKind,
    settlementStatus: trade.settlementStatus || "",
    accuracy: trade.accuracy,
    coverageComplete: trade.coverageComplete,
    unresolved,
    pendingSettlement,
    evidenceOnly: unresolved,
    replaceInferred: Boolean(replaceInferred),
    quantityUnits: trade.quantityUnits,
    meta: `${badge} · ${kind === "buy" ? "买入" : "卖出"} ${quantity} @ ${trade.unitPrice != null ? trade.unitPrice : "价格未知"} ${trade.currency}${moneyMeta ? ` · ${moneyMeta} ${trade.currency}` : ""}`,
  };
};

const intervalKey = (operation) => [
  operation.account || "",
  operation.instrumentId || "",
  operation.priceCurrency || operation.currency || "",
  operation.previousDate || operation.dayPreviousDate || "",
  operation.date || "",
].join("|");

const signedUnits = (operation) => {
  if (Number.isFinite(Number(operation.quantityUnits))) {
    return operation.kind === "sell" ? -Math.abs(Math.round(Number(operation.quantityUnits))) : Math.abs(Math.round(Number(operation.quantityUnits)));
  }
  if (operation.kind === "buy") return quantityToUnits(operation.addedQuantity || operation.quantityDelta || 0);
  return -quantityToUnits(operation.soldQuantity || Math.abs(operation.quantityDelta || 0));
};

export const isExactPriceEvent = (event) => Boolean(
  event?.priceStatus === "exact" || event?.exact === true || event?.accuracy === "exact",
);

export const isEstimatedPriceEvent = (event) => Boolean(
  event?.priceStatus === "estimated" || event?.accuracy === "estimated" || event?.estimated === true,
);

export const isUnresolvedPriceEvent = (event) => Boolean(
  event?.unresolved === true
  || event?.role === "unresolved"
  || event?.priceStatus === "pending"
  || event?.settlementStatus === "pending",
);

/** Merge brokerImportLedger trades into inferred operation days. */
export function mergeBrokerImportIntoDays(days = [], options = {}) {
  const ledger = options.brokerImportLedger || options.ledger || null;
  const trades = listBrokerImportTrades(ledger?.trades ?? options.trades ?? ledger, ledger?.cutovers ?? options.cutovers ?? []);
  if (!trades.length) return days;

  const usable = trades.filter((trade) => trade.role !== "invalid");
  const consumed = new Set();
  const nextDays = days.map((day) => {
    const previousDate = day.previousDate || "";
    const date = day.date || "";
    const kept = [];
    const replacements = [];
    const byIdentity = new Map();
    (day.operations || []).forEach((operation) => {
      const key = [
        accountName(operation.account),
        operation.instrumentId || "",
        operation.priceCurrency || "",
        previousDate,
        date,
      ].join("|");
      if (!byIdentity.has(key)) byIdentity.set(key, []);
      byIdentity.get(key).push(operation);
    });

    byIdentity.forEach((ops, key) => {
      const [account, instrumentId, currency] = key.split("|");
      const inferredNet = ops.reduce((sum, op) => sum + signedUnits(op), 0);
      const candidates = usable.filter((trade) => {
        if (consumed.has(trade.id)) return false;
        if (trade.account !== account || trade.instrumentId !== instrumentId || trade.currency !== currency) return false;
        if (!trade.tradeDate) return false;
        // Trade belongs to snapshot interval (prev, current].
        if (previousDate && trade.tradeDate <= previousDate) return false;
        if (date && trade.tradeDate > date) return false;
        return true;
      });
      const exactCandidates = candidates.filter((trade) => trade.role === "canonical" && trade.accuracy === "exact");
      const candidateNet = exactCandidates.reduce((sum, trade) => sum + (trade.side === "buy" ? trade.quantityUnits : -trade.quantityUnits), 0);
      const allCovered = exactCandidates.length > 0 && exactCandidates.every((trade) => trade.coverageComplete || trade.postCutover);
      // Replacement requires exact integer net equality and complete coverage (post-cutover settled counts as covered live).
      const canReplace = exactCandidates.length > 0
        && candidateNet === inferredNet
        && exactCandidates.every((trade) => trade.coverageComplete || (trade.postCutover && (trade.settlementStatus === "settled" || !trade.settlementStatus)));

      if (canReplace) {
        exactCandidates.forEach((trade) => {
          consumed.add(trade.id);
          replacements.push(importEventFromTrade(trade, { role: "canonical", replaceInferred: true }));
        });
        // Drop inferred ops in this identity/interval.
        return;
      }
      // Incomplete: keep inference; mark matching imports unresolved for evidence if they were candidates.
      ops.forEach((op) => kept.push(op));
      candidates.forEach((trade) => {
        if (consumed.has(trade.id)) return;
        if (trade.role === "canonical" && trade.accuracy === "exact" && !trade.coverageComplete && !trade.postCutover) {
          // incomplete coverage pre-cutover remains unresolved evidence
          consumed.add(trade.id);
          replacements.push(importEventFromTrade(trade, { role: "unresolved" }));
        }
      });
    });

    // Operations without grouping handled above all went through byIdentity; ensure empty-ops days stay valid.
    const operations = [...kept, ...replacements];
    if (!operations.length) return null;
    return { ...day, operations };
  }).filter(Boolean);

  // Residual trades: zero-net T, post-cutover live, pending markers, unresolved evidence not tied to a replaced interval.
  const residualByDate = new Map();
  usable.forEach((trade) => {
    if (consumed.has(trade.id)) return;
    if (trade.role === "invalid") return;
    const role = trade.role === "canonical" && trade.accuracy !== "exact" && trade.accuracy !== "estimated"
      ? "canonical"
      : trade.role;
    // Pre-cutover without complete coverage stays unresolved; post-cutover settled/pending/unresolved as classified.
    const event = importEventFromTrade(trade, {
      role: trade.role === "canonical" && !trade.coverageComplete && trade.preCutover ? "unresolved" : trade.role,
    });
    if (!residualByDate.has(trade.tradeDate)) residualByDate.set(trade.tradeDate, []);
    residualByDate.get(trade.tradeDate).push(event);
    consumed.add(trade.id);
  });

  residualByDate.forEach((operations, date) => {
    const existing = nextDays.find((day) => day.date === date);
    if (existing) {
      existing.operations = [...existing.operations, ...operations];
      return;
    }
    const lifecycleOrder = Math.max(0, ...nextDays.map((day) => numberValue(day.lifecycleOrder, 0))) + 1;
    nextDays.push({
      date,
      previousDate: "",
      effectiveDate: date,
      pendingConfirmation: false,
      provisional: false,
      usdCny: numberValue(options.usdCny, 7.1),
      operations,
      realizedKnown: false,
      realizedUsd: 0,
      realizedCny: 0,
      tone: "neutral",
      lifecycleOrder,
      importOnly: true,
    });
  });

  return nextDays.sort((a, b) => String(a.date).localeCompare(String(b.date)) || numberValue(a.lifecycleOrder, 0) - numberValue(b.lifecycleOrder, 0));
}

export function deriveOperationDays(snapshots = [], { system = "", ...options } = {}) {
  const ordered = [...snapshots].filter((item) => item?.date).sort((a, b) => a.date.localeCompare(b.date));
  const days = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const day = inferOperationDay(ordered[index - 1], ordered[index], options);
    if (!day) continue;
    // Attach previousDate onto operations for merge interval matching.
    day.operations = (day.operations || []).map((operation) => ({
      ...operation,
      previousDate: day.previousDate || ordered[index - 1]?.date || "",
      quantityUnits: Math.abs(signedUnits(operation)),
    }));
    if (!system) {
      days.push({ ...day, lifecycleOrder: index });
      continue;
    }
    const operations = day.operations.filter((item) => item.system === system);
    if (!operations.length) continue;
    const realized = operations.filter((item) => item.realizedEvidence && Number.isFinite(item.realizedUsd));
    const realizedUsd = realized.reduce((sum, item) => sum + item.realizedUsd, 0);
    days.push({
      ...day,
      lifecycleOrder: index,
      system,
      operations,
      realizedKnown: realized.length > 0,
      realizedUsd,
      realizedCny: system === "alipay"
        ? realized.reduce((sum, item) => sum + numberValue(item.realizedNative), 0)
        : realizedUsd * day.usdCny,
      tone: realized.length ? tone(realizedUsd) : "neutral",
    });
  }
  return mergeBrokerImportIntoDays(days, options);
}

export function deriveInferredCostLots(days = [], currentRows = [], { system = "", includeClosed = false, includePending = false } = {}) {
  const current = rowsByKey(currentRows.filter((row) => !isCash(row) && (!system || operationSystemForRow(row) === system)));
  const records = days.flatMap((day, dayIndex) => (day.operations || []).map((operation, operationIndex) => ({
    day,
    dayIndex,
    operation,
    operationIndex,
    lifecycleOrder: Number.isFinite(Number(day.lifecycleOrder)) ? Number(day.lifecycleOrder) : null,
  }))).sort((a, b) => {
    if (a.lifecycleOrder !== null && b.lifecycleOrder !== null && a.lifecycleOrder !== b.lifecycleOrder) return a.lifecycleOrder - b.lifecycleOrder;
    const dateOrder = String(a.day.date || "").localeCompare(String(b.day.date || ""));
    return dateOrder || a.dayIndex - b.dayIndex || a.operationIndex - b.operationIndex;
  });
  const lastFullClose = new Map();
  records.forEach((record, sequence) => {
    record.sequence = sequence;
    const { operation } = record;
    if (operation.kind === "sell" && operation.positionClosed) {
      lastFullClose.set(operation.rowKey, {
        sequence,
        provisional: Boolean(operation.pendingConfirmation || operation.provisional),
      });
    }
  });
  const lots = [];
  records.forEach(({ day, operation, sequence, lifecycleOrder }) => {
    if (operation.kind !== "buy" || (system && operation.system !== system)) return;
    if (operation.lotEligible === false && !includePending) return;
    if (operation.pendingConfirmation && !includePending && operation.lotEligible === false) return;
    if (!Number.isFinite(Number(operation.addedQuantity)) || Number(operation.addedQuantity) <= OPERATION_EPSILON) return;
    const closingEvent = lastFullClose.get(operation.rowKey);
    const lifecycleClosed = Boolean(closingEvent && closingEvent.sequence > sequence);
    const currentRow = lifecycleClosed ? null : current.get(operation.rowKey);
    const closed = lifecycleClosed || !currentRow || numberValue(currentRow.quantity) <= OPERATION_EPSILON;
    if (!includeClosed && closed) return;
    const unitCost = numberValue(operation.addedCost?.unitCost) > 0 ? numberValue(operation.addedCost.unitCost) : null;
    const currentPrice = numberValue(currentRow?.marketPrice) > 0 ? numberValue(currentRow.marketPrice) : null;
    const lotDate = operation.effectiveDate || day.effectiveDate || day.date;
    lots.push({
      id: operation.lotId || `${lotDate}|${operation.rowKey}`,
      sourceEventId: operation.id || `${day.date}|${operation.rowKey}|buy`,
      instrumentId: operation.instrumentId || operationInstrumentId(currentRow || operation),
      positionKey: operation.rowKey,
      date: lotDate,
      lifecycleOrder,
      system: operation.system,
      account: operation.account || accountName(currentRow?.account) || "未标账户",
      asset: operation.asset || String(currentRow?.asset || "未标资产"),
      currency: operation.priceCurrency || currencyOf(currentRow),
      priceCurrency: operation.priceCurrency || currencyOf(currentRow),
      title: operation.title,
      quantity: operation.addedQuantity,
      addedQuantity: operation.addedQuantity,
      unitCost,
      endingAverageCost: numberValue(operation.endingAverageCost) > 0 ? numberValue(operation.endingAverageCost) : null,
      currentQuantity: numberValue(currentRow?.quantity),
      currentAverageCost: numberValue(currentRow?.costPrice) > 0 ? numberValue(currentRow.costPrice) : null,
      currentPrice,
      priceDifference: currentPrice != null && unitCost != null ? currentPrice / unitCost - 1 : null,
      estimated: Boolean(operation.estimated || operation.includesEstimatedSnapshot),
      pendingConfirmation: Boolean(operation.pendingConfirmation || operation.provisional),
      closureProvisional: Boolean(lifecycleClosed && closingEvent.provisional),
      closed,
      exact: operation.priceStatus === "exact",
      priceStatus: operation.priceStatus || (operation.addedCost ? "inferred" : "pending"),
      source: operation.source || "snapshot-inferred",
      unresolved: Boolean(operation.unresolved || operation.evidenceOnly),
    });
  });
  return lots.sort((a, b) => b.date.localeCompare(a.date) || numberValue(b.lifecycleOrder, -1) - numberValue(a.lifecycleOrder, -1));
}

export function groupInferredCostLots(lots = []) {
  const groups = new Map();
  lots.forEach((lot) => {
    if (!groups.has(lot.positionKey)) groups.set(lot.positionKey, {
      key: lot.positionKey,
      system: lot.system,
      account: lot.account,
      asset: lot.asset,
      currency: lot.currency,
      currentQuantity: lot.currentQuantity,
      currentAverageCost: lot.currentAverageCost,
      currentPrice: lot.currentPrice,
      lots: [],
    });
    groups.get(lot.positionKey).lots.push(lot);
  });
  return [...groups.values()].sort((a, b) => `${a.account}|${a.asset}`.localeCompare(`${b.account}|${b.asset}`, "zh-Hans-CN"));
}
