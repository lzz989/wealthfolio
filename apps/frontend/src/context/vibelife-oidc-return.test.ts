import { beforeEach, describe, expect, it } from "vitest";
import { clearInvestmentAnalysis, rememberInvestmentAnalysis, takeInvestmentAnalysis } from "./vibelife-oidc-return";

describe("investment analysis return after authentication", () => {
  beforeEach(() => sessionStorage.clear());

  it("restores only the fixed analysis destination, once", () => {
    rememberInvestmentAnalysis("/insights", "?tab=investment-history&next=https://attacker.example");
    expect(takeInvestmentAnalysis("/")).toBe("/insights?tab=investment-history");
    expect(takeInvestmentAnalysis("/")).toBeNull();
  });

  it("does not restore other routes or override a destination after login", () => {
    rememberInvestmentAnalysis("//attacker.example", "?tab=investment-history");
    expect(takeInvestmentAnalysis("/")).toBeNull();
    rememberInvestmentAnalysis("/insights", "?tab=investment-history");
    expect(takeInvestmentAnalysis("/profiles")).toBeNull();
    expect(takeInvestmentAnalysis("/")).toBeNull();
    rememberInvestmentAnalysis("/insights", "?tab=investment-history");
    clearInvestmentAnalysis();
    expect(takeInvestmentAnalysis("/")).toBeNull();
  });
});
