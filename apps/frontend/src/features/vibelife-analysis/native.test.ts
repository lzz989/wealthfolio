import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ getHistoricalValuations:vi.fn(), searchActivities:vi.fn() }));
vi.mock("@/adapters", () => api);
import { loadNativeAnalysis } from "./native";

describe("native analysis activity pagination", () => {
  beforeEach(() => { vi.resetAllMocks(); api.getHistoricalValuations.mockResolvedValue([]); });
  const first = () => ({ data:Array.from({length:200}, (_,i)=>({id:`${i}`})), meta:{totalRowCount:201} });
  it("rejects a changed total instead of accepting an incomplete snapshot", async () => {
    api.searchActivities.mockResolvedValueOnce(first()).mockResolvedValueOnce({data:[{id:"200"}], meta:{totalRowCount:202}});
    await expect(loadNativeAnalysis({type:"all"},"2026-03-25","UTC")).rejects.toThrow("发生变化");
  });
  it("rejects duplicate IDs at page boundaries even when totals match", async () => {
    api.searchActivities.mockResolvedValueOnce(first()).mockResolvedValueOnce({data:[{id:"199"}], meta:{totalRowCount:201}});
    await expect(loadNativeAnalysis({type:"all"},"2026-03-25","UTC")).rejects.toThrow("发生变化");
  });
  it("accepts a complete, stable set of unique records", async () => {
    api.searchActivities.mockResolvedValueOnce(first()).mockResolvedValueOnce({data:[{id:"200"}], meta:{totalRowCount:201}});
    await expect(loadNativeAnalysis({type:"all"},"2026-03-25","UTC")).resolves.toMatchObject({activities:201});
  });
});
