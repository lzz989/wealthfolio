import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HistoryWorkspace } from "./investment-analysis";
import { syntheticPackage } from "./synthetic";

const packageText = () => {
  const input = structuredClone(syntheticPackage());
  const estimated = { date: "2026-03-23", estimated: true, totalUsd: 12300, rows: [], source: "synthetic" };
  input.data.history.dailySnapshots = [estimated];
  return JSON.stringify(input);
};
const select = (text: () => Promise<string>) => fireEvent.change(screen.getByLabelText("打开本地历史分析包"), { target: { files: [{ size: 1000, text }] } });

describe("history preview", () => {
  it("switches between an explicitly estimated value and a strict gap while retaining trades", async () => {
    render(<HistoryWorkspace><div>原生数据</div></HistoryWorkspace>);
    select(async () => packageText());
    await screen.findByText(/本地历史预览 · 合成测试数据/);
    expect(screen.getByRole("button", { name: "参考估算" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /2026-03-23/ }));
    expect(screen.getByText(/US\$12,300.00/)).toHaveTextContent("含估值");
    expect(screen.getByText(/记录依据 2026-03-23/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "仅看已核对" }));
    fireEvent.click(screen.getByRole("button", { name: /2026-03-23/ }));
    expect(screen.getByText(/资产 —/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /2026-03-24/ }));
    expect(screen.getByText(/T SYNTH/)).toBeInTheDocument();
  });

  it("clears an old report and ignores a late file read after returning to native", async () => {
    render(<HistoryWorkspace><div>原生数据</div></HistoryWorkspace>);
    select(async () => packageText());
    await screen.findByText(/本地历史预览 · 合成测试数据/);
    let finish!: (value: string) => void;
    select(() => new Promise<string>(resolve => { finish = resolve; }));
    expect(screen.queryByText(/本地历史预览 · 合成测试数据/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回 Wealthfolio 数据" }));
    finish(packageText());
    await waitFor(() => expect(screen.getByText("原生数据")).toBeInTheDocument());
    expect(screen.queryByText(/本地历史预览 · 合成测试数据/)).not.toBeInTheDocument();
  });

  it("clears a previous file error when another file is selected", async () => {
    render(<HistoryWorkspace><div>原生数据</div></HistoryWorkspace>);
    select(async () => "invalid JSON");
    expect(await screen.findByRole("alert")).toHaveTextContent("文件不是有效的 JSON");
    select(async () => packageText());
    await screen.findByText(/本地历史预览 · 合成测试数据/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
