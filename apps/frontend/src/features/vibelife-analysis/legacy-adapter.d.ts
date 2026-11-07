import type { AnalysisPoint } from "./model";
export function analyzeArchive(input: object): { source: string; asOf: string | null; currency: string; activities: number; coverage: string; benchmarkStatus: string; points: AnalysisPoint[] };
export function projectArchive(report: object, trades: object): { points: AnalysisPoint[] };
