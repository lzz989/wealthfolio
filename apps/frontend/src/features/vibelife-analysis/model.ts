import type { AccountValuation, ActivityDetails } from "@/lib/types";
import { buildUsEquityCalendar } from "./legacy/us-market-calendar.js";
import { formatZonedDateKey } from "@/features/spending/lib/timezone";

export const START_DATE = "2026-03-20";
export type Marker = { id: string; date: string; type: "B" | "S" | "T"; symbol: string; details?: { side: string; quantity: number | string | null; price: number | string | null; currency: string; feeAccuracy: string }[] };
export type AnalysisPoint = {
  date: string; total: number | null; netFunding: number | null; profit: number | null;
  dailyProfit: number | null; dailyRate: number | null; estimated: boolean; dailyEstimated?: boolean; markers: Marker[];
  qqq?: number | null; qqqProfit?: number | null; costBasis?: number | null; reason?: string;
  basisDate?: string | null; priceDates?: string[];
};

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const dayOf = (value: Date | string, timezone: string) => {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? "" : formatZonedDateKey(instant, timezone);
};

/** The native aggregate reports gross account transfers, never treat those as scope cash flow. */
export function nativePoints(valuations: AccountValuation[], activities: ActivityDetails[], timezone = "UTC"): AnalysisPoint[] {
  const markers = new Map<string, Marker[]>();
  const pairs = new Map<string, Set<string>>();
  const posted = activities.filter((a) => a.status === "POSTED" && !a.needsReview);
  for (const a of posted) {
    if (a.activityType !== "BUY" && a.activityType !== "SELL") continue;
    const key = [dayOf(a.date, timezone), a.accountId, a.assetId, a.currency].join("|");
    const types = pairs.get(key) || new Set<string>();
    types.add(a.activityType); pairs.set(key, types);
  }
  const paired = new Map<string, Marker>();
  for (const a of posted) {
    const key = [dayOf(a.date, timezone), a.accountId, a.assetId, a.currency].join("|");
    const isPair = (a.activityType === "BUY" || a.activityType === "SELL") &&
      pairs.get(key)?.size === 2 && Boolean(a.accountId && a.assetId && a.currency);
    const type = isPair ? "T" : a.activityType === "BUY" ? "B" : a.activityType === "SELL" ? "S" : null;
    const date = dayOf(a.date, timezone);
    if (!type || !date) continue;
    const detail = { side: a.activityType === "BUY" ? "B" : "S", quantity: a.quantity, price: a.unitPrice, currency: a.currency || "", feeAccuracy: "unknown" };
    const previous = isPair ? paired.get(key) : undefined;
    if (previous) { previous.details?.push(detail); continue; }
    const marker: Marker = { id: a.id, date, type, symbol: a.assetSymbol || "", details: [detail] };
    if (isPair) paired.set(key, marker);
    markers.set(date, [...(markers.get(date) || []), marker]);
  }
  const byDate = new Map<string, AccountValuation>();
  for (const v of valuations) {
    const date = dayOf(v.valuationDate, timezone);
    if (date && (!byDate.has(date) || String(v.calculatedAt) > String(byDate.get(date)?.calculatedAt))) byDate.set(date, v);
  }
  return [...new Set([...byDate.keys(), ...markers.keys()])].sort().map((date) => {
    const v = byDate.get(date);
    return {
    date, total: v?.valueStatus === "complete" && finite(v.totalValueBase) ? v.totalValueBase : null,
    netFunding: null, profit: null, dailyProfit: null, dailyRate: null, estimated: false,
    markers: markers.get(date) || [],
  }; });
}

/** Derive daily results only for adjacent known US sessions with a verified external flow. */
export function provenDaily(points: AnalysisPoint[], flows: Record<string, number | null>): AnalysisPoint[] {
  if (!points.length) return [];
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const calendar = buildUsEquityCalendar({ startDate: sorted[0].date, endDate: sorted.at(-1)!.date });
  const sessions = calendar.marketSessions as string[];
  return sorted.map((p, i) => {
    const prev = sorted[i - 1], flow = flows[p.date];
    const adjacent = prev && sessions.indexOf(p.date) > 0 && sessions[sessions.indexOf(p.date) - 1] === prev.date;
    if (!adjacent || p.estimated || prev.estimated || !finite(p.total) || !finite(prev.total) || !finite(flow) || prev.total <= 0)
      return { ...p, dailyProfit: null, dailyRate: null };
    const dailyProfit = p.total - prev.total - flow;
    return { ...p, dailyProfit, dailyRate: dailyProfit / prev.total };
  });
}
