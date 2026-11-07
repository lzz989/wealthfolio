import { buildPerformanceAnalysis } from "./legacy/performance-analysis.js";
import { buildPerformanceTradeDays } from "./legacy/performance-trades.js";

// In-memory projection only; never saves the legacy ledger or promotes estimates.
export function analyzeArchive(input) {
  const report = buildPerformanceAnalysis(input);
  const trades = buildPerformanceTradeDays({ brokerImportLedger: input.data?.brokerImportLedger, dcaSyncLedger: input.data?.dcaSyncLedger });
  return projectArchive(report, trades);
}

export function projectArchive(report, trades) {
  const byDate = new Map(trades.days.map((day) => [day.date, day]));
  const markers = (date) => (byDate.get(date)?.groups || []).map((group) => ({
    id: group.key, date, type: group.label, symbol: group.asset,
    details: group.trades.map((trade) => ({ side: trade.label, quantity: trade.quantity, price: trade.unitPrice, currency: trade.currency, feeAccuracy: trade.feeAccuracy }))
  }));
  const points = report.points.map((point, index) => ({ date: point.date, total: point.totalUsd,
    netFunding: point.netContributionsUsd, costBasis: point.costBasisUsd, profit: point.returnUsd, qqq: point.qqqEquityUsd,
    qqqProfit: point.qqqProfitUsd, dailyProfit: point.dailyProfitUsd, dailyRate: point.dailyReturnRate,
    estimated: point.estimated, dailyEstimated: point.dailyProfitUsd != null && Boolean(point.estimated || report.points[index - 1]?.estimated),
    basisDate: point.referenceBasisDate || point.checkpointDate || (point.displayHistoryOrigin === "saved-reference-estimate" ? point.date : null),
    priceDates: [...new Set([...(point.displayNavAsOf || []), ...(point.displayFxAsOf || [])].map((entry) => entry.date).filter(Boolean))],
    reason: point.reason, markers: markers(point.date) }));
  const valuedDates = new Set(points.map((point) => point.date));
  for (const day of trades.days) if (!valuedDates.has(day.date)) points.push({ date: day.date, total: null,
    netFunding: null, costBasis: null, profit: null, qqq: null, qqqProfit: null, dailyProfit: null,
    dailyRate: null, estimated: false, dailyEstimated: false, basisDate: null, priceDates: [], reason: "当日估值不可用", markers: markers(day.date) });
  points.sort((a, b) => a.date.localeCompare(b.date));
  return { source: "VibeLife 历史参考", asOf: report.sourceUpdatedAt, currency: "USD", activities: trades.sourceCounts.broker,
    coverage: trades.coverageNote, benchmarkStatus: report.benchmark.status, issueCodes: report.issues.map((x) => x.code),
    points };
}
