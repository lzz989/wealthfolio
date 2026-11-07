# 投资分析候选

`/insights?tab=investment-history` 使用 Wealthfolio 的已认证 profile 只读查询。原生组合估值可以显示资产；原生聚合资金流可能包含内部转账，不能作为组合净入金，因此净投入、日盈亏和 QQQ 对照暂显示待核对。不会写入 Wealthfolio 或旧账本。

页面的“打开本地历史分析包”在浏览器内读取用户选择的 JSON，使用旧分析引擎计算，不上传、持久缓存或写账本。历史预览与原生来源分开标识；关闭页面后重新选择。此入口尚不生成或迁移真实数据包。

历史预览默认“参考估算”，使用引擎的参考口径并保留估算标记和可用的依据日期；“仅看已核对”切回严格口径，估算快照不被提升为已核对结果。无可靠估值或日收益时显示缺值，而不是零；真实交易日期仍保留。切换口径仅重新计算内存中的文件，不修改源文件或账本。

## 历史分析包 v1

JSON 对象包含：

- `format`: 固定 `vibelife-investment-analysis/1`；`source`: 非空来源说明；`throughDate`: 有效 `YYYY-MM-DD`。
- `data`: 旧分析引擎所需结构，包括 `updatedAt`、`history.dailySnapshots`、`brokerImportLedger`、`dcaSyncLedger` 和 `funding`。每条快照须有有效 `date`、布尔 `estimated` 和 `rows` 数组；保留既有记录状态、来源与精度，不得把估算改成已核实。
- `market`: 标的代码到行情对象的映射。每项须含非空 `source`、`priceBasis` 和 `series`；`series` 为日期到正数的映射，实际持仓价格、基金净值和日汇率须按旧引擎要求分别标注口径与币种。
- `qqq`: 非空 `source`、布尔 `adjusted` 与 `closes` 日期到正数的映射。未复权不能冒充含分红基准。

文件上限 10 MB；结构或质量不足会提示失败或显示缺值。导入入口只做结构校验，来源真实性及迁移核对仍需人工确认。可运行的合成包示例在 `synthetic.ts` 的 `syntheticPackage()`；其中所有数据均为虚构。
