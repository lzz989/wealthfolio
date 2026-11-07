const KEY = "vibelife.pending-investment-analysis";
const ANALYSIS_PATH = "/insights?tab=investment-history";

// Persist only an allowlisted page marker, never a token or arbitrary URL.
export function rememberInvestmentAnalysis(pathname: string, search: string) {
  try {
    if (pathname === "/insights" && new URLSearchParams(search).get("tab") === "investment-history") {
      sessionStorage.setItem(KEY, "1");
    } else sessionStorage.removeItem(KEY);
  } catch { /* Storage is optional; authentication must still work. */ }
}

export function takeInvestmentAnalysis(pathname: string): string | null {
  try {
    const pending = sessionStorage.getItem(KEY) === "1";
    sessionStorage.removeItem(KEY);
    return pending && pathname === "/" ? ANALYSIS_PATH : null;
  } catch { return null; }
}

export function clearInvestmentAnalysis() {
  try { sessionStorage.removeItem(KEY); } catch { /* Storage is optional. */ }
}
