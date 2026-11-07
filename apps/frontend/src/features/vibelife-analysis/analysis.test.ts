import { describe, expect, it } from "vitest";
import { syntheticAnalysis, syntheticPackage, syntheticReferencePackage } from "./synthetic";
import { analyzeHistoryPackage } from "./archive-input";
import { nativePoints, provenDaily, type AnalysisPoint } from "./model";
import type { AccountValuation, ActivityDetails } from "@/lib/types";
import { projectArchive } from "./legacy-adapter.js";

const p = (date: string, total: number | null): AnalysisPoint => ({ date, total, netFunding: null, profit: null, dailyProfit: null, dailyRate: null, estimated: false, markers: [] });
describe("read-only investment analysis", () => {
  it("loads an explicitly selected analysis package through the production input path", () => {
    const result = analyzeHistoryPackage(JSON.stringify(syntheticPackage()));
    expect(result.source).toContain("合成测试数据");
    expect(result.points.find(p => p.date === "2026-03-24")?.qqq).toBeCloseTo(12439.21568627451);
    const invalid = structuredClone(syntheticPackage());
    invalid.data.history.dailySnapshots[0].estimated = undefined as unknown as boolean;
    expect(() => analyzeHistoryPackage(JSON.stringify(invalid))).toThrow("估算标记");
  });
  it("switches reference estimates without promoting them or losing real trade dates", () => {
    const input = structuredClone(syntheticPackage());
    const estimatedSnapshot = { date: "2026-03-23", estimated: true, totalUsd: 12300, rows: [], source: "synthetic" };
    input.data.history.dailySnapshots = [estimatedSnapshot];
    const serialized = JSON.stringify(input);
    const reference = analyzeHistoryPackage(serialized);
    const strict = analyzeHistoryPackage(serialized, false);
    const estimate = reference.points.find(p => p.date === "2026-03-23");
    expect(estimate?.total).toBe(12300);
    expect(estimate?.estimated).toBe(true);
    expect(estimate?.basisDate).toBe("2026-03-23");
    expect(strict.points.find(p => p.date === "2026-03-23")?.total).toBeNull();
    expect(strict.points.find(p => p.date === "2026-03-24")?.markers[0].type).toBe("T");
    expect(strict.points.find(p => p.date === "2026-03-23")?.dailyProfit).toBeNull();
    expect(input.data.history.dailySnapshots[0].estimated).toBe(true);
  });
  it("shows adjacent estimated snapshots and reference cash-flow daily results without claiming verification", () => {
    const text = JSON.stringify(syntheticReferencePackage());
    const reference = analyzeHistoryPackage(text);
    const strict = analyzeHistoryPackage(text, false);
    expect(reference.points.map(p => p.total)).toEqual([1000, 1610, 1770]);
    expect(reference.points.map(p => p.dailyProfit)).toEqual([null, 110, 160]);
    expect(reference.points.map(p => p.estimated)).toEqual([true, true, true]);
    expect(reference.points.map(p => p.dailyEstimated)).toEqual([false, true, true]);
    expect(reference.points[1].qqq).toBeCloseTo(1600);
    expect(strict.points.every(p => p.total === null)).toBe(true);
    expect(strict.points[2].markers[0].type).toBe("T");
  });
  it("runs the existing archived cash flow engine with fixed start and actual trade markers", () => {
    const report = syntheticAnalysis();
    const values = report.points.filter(x => x.date <= "2026-03-25");
    expect(values.map(x => x.total)).toEqual([10000,12300,12400,12100]);
    expect(values.map(x => x.dailyProfit)).toEqual([null,300,100,200]);
    expect(values[1].qqq).toBeCloseTo(12200);
    expect(values[2].qqq).toBeCloseTo(12439.21568627451);
    expect(values[3].qqq).toBeCloseTo(12058.823529411765);
    expect(values[3].profit).toBeCloseTo(600);
    expect(values[3].qqqProfit).toBeCloseTo(558.823529411765);
    expect(values.map(x => x.netFunding)).toEqual([10000, 12000, 12000, 11500]);
    expect(values.every(x => x.total === (x.netFunding ?? 0) + (x.profit ?? 0))).toBe(true);
    expect(values[2].markers[0].type).toBe("T");
    expect(values[2].markers[0].details).toHaveLength(2);
  });
  it("does not infer a zero daily return through a missing day or unverified flow", () => {
    expect(provenDaily([p("2026-03-20",100),p("2026-03-24",110)], { "2026-03-24":0 })[1].dailyProfit).toBeNull();
    expect(provenDaily([p("2026-03-20",100),p("2026-03-23",110)], {})[1].dailyProfit).toBeNull();
  });
  it("preserves trade-only dates without inventing a valuation when the calendar is out of coverage", () => {
    const result = syntheticAnalysis("2027-01-04");
    const trade = result.points.find(x => x.date === "2026-03-24");
    expect(trade?.markers[0].type).toBe("T");
    expect(trade?.markers[0].details).toHaveLength(2);
    expect(trade?.total).toBeNull();
    expect(trade?.dailyProfit).toBeNull();
    expect(trade?.qqq).toBeNull();
  });
  it("never treats native gross flow or transfer as a verified deposit or T trade", () => {
    const vals = [{ valuationDate:"2026-03-20", valueStatus:"complete", totalValueBase:100, externalInflowBase:500 }] as AccountValuation[];
    const acts = [{ id:"a", date:"2026-03-20", activityType:"TRANSFER_IN", accountId:"a", assetId:"b", currency:"USD" }] as unknown as ActivityDetails[];
    const result = nativePoints(vals, acts);
    expect(result[0].netFunding).toBeNull(); expect(result[0].dailyProfit).toBeNull(); expect(result[0].markers).toEqual([]);
  });
  it("excludes pending, void, draft, unknown and review-needed trades before pairing", () => {
    const base = { date:"2026-03-20", accountId:"a", assetId:"b", currency:"USD", assetSymbol:"SYNTH", needsReview:false };
    const acts = [
      { ...base, id:"1", activityType:"BUY", status:"POSTED" },
      { ...base, id:"2", activityType:"SELL", status:"VOID" },
      { ...base, id:"3", activityType:"SELL", status:"PENDING" },
      { ...base, id:"4", activityType:"SELL", status:"DRAFT" },
      { ...base, id:"5", activityType:"SELL" },
      { ...base, id:"6", activityType:"SELL", status:"POSTED", needsReview:true },
      { ...base, id:"7", date:"2026-03-23", activityType:"BUY", status:"PENDING" },
    ] as unknown as ActivityDetails[];
    const points = nativePoints([], acts);
    expect(points).toHaveLength(1);
    expect(points[0].markers.map(x => x.type)).toEqual(["B"]);
  });
  it("maps activity timestamps using the explicit business timezone", () => {
    const acts = [{ id:"x", date:"2026-03-20T18:30:00Z", activityType:"BUY", status:"POSTED", needsReview:false, accountId:"a", assetId:"b", currency:"USD" }] as unknown as ActivityDetails[];
    expect(nativePoints([], acts, "Asia/Shanghai")[0].date).toBe("2026-03-21");
  });
  it("marks daily profit estimated when the previous valuation was estimated, but not a gap", () => {
    const report = {sourceUpdatedAt:null, benchmark:{status:"unavailable"}, issues:[], points:[
      {date:"2026-03-20", estimated:true, dailyProfitUsd:null},
      {date:"2026-03-23", estimated:false, dailyProfitUsd:10},
      {date:"2026-03-24", estimated:true, dailyProfitUsd:null},
    ]};
    const trades = {days:[], sourceCounts:{broker:0}, coverageNote:""};
    expect(projectArchive(report,trades).points.map(p => p.dailyEstimated)).toEqual([false,true,false]);
  });
});
