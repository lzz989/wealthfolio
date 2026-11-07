# Wealthfolio 投资分析：聚合站集成候选

状态：仅准备完成，未构建镜像、未部署、未修改 Homarr 或 DNS；真实财务数据未迁入。

## 对象与边界

- 原生 Wealthfolio 3.12.0，服务端沿用官方固定 digest 和既有认证；不改变旧投资或收支正式写入端，也不接入真实账本。
- 源码以上游 `f217ef5fbe76eecb5c5ceac53ee2514dee706c81` 为基线；实际定制版本以本 Fork 提交 SHA 和 VibeLife 父仓库 gitlink 为准。源码与前端产物的摘要清单是可再生验收证据，不是构建输入。
- Vite 完整 web 生产构建位于 `tmp/analysis-native-dist/`，不是独立演示构建。入口为 `/insights?tab=investment-history`；原生 API 接口只读、认证仍由原 Wealthfolio 负责。历史包仅在用户浏览器内处理。
- 历史构建显式设置了 `BUILD_TARGET=web` 且退出码为 0。新克隆需预先准备 Node.js 与 Corepack，按仓库 `package.json` 固定 `pnpm@10.33.4` 安装锁定依赖；在仓库根目录运行：`BUILD_TARGET=web corepack pnpm --filter frontend exec vite build --config vite.investment-native.config.mts`。输出为可重新生成的 `tmp/analysis-native-dist/`，不依赖本机临时工具或已归档的构建产物。
- Native 组合净资金流与逐日 FX 未核实时，日盈亏／净投入／QQQ 保持待核对；不能将合成历史当真实迁移完成。

## 管理员按既有运维流程执行的最小操作

1. 核对固定官方镜像、本机运行实例、在途操作、受限数据和密钥位置；按现有财务候选备份、异目录恢复流程核实可回退，不读取或复制密钥到工作树。确认现有数据库仅含隔离样本。不得覆盖新产生的数据。
2. 以 `tmp/analysis-native-dist/` 为唯一构建上下文，使用 `deploy/vibelife/investment-native.Dockerfile` 从原固定官方镜像制作 `vibelife-wealthfolio:investment-analysis-candidate`；例如工作树内 `docker build --pull=false -f deploy/vibelife/investment-native.Dockerfile -t vibelife-wealthfolio:investment-analysis-candidate tmp/analysis-native-dist`。仅该前端目录进入上下文；服务端二进制不变；统一登录需另按经审阅的原生 OIDC 配置启用。核对生成镜像 ID、前端文件摘要及原生认证，再做切换；此处没有预称镜像已构建。
3. 沿用 **VibeLife 父仓库**的 `deploy/aggregation-p2/finance/wealthfolio.compose.yaml` 与仓库外现有受限配置，叠加本 Wealthfolio 仓库的 `deploy/vibelife/investment-native.compose.override.yaml`，按受控维护流程只更新 Wealthfolio 容器；原数据目录、密钥和其他服务不变；仅在客户身份绑定及原生 OIDC 验证完成后应用候选认证配置。先验证登录、非登录 API 拒绝、原生旧页面及新分析标签，保留官方镜像作为回退。不得重置数据库或用备份覆盖切换后的新数据。
4. 目前只发现 127.0.0.1:13130 回环入口，不能直接供用户使用。采用既有私有访问边界及正确 zone 的 HTTPS 入口，候选是 `https://invest.majiu.xyz`，它尚未配置；实际域名、Tunnel/DNS 和该确切 Origin 的原生安全配置须由有权运维人员按既有流程核对。不能使用旧 sss2.top zone，也不能开放匿名访问或放宽认证。若这些更改超出现有授权或能力，先列明具体事项，不能擅自扩大访问边界。
5. Owner 在 Homarr 私有看板新增或修改投资入口，目标为已验证 HTTPS 地址的 `/insights?tab=investment-history`。不替换旧理财入口或旧正式账本；上线前检查现有看板的实际链接，避免重复或覆盖他人改动。统一登录配置及整个跳转链须先通过验收。
6. 从 `https://home.majiu.xyz/` 实际点击入口，验证原生登录、深链、桌面及手机、合成样本／本地历史文件、刷新与退出；并确认旧投资、收支和其他现有入口未受影响。未完成此步骤前不称聚合入口上线。

## 已有证据及限制

- 独立 web 构建成功，完整前端保留原生 Wealthfolio 页面；定向分析测试 10/10。先前曾以合成数据验证引擎及浏览器交互；历史临时验收记录和清单不作为新克隆构建输入。
- 本机只读探测时，Wealthfolio 根路径 HTTP 200、Homarr 匿名跳转 307；并不代表用户已能经聚合站进入投资分析。既有记录显示 Wealthfolio 只绑定 127.0.0.1:13130。
- 当前执行账号此前访问 `/var/run/docker.sock` 返回 OS `permission denied`；没有自动审批拒绝。不以其他身份、工具或权限绕过。安装与 DNS/Tunnel 属受保护操作，尚未执行；原生已登录数据链、整条 Homarr→Wealthfolio 路径、真实设备均待验。
- 回退只切回原官方镜像并保留现有隔离库与新增数据；如接口／前端不兼容，停止切换并检查，不用旧备份覆盖当前库。

- 本次重新构建包含 `auth-context.tsx`、`login-page.tsx` 与固定目的地返回 helper；历史构建为 Web 目标，重新构建时可生成源码及产物摘要清单以便核对。
- 身份服务必须以 `wealthfolioStage=production` 登记精确 HTTPS 回调；运行环境中的 `WF_OIDC_CLIENT_SECRET` 必须存在且与登记的一致，原生配置不支持 `_FILE` 变体。实际已登录回调、单点登录及受锁 profile 尚未验证，不解除已有 profile 锁。
