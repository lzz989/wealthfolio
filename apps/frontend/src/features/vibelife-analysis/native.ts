import { getHistoricalValuations, searchActivities } from "@/adapters";
import type { AccountScope, ActivityDetails } from "@/lib/types";
import { nativePoints, START_DATE } from "./model";

/** Uses the app's authenticated profile-aware adapters; only read-only queries. */
export async function loadNativeAnalysis(scope: AccountScope, throughDate: string, timezone: string) {
  const filter = scope.type === "accounts" ? { accountIds: scope.accountIds }
    : scope.type === "account" ? { accountIds: [scope.accountId] } : {};
  const [valuations, first] = await Promise.all([
    getHistoricalValuations(scope, START_DATE, throughDate),
    scope.type === "portfolio" ? Promise.resolve(null) : searchActivities(0, 200, { ...filter, dateFrom: START_DATE, dateTo: throughDate }, ""),
  ]);
  if (!first) return { source: "Wealthfolio", asOf: valuations.at(-1)?.calculatedAt || null,
    currency: valuations.at(-1)?.baseCurrency || null, points: nativePoints(valuations, [], timezone), activities: null };
  const all: ActivityDetails[] = [...first.data];
  const pages = Math.ceil(first.meta.totalRowCount / 200);
  if (pages > 100) throw new Error("交易记录过多，请缩小查询范围后重试。");
  for (let page = 1; page < pages; page++) {
    const next = await searchActivities(page, 200, { ...filter, dateFrom: START_DATE, dateTo: throughDate }, "");
    if (next.meta.totalRowCount !== first.meta.totalRowCount) throw new Error("交易记录在读取时发生变化，请重试。");
    all.push(...next.data);
  }
  if (all.length !== first.meta.totalRowCount || all.some((x) => !x.id) || new Set(all.map((x) => x.id)).size !== all.length)
    throw new Error("交易记录未完整载入或发生变化，请重试。");
  return { source: "Wealthfolio", asOf: valuations.at(-1)?.calculatedAt || null,
    currency: valuations.at(-1)?.baseCurrency || null, points: nativePoints(valuations, all, timezone), activities: all.length };
}
