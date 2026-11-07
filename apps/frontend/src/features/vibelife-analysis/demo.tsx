import { createRoot } from "react-dom/client";
import "@/globals.css";
import { HistoryWorkspace, InvestmentAnalysisView } from "./investment-analysis";
import { syntheticAnalysis } from "./synthetic";

const data = syntheticAnalysis();
createRoot(document.getElementById("root")!).render(<main className="mx-auto max-w-6xl p-4 sm:p-8"><p className="mb-4 text-sm text-muted-foreground">独立只读预览，默认合成样例；本地文件仅在浏览器内存计算。</p><HistoryWorkspace fallbackLabel="返回合成演示"><InvestmentAnalysisView {...data} /></HistoryWorkspace></main>);
