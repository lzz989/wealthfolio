import { analyzeArchive } from "./legacy-adapter.js";

const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Reads a user-selected analysis package in memory. No network, storage or ledger writes. */
export function analyzeHistoryPackage(text: string, reference = true) {
  if (text.length > 10_000_000) throw new Error("文件超过 10 MB 限制。");
  const pack: unknown = JSON.parse(text);
  if (!record(pack) || pack.format !== "vibelife-investment-analysis/1" || typeof pack.source !== "string" || !pack.source.trim() || pack.source.length > 120 || !date(pack.throughDate) || !record(pack.data) || !record(pack.market) || !record(pack.qqq)) throw new Error("分析包格式或来源、截止日期无效。");
  const history = pack.data.history;
  if (typeof pack.data.updatedAt !== "string" || Number.isNaN(Date.parse(pack.data.updatedAt))) throw new Error("分析包缺少有效的数据更新时间。");
  if (!record(history) || !Array.isArray(history.dailySnapshots) || history.dailySnapshots.some((s: unknown) => !record(s) || !date(s.date) || typeof s.estimated !== "boolean" || !Array.isArray(s.rows))) throw new Error("历史快照必须包含日期、持仓及明确的估算标记。");
  const market = new Map<string, unknown>();
  for (const [symbol, raw] of Object.entries(pack.market)) {
    if (!record(raw) || !record(raw.series) || typeof raw.priceBasis !== "string" || typeof raw.source !== "string" || !raw.source.trim()) throw new Error("历史行情缺少价格口径或来源。");
    if (Object.entries(raw.series).some(([day, price]) => !date(day) || typeof price !== "number" || !Number.isFinite(price) || price <= 0)) throw new Error("历史行情日期或价格无效。");
    market.set(symbol, { ...raw, series: new Map(Object.entries(raw.series)) });
  }
  if (typeof pack.qqq.adjusted !== "boolean" || typeof pack.qqq.source !== "string" || !pack.qqq.source.trim() || !record(pack.qqq.closes) || Object.entries(pack.qqq.closes).some(([day, price]) => !date(day) || typeof price !== "number" || !Number.isFinite(price) || price <= 0)) throw new Error("QQQ 行情缺少来源、复权标记或有效价格。");
  const result = analyzeArchive({ data: pack.data, throughDate: pack.throughDate, market, qqq: { ...pack.qqq, closes: new Map(Object.entries(pack.qqq.closes)) }, reference });
  return { ...result, source: `本地历史预览 · ${pack.source}` };
}
