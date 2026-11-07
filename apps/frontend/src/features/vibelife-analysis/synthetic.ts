// Synthetic data only, exposed in the dev build for isolated visual verification.
import { analyzeArchive } from "./legacy-adapter.js";
const cash = (quantity: number) => ({ account: "Synthetic", asset: "现金", currency: "USD", type: "cash", quantity, costPrice: "", marketPrice: "", riskMultiplier: 0 });
const position = { account: "Synthetic", asset: "SYNTH", currency: "USD", type: "risk", quantity: 100, costPrice: 100, marketPrice: 100, riskMultiplier: 1 };
const snap = (date: string, amount: number) => ({ date, rows: [cash(amount), position], estimated: false, source: "synthetic" });
const flow = (id: string, date: string, amountMinor: number) => ({ id, fingerprint: (id === "d" ? "a" : "b").repeat(64), status: "applied", account: "Synthetic", broker: "manual", flowDate: date, amountMinor, currency: "USD", kind: amountMinor > 0 ? "externalDeposit" : "externalWithdraw", principalDeltaCnyFen: amountMinor * 7, sourceKind: "synthetic:deposit" });
const trade = (id: string, side: string) => ({ id, status: "applied", account: "Synthetic", broker: "manual", instrumentId: "equity:SYNTH", asset: "SYNTH", side, tradeDate: "2026-03-24", quantityUnits: 1e8, priceMicros: 104e6, priceCurrency: "USD", accuracy: "exact", settlementStatus: "settled", coverageComplete: true, executionCoverageComplete: true, feeAccuracy: "exact", sequenceAccuracy: "estimated", grossMinor: 10400, feeMinor: 0, netCashMinor: side === "buy" ? -10400 : 10400 });
const data = { updatedAt: "2026-03-26T00:00:00Z", history: { dailySnapshots: [snap("2026-03-19", 0), snap("2026-03-23", 2000), snap("2026-03-24", 2000), snap("2026-03-25", 1500)] }, brokerImportLedger: { version: 1, cashFlows: { d: flow("d", "2026-03-23", 200000), w: flow("w", "2026-03-25", -50000) }, trades: { buy: trade("buy", "buy"), sell: trade("sell", "sell") }, statements: {}, cutovers: {}, principalBaselineCnyFen: 0 }, dcaSyncLedger: { records: {} }, funding: { brokerCnyDepositsTotal: 0 } };
export function syntheticPackage() {
  return { format: "vibelife-investment-analysis/1", source: "合成测试数据", throughDate: "2026-03-25", data,
    market: { SYNTH: { source: "synthetic", priceBasis: "unadjusted", currency: "USD", series: { "2026-03-20":100, "2026-03-23":103, "2026-03-24":104, "2026-03-25":106 } } },
    qqq: { adjusted: true, source: "synthetic", closes: { "2026-03-20":100, "2026-03-23":102, "2026-03-24":104, "2026-03-25":105 } } };
}
// Mirrors the existing reference-estimate engine test, using synthetic values only.
export function syntheticReferencePackage() {
  const pkg = syntheticPackage();
  const snapshot = (date: string, totalUsd: number, principalCny: number) => ({ date, estimated: true, totalUsd, principalCny, rows: [cash(totalUsd)], source: "synthetic" });
  const snapshots = [snapshot("2026-03-20",1000,7000), snapshot("2026-03-23",1610,10500), snapshot("2026-03-24",1770,10500)];
  return { ...pkg, throughDate: "2026-03-24", data: { ...pkg.data, history: { dailySnapshots: snapshots },
    state: { settings: { snapshotDate: "2026-03-25" }, rows: snapshots[2].rows },
    brokerImportLedger: { ...pkg.data.brokerImportLedger, cashFlows: {} } },
    market: { "CNY=X": { source: "synthetic", priceBasis: "reference-rate", currency: "CNY", series: { "2026-03-20":7, "2026-03-23":7, "2026-03-24":7 } } },
    qqq: { adjusted: true, source: "synthetic", closes: { "2026-03-20":100, "2026-03-23":110, "2026-03-24":120 } } };
}
export function syntheticAnalysis(throughDate = "2026-03-25") {
  return analyzeArchive({ data, throughDate, market: new Map([["SYNTH", { priceBasis: "unadjusted", currency: "USD", series: new Map([["2026-03-20",100],["2026-03-23",103],["2026-03-24",104],["2026-03-25",106]]) }]]), qqq: { adjusted: true, source: "synthetic", closes: new Map([["2026-03-20",100],["2026-03-23",102],["2026-03-24",104],["2026-03-25",105]]) } });
}
