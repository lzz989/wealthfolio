import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Area, CartesianGrid, ComposedChart, LabelList, Line, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from "recharts";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui";
import type { AccountScope } from "@/lib/types";
import { loadNativeAnalysis } from "./native";
import { buildUsEquityCalendar } from "./legacy/us-market-calendar.js";
import { START_DATE, type AnalysisPoint } from "./model";
import { useSettingsContext } from "@/lib/settings-provider";
import { formatZonedDateKey } from "@/features/spending/lib/timezone";
import { analyzeHistoryPackage } from "./archive-input";

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const money = (n: number | null, currency: string | null) => n == null ? "—" : new Intl.NumberFormat("zh-CN", { style: "currency", currency: currency || "USD", maximumFractionDigits: 2 }).format(n);
const calendarMoney = (n: number) => new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 2 }).format(n);
const monthShift = (month: string, offset: number) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 7);
};
const validTimezone = (timezone: string) => {
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); return Boolean(timezone); } catch { return false; }
};

export function InvestmentAnalysisView({ points, currency, asOf, activities, source = "Wealthfolio", coverage }: { points: AnalysisPoint[]; currency: string | null; asOf: string | null; activities: number | null; source?: string; coverage?: string }) {
  const [month, setMonth] = useState(() => (points.at(-1)?.date || today()).slice(0, 7));
  const [selected, setSelected] = useState<string | null>(null);
  const [range, setRange] = useState("ALL");
  const [metric, setMetric] = useState<"assets" | "profit">("assets");
  const first = `${month}-01`;
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const offset = new Date(`${first}T00:00:00Z`).getUTCDay();
  const byDate = new Map(points.map((point) => [point.date, point]));
  const end = points.at(-1)?.date || today();
  const start = range === "ALL" ? START_DATE : dayKey(new Date(Date.parse(`${end}T00:00:00Z`) - Number(range) * 86400000));
  const calendar = buildUsEquityCalendar({ startDate: start < START_DATE ? START_DATE : start, endDate: end });
  const chartDates = calendar.status === "ready" ? [...new Set([...calendar.marketSessions, ...points.map((p) => p.date)])].sort() : points.map((p) => p.date);
  const chartData = chartDates.filter((d) => d >= start && d <= end).map((date) => {
    const p = byDate.get(date);
    return { date, total: p?.total ?? null, netFunding: p?.netFunding ?? null, profit: p?.profit ?? null,
      qqq: p?.qqq ?? null, qqqProfit: p?.qqqProfit ?? null, markers: p?.markers || [], markLabel: (metric === "assets" ? p?.total : p?.profit) != null ? p?.markers.map(m => m.type).join("/") || "" : "",
      markValue: p?.markers.length ? (metric === "assets" ? p.total : p.profit) : null,
      estimateValue: p?.estimated ? (metric === "assets" ? p.total : p.profit) : null, estimateLabel: p?.estimated && (metric === "assets" ? p.total : p.profit) != null ? "估" : "" };
  });
  const chosen = selected ? byDate.get(selected) : undefined;
  const monthPoints = points.filter((p) => p.date.startsWith(month) && p.dailyProfit != null);
  const monthTotal = monthPoints.reduce((sum, p) => sum + (p.dailyProfit ?? 0), 0);
  const monthCalendar = buildUsEquityCalendar({ startDate: first, endDate: `${month}-${String(days).padStart(2,"0")}` });
  const monthSessions = new Set(monthCalendar.marketSessions);
  return <div className="space-y-5 pb-8" data-testid="vibelife-analysis">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div><h2 className="text-2xl font-semibold tracking-tight">投资分析</h2><p className="text-muted-foreground mt-1 text-sm">资产轨迹与交易日历 · 只读</p></div>
      <div className="text-muted-foreground text-xs">{source} {asOf ? `· 更新于 ${asOf.slice(0, 10)}` : "· 暂无估值时间"}</div>
    </div>
    <Card><CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between"><div><CardTitle>{metric === "assets" ? "资产与投入" : "累计收益"}</CardTitle><p className="text-muted-foreground mt-1 text-sm">按组合基准币种显示；缺失日期不会连线。</p></div>
      <div className="flex gap-1" aria-label="曲线时间范围">{[["30", "1月"], ["90", "3月"], ["365", "1年"], ["ALL", "全部"]].map(([v, label]) => <Button key={v} size="sm" variant={range === v ? "secondary" : "ghost"} onClick={() => setRange(v)}>{label}</Button>)}</div>
    </CardHeader><CardContent><div className="mb-3 flex gap-1"><Button size="sm" variant={metric === "assets" ? "secondary" : "ghost"} onClick={() => setMetric("assets")}>资产与投入</Button><Button size="sm" variant={metric === "profit" ? "secondary" : "ghost"} onClick={() => setMetric("profit")}>累计收益</Button></div><div className="h-64 w-full" role="img" aria-label="投资曲线">
      {chartData.some((p) => metric === "assets" ? p.total != null : p.profit != null) ? <ResponsiveContainer width="100%" height="100%"><ComposedChart data={chartData} margin={{ top: 12, right: 12, bottom: 0, left: 0 }} onClick={(state) => { const d = state?.activeLabel; if (typeof d === "string") { setMonth(d.slice(0,7)); setSelected(d); } }}><CartesianGrid vertical={false} strokeDasharray="3 4" /><XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} minTickGap={30} /><YAxis width={70} tickFormatter={(v: number) => new Intl.NumberFormat("zh-CN", { notation: "compact" }).format(v)} /><Tooltip formatter={(v) => money(typeof v === "number" ? v : null, currency)} /><Area type="monotone" dataKey={metric === "assets" ? "total" : "profit"} name={metric === "assets" ? "资产" : "累计收益"} fill="var(--chart-1)" fillOpacity={0.08} stroke="none" connectNulls={false} /><Line type="monotone" dataKey={metric === "assets" ? "total" : "profit"} name={metric === "assets" ? "资产" : "累计收益"} stroke="var(--chart-1)" strokeWidth={2} dot={false} connectNulls={false} /><Line type="monotone" dataKey={metric === "assets" ? "netFunding" : "qqqProfit"} name={metric === "assets" ? "净投入" : "QQQ 收益"} stroke="var(--chart-2)" strokeDasharray="4 3" dot={false} connectNulls={false} />{metric === "assets" && <Line type="monotone" dataKey="qqq" name="QQQ 资产" stroke="var(--chart-3)" dot={false} connectNulls={false} />}<Scatter dataKey="markValue" name="交易" fill="var(--chart-4)"><LabelList dataKey="markLabel" position="top" /></Scatter><Scatter dataKey="estimateValue" name="估算" fill="var(--chart-1)"><LabelList dataKey="estimateLabel" position="top" /></Scatter></ComposedChart></ResponsiveContainer> : <div className="text-muted-foreground flex h-full items-center justify-center text-sm">所选时间暂无可用数据</div>}
    </div><div className="text-muted-foreground mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs"><span>● {metric === "assets" ? "资产" : "累计收益"}</span><span>┄ {metric === "assets" ? "净投入" : "QQQ 收益"}</span>{metric === "assets" && <span>● QQQ 资产</span>}<span>点击曲线可查看当日交易</span>{!points.some(p => p.netFunding != null) && <span>净投入与累计收益：资金记录待核对</span>}{!points.some(p => p.qqq != null) && <span>QQQ 同资金流：期初、资金流或复权行情待核对</span>}</div></CardContent></Card>
    <Card><CardHeader className="flex flex-wrap flex-row items-center justify-between gap-2"><div><CardTitle>盈亏日历</CardTitle><p className="text-muted-foreground mt-1 text-sm">日末现金流口径 · {currency || "USD"} · 资料不足显示「—」。</p></div><div className="flex items-center gap-1"><Button variant="ghost" size="sm" aria-label="上个月" onClick={() => { setMonth(monthShift(month, -1)); setSelected(null); }}>‹</Button><span className="min-w-20 text-center text-sm font-medium">{month}</span><Button variant="ghost" size="sm" aria-label="下个月" onClick={() => { setMonth(monthShift(month, 1)); setSelected(null); }}>›</Button></div></CardHeader>
      <CardContent><div className="grid grid-cols-7 text-center text-xs text-muted-foreground">{["日", "一", "二", "三", "四", "五", "六"].map((d) => <div key={d} className="py-2">{d}</div>)}
      {Array.from({ length: offset }, (_, i) => <div key={`blank-${i}`} />)}{Array.from({ length: days }, (_, i) => {
        const date = `${month}-${String(i + 1).padStart(2, "0")}`, point = byDate.get(date);
        return <button key={date} type="button" aria-label={`${date} ${point?.dailyProfit == null ? "暂无日收益" : money(point.dailyProfit, currency)}`} aria-pressed={selected === date} onClick={() => setSelected(date)} className={`min-h-16 min-w-0 border-t p-1 text-start text-xs focus-visible:outline focus-visible:outline-2 ${selected === date ? "bg-muted" : "hover:bg-muted/50"}`}><span className="block font-medium">{i + 1}</span><span className="text-muted-foreground mt-1 block truncate">{point?.dailyProfit == null ? (monthCalendar.status === "ready" && !monthSessions.has(date) && !point?.markers.length ? "休市" : "—") : calendarMoney(point.dailyProfit)}</span><span className="text-muted-foreground block">{point?.estimated ? "估值 " : point?.dailyEstimated ? "估 " : ""}{point?.markers.map((x) => x.type).join(" ")}</span></button>;
      })}</div>
      <p className="text-muted-foreground mt-3 text-xs">本月已计算 {monthPoints.length}/{monthSessions.size || "—"} 个交易日{monthPoints.length ? ` · 已覆盖部分 ${money(monthTotal, currency)}${monthPoints.some(p => p.dailyEstimated) ? "（含估算）" : ""}` : " · 暂无可汇总日收益"}。{coverage || "资金流、估值或日期不完整时不计算日收益。"}</p>
      <div className="bg-muted/40 mt-4 rounded-lg p-3 text-sm" aria-live="polite">{selected ? <><div className="font-medium">{selected}</div><div className="text-muted-foreground mt-1">资产 {money(chosen?.total ?? null, currency)}{chosen?.estimated ? "（含估值）" : ""} · 日盈亏 {money(chosen?.dailyProfit ?? null, currency)}{chosen?.dailyEstimated ? "（含估）" : ""}{chosen?.dailyRate != null ? ` · ${(chosen.dailyRate * 100).toFixed(2)}%` : " · 收益率待核对"}</div>{(chosen?.basisDate || chosen?.priceDates?.length) ? <div className="text-muted-foreground mt-1">{chosen.basisDate ? `记录依据 ${chosen.basisDate}` : ""}{chosen.priceDates?.length ? ` · 行情日期 ${chosen.priceDates.join("、")}` : ""}</div> : null}<div className="text-muted-foreground mt-1">{chosen?.markers.length ? chosen.markers.map((x) => `${x.type} ${x.symbol}${x.details?.map(d => ` ${d.side} ${d.quantity ?? "—"} × ${d.price ?? "—"} ${d.currency}${d.feeAccuracy === "estimated" ? "（费用估算）" : ""}`).join(" · ") || ""}`).join(" · ") : "当日无可显示交易标记"}</div>{chosen?.reason && <div className="text-muted-foreground mt-1">{chosen.reason}</div>}</> : "选择一天查看资产、盈亏与交易标记。"}</div>
      {activities === null && <p className="text-muted-foreground mt-2 text-xs">当前组合的交易标记范围待核对。</p>}
    </CardContent></Card>
  </div>;
}

export function HistoryWorkspace({ children, fallbackLabel = "返回 Wealthfolio 数据" }: { children: ReactNode; fallbackLabel?: string }) {
  const [archive, setArchive] = useState<ReturnType<typeof analyzeHistoryPackage> | null>(null);
  const [archiveInput, setArchiveInput] = useState<string | null>(null);
  const [reference, setReference] = useState(true);
  const [reading, setReading] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const input = <div className="mb-4 space-y-2"><label className="inline-flex min-h-10 cursor-pointer items-center rounded-md border px-3 text-sm hover:bg-muted">打开本地历史分析包<input type="file" accept="application/json,.json" className="sr-only" onChange={async (event) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const token = ++generation.current;
    setArchive(null); setArchiveInput(null); setArchiveError(""); setReading(true); setReference(true);
    try {
      if (file.size > 10_000_000) throw new Error("文件超过 10 MB 限制。");
      const text = await file.text();
      if (token !== generation.current) return;
      setArchive(analyzeHistoryPackage(text, true)); setArchiveInput(text);
    } catch (error) { if (token === generation.current) setArchiveError(error instanceof SyntaxError ? "文件不是有效的 JSON。" : error instanceof Error ? error.message : "无法读取分析包。"); }
    finally { if (token === generation.current) setReading(false); }
  }} /></label>{(archive || reading || archiveError) && <Button variant="ghost" onClick={() => { generation.current++; setArchive(null); setArchiveInput(null); setArchiveError(""); setReading(false); setReference(true); }}>{fallbackLabel}</Button>}<p className="text-muted-foreground text-xs">仅在本设备内存预览；不上传或修改账本。</p>{reading && <p role="status" className="text-sm">正在读取历史分析包…</p>}{archiveError && <p role="alert" className="text-destructive text-sm">{archiveError}</p>}{archive && archiveInput && <div className="flex flex-wrap items-center gap-2" aria-label="历史估值口径">{[[true, "参考估算"], [false, "仅看已核对"]].map(([mode, label]) => <Button key={String(mode)} size="sm" variant={reference === mode ? "secondary" : "ghost"} aria-pressed={reference === mode} onClick={() => { const next = mode === true; setArchive(analyzeHistoryPackage(archiveInput, next)); setReference(next); setArchiveError(""); }}>{label}</Button>)}<span className="text-muted-foreground text-xs">{reference ? "含历史估算，不能视为已核对结论。" : "不采用历史估算快照。"}</span></div>}</div>;
  return <>{input}{archive ? <InvestmentAnalysisView key={`history-${reference}`} {...archive} /> : children}</>;
}

export function InvestmentAnalysis({ scope }: { scope: AccountScope }) {
  const { settings } = useSettingsContext();
  const configuredTimezone = settings?.timezone || "";
  const timezone = validTimezone(configuredTimezone) ? configuredTimezone : "";
  const fixture = import.meta.env.DEV && new URLSearchParams(location.search).get("analysis-fixture") === "1";
  const through = timezone ? formatZonedDateKey(new Date(), timezone) : today();
  const query = useQuery({ queryKey: ["vibelife-investment-analysis", scope, through, timezone, fixture], enabled: Boolean(timezone) || fixture,
    queryFn: async () => fixture ? (await import("./synthetic")).syntheticAnalysis() : loadNativeAnalysis(scope, through, timezone), retry: false });
  let content: ReactNode;
  if (!timezone && !fixture) content = <p className="text-muted-foreground p-6">请先在设置中选择业务时区。</p>;
  else if (query.isLoading) content = <p className="text-muted-foreground p-6" role="status">正在读取投资数据…</p>;
  else if (query.isError) content = <div className="space-y-3 p-6" role="alert"><p>投资数据暂时无法读取，请检查登录状态后重试。</p><Button onClick={() => void query.refetch()}>重试</Button></div>;
  else if (!query.data?.points.length) content = <div className="space-y-2 p-6"><h2 className="text-xl font-semibold">投资分析</h2><p className="text-muted-foreground">暂无投资估值或交易记录。</p></div>;
  else content = <InvestmentAnalysisView key={JSON.stringify(scope)} {...query.data} />;
  return <HistoryWorkspace>{content}</HistoryWorkspace>;
}
