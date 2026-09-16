# SunsetGuard 开发状态

工作文档版本：0.6.1（2026-09-16）；原始交付基线 0.2.0。本文件记录实际开发；原始完整指南保留最初的 pending 模板。

### 当前状态

- 当前阶段：P3，T01—T07 及 T09—T10 工程交付已完成（T08 可选、未实施）；T07 标签仍为 provisional。交付范围按用户最新选择限定为本地试用，不越过 T11 的实际试用门槛。
- GitHub 交付：已按用户授权推送到公开仓库 [qweqwe12382/sunsetguard-api-evidence](https://github.com/qweqwe12382/sunsetguard-api-evidence)，并发布 [v0.1.0](https://github.com/qweqwe12382/sunsetguard-api-evidence/releases/tag/v0.1.0)；该 tag 固定到 `250de4ac61a3b15fedc0d1020ad18352bc832e7e`。
- 目标复核（2026-09-12 晚）：用户确认的“可本地试用”阶段目标已达成；PROJECT_REPORT 的 P3 维护者真实任务门槛仍未验证，不能把工程交付完成写成整个项目落地或全部产品验收完成。最新独立复验见 artifacts/local-install-J5vlT6/checks.json。
- 最近完成任务：v0.1.0 开源发布与 Codex for Open Source 申请准备；T10 的明确清单、批量 CLI、缓存、离线重放及 Markdown 保持可用。
- 产品源码：单目标单目录/批量 CLI、本地/公开 GitHub 快照、四类引用证据、有限配置归因、隔离分析线程、JSON/文本/Markdown、安全外部报告、固定样本评估与有界缓存。
- 项目 typecheck/lint/build：2026-09-16 全部实际通过；测试 36 个文件，527 项通过、1 项因 Windows 文件符号链接创建权限拒绝而跳过。
- 独立本地包：artifacts/local-trial-JpB9t0，181 文件 / 241990 字节，SHA-256 `86b3eeb6b3012a3ec827c0304ac5d352b63d0461f731dba1129e2ffe0c39ab98`；工作区外生产依赖安装与 20 项 CLI/Worker/缓存/许可证验收通过，见 artifacts/local-install-Xwbdok/checks.json。需要 Node 24/pnpm 11.7，未捆绑运行时或依赖目录。
- 外部 API 实际验证：T09 单仓库和 T10 两个固定仓库的匿名 GitHub metadata/commit/tree/archive 获取成功；不代表发现服务、生产 SLA 或异常网络场景均已实测。
- 真实下游扫描：T07 的 3 仓库 / 6 选定文件审计保留；T10 真实 CLI 获取 rc-util/reactstrap 共 601 个文件，默认 461 eligible / 460 analyzed / 1 parse failed；两仓库 unknown+partial，在线与离线结果一致。独立人工精度审计未运行，不作为通用准确率。
- 第三方维护者试用：未验证。
- 名称和 GitHub 账号已用于本次仓库交付；仓库公开，MIT 许可证与维护入口已补齐，npm 仍保持 private 且未发布。GitHub private vulnerability reporting 已启用并实际复核，安全策略保留公开联系请求作为备用入口。

### 2026-09-16 · MIT 与 Codex for Open Source 发布

用户明确选择 MIT，并要求完善 Codex for Open Source 所需材料。本轮使用仓库所有者 GitHub 标识 `qweqwe12382` 作为 MIT 版权主体；没有编造真实姓名、ChatGPT 邮箱或 OpenAI Organization ID。

- 新增标准 MIT `LICENSE`，`package.json` 写入 `license=MIT` 与 `author=qweqwe12382`，README、CONTRIBUTING、本地试用文档和 CHANGELOG 同步许可证与 `v0.1.0` 发布边界；`private: true` 保持不变，不自动发布 npm 包。
- 新增 `MAINTAINERS.md`、`.github/CODEOWNERS`、`docs/releases/v0.1.0.md` 和 `docs/CODEX_FOR_OSS_APPLICATION.md`。申请包逐字段映射官方表单，三段可粘贴英文回答分别为 490、475、480 字符，均在 500 字符上限内；个人字段保留明确占位。
- 申请中的 API credits 计划只用于 SunsetGuard 自身的 issue triage、PR review、合成回归 fixture、CI 诊断和发布说明，不向 API 发送私有下游源码、秘密、本地路径或用户报告，也不把公开可读视为取得 Codex Security/API 审查授权。
- 自定义试用包现在强制携带 `LICENSE`，运行时 `package.json` 保留许可证、作者、主页、仓库和问题入口；独立验证器同时检查 MIT 元数据和许可证正文。
- GitHub REST 写操作因当前 `gh` 缺少认证返回 401，没有被写成成功；随后通过已登录仓库设置页启用 private vulnerability reporting，页面显示保存成功，公开读取接口复核为 `enabled=true`。

实际检查：

| 命令/检查 | 结果 | 证据 |
|---|---|---|
| 申请回答长度检查 | passed | 三段英文回答 490 / 475 / 480 字符 |
| `pnpm install --frozen-lockfile --ignore-scripts` | passed | 锁文件一致；无依赖变更，未运行生命周期脚本 |
| `pnpm run check` | passed with skip | typecheck、lint、build 通过；36 files / 527 passed / 1 skipped，共 528 |
| `pnpm run bundle:local` | passed | 181 文件 / 241990 字节；SHA-256 `86b3eeb6b3012a3ec827c0304ac5d352b63d0461f731dba1129e2ffe0c39ab98` |
| 首次 `pnpm run verify:local artifacts/local-trial-JpB9t0` | failed | 新增 `LICENSE` 后 mandatory 名称集合已转小写但断言仍用大写，archive 阶段拒绝；未写成通过 |
| 修复后同一独立包验收 | passed | `artifacts/local-install-Xwbdok`；解包、生产依赖、CLI、Worker、缓存与许可证共 20 checks 全通过 |
| `pnpm audit --prod --registry https://registry.npmjs.org` | passed | No known vulnerabilities found；仅覆盖当前 registry advisory 数据 |
| GitHub private vulnerability reporting | passed | 设置页保存成功；`GET /private-vulnerability-reporting` 返回 `enabled=true` |

发布结果：提交 `250de4ac61a3b15fedc0d1020ad18352bc832e7e` 的 [GitHub Actions run 35052949745](https://github.com/qweqwe12382/sunsetguard-api-evidence/actions/runs/35052949745) 成功完成 2 个 job，耗时 1m17s；Ubuntu 为 36 files / 526 passed / 2 skipped，Windows 为 36 files / 528 passed。随后发布非 draft、非 prerelease 的 [v0.1.0](https://github.com/qweqwe12382/sunsetguard-api-evidence/releases/tag/v0.1.0)，tag 指向该提交。Release 附件包含 `sunsetguard-local-trial.tgz`（241990 字节，SHA-256 与本节表格一致）、`SHA256SUMS.txt` 和 `bundle.json`，GitHub 页面同时显示自动生成的两个源码包。仓库主页实际识别为 MIT，private vulnerability reporting 保持启用。

申请表尚未代用户提交。申请人仍需在[官方表单](https://openai.com/form/codex-for-oss/)填写真实姓名、ChatGPT 账号邮箱与 Organization ID，并在提交前自行确认当时的[项目条款](https://developers.openai.com/codex/codex-for-oss-terms)。这些个人字段不会写入公开仓库；第三方采用证据仍未验证，也不会被虚构成项目活跃度。

### 2026-09-16 · 公开仓库加固与完整复验

用户要求补充测试步骤、使用说明、各方面验证，并继续“完善优化提交更新”。本轮以 `aeac189104f742cf5474dd475adf30447debbd63` 为基线复核实际目录、Git 状态、SPEC/TASKS/STATUS、源码、测试、package scripts 和公开仓库状态；内部协作文件继续保持未跟踪，不纳入公开提交。

本次修改：

- 停止将下游 `package.json` dependency 声明值写入新归因结果；JSON、text、Markdown renderer 同样剥离 legacy `declaredRange`。归因策略版本升为 `0.1.0-t06.1`，旧分析缓存键失效；即使重写 checksum 的同版本缓存含该字段，也会被拒绝并从已验证快照重算。历史 benchmark 作为旧版本证据保留，不冒充新输出。
- 修复报告 hard-link 成功后校验或 staging 清理失败的回滚：只有输出父目录身份仍可信且目标仍是本次文件时才删除；并发替换文件和被替换父目录不会被越界清理。
- CLI 缺少 `--repos` / `--package` / `--symbol` 时准确指出缺项；初始化 cache 位于受保护输入内时归为无效配置并退出 2，运行期 I/O 错误仍保留内部错误语义。
- 本地 snapshot API 的六类限制只允许降低默认上限。实现对每个配置值只读取一次，拒绝 undefined、非正安全整数和放大值，避免带状态 getter 的二次读取绕过。
- 首轮远端 Linux CI 暴露本地目录枚举顺序不稳定：资源截断可能在不同文件系统选择不同文件。现改为每个目录完整枚举后按名称排序；当前目录在 entry 上限前无法完整枚举时不输出任意前缀，避免平台相关的证据和 contentHash。
- 增加 `pnpm run check`、Linux/Windows GitHub Actions、CONTRIBUTING、SECURITY、CHANGELOG、PR 模板和三类 Issue 表单。CI 的 checkout 与 pnpm setup 固定到已核对的不可变 commit，token 权限仅 contents:read，依赖安装继续使用冻结锁文件并关闭生命周期脚本。
- SPEC 中报告写入改为与实现一致的 atomic create-if-absent，不再写成覆盖替换；README 保持简短入口并链接测试、贡献、安全和变更文档。`.pnpm-store/` 纳入忽略规则。

实际检查：

| 命令/检查 | 结果 | 证据 |
|---|---|---|
| `pnpm install --frozen-lockfile --ignore-scripts` | passed | 退出 0；锁文件一致，未运行生命周期脚本 |
| `pnpm run check` | passed with skip | 退出 0；typecheck、lint、build 通过；36 files / 527 passed / 1 skipped，共 528 |
| `pnpm run bundle:local` | passed | 退出 0；180 文件 / 241213 字节；SHA-256 如上 |
| `pnpm run verify:local artifacts/local-trial-oXUESF` | passed | 退出 0；工作区外离线生产依赖安装与 20 checks 全通过 |
| `pnpm audit --prod --registry https://registry.npmjs.org` | passed | 退出 0；No known vulnerabilities found；仅覆盖当前 registry advisory 数据 |
| 独立只读集成审查 | passed | 归因隐私、缓存、写入竞态、CLI、limit getter、CI SHA 和安全联系流程复核后无阻断项 |
| GitHub Actions 首轮双平台运行 | failed | run 35050528885：Windows 全通过；Ubuntu 因目录顺序假设和大小写测试假设 2 项失败，促成本轮确定性修复 |
| GitHub Actions 修复后双平台运行 | passed | run 35051434149：Ubuntu 52 秒、Windows 1 分 16 秒；锁定依赖安装、typecheck、lint、build 和 tests 全通过，head `f2a4ff2ea018ad71c7e05c828e06b739c3296a8e` |

此前普通 Codex 隔离账户中的一次定向缓存测试因 Windows 用户目录祖先 `realpath` 权限出现 15 项环境失败；未将其写成产品通过。随后在正常主机权限运行完整 `pnpm run check`，当时结果为 526 passed / 1 skipped。

确定性修复后的首轮本机完整复跑有 1 项 remote Worker 生命周期用例在 10 秒处偶发超时；该用例随即单独 6/6 通过，第二次完整 `pnpm run check` 为 36 files / 526 passed / 1 skipped。独立复核后又补充“后续目录 entry 超限仍保留此前证据”的回归测试：相关 snapshot 测试 20/20 通过。受限账户下的完整复跑因系统临时目录祖先权限产生 29 项 cache I/O 环境失败；在正常主机权限重跑同一 `pnpm run check` 后为 36 files / 527 passed / 1 skipped。所有失败均保留记录，未改写为首次通过；跳过项仍是 Windows 无符号链接创建权限环境的既有用例。修复提交随后在 GitHub Actions 的 Ubuntu 和 Windows 任务全部通过。

本轮不改变 schemaVersion、analysisProfile、analyzerVersion 或 ESM ruleSetVersion；仅 attributionVersion 变化并使旧分析缓存不命中，raw snapshot cache 仍可复核后用于重算。没有升级依赖、执行下游代码、安装下游依赖、发布 npm 包、创建 Release 或声称第三方采用。

已知边界：Node 路径 API 的身份检查不能提供针对完全控制输出目录且持续竞态的 OS 级原子隔离；macOS 与其他平台长期运行、独立人工精度复核和真实维护者使用仍以实际证据为准。

下一项：完成 `v0.1.0` tag、GitHub Release、发布提交双平台 CI；申请人补入真实个人字段并确认条款后再提交申请。真实维护者调查与人工反馈仍是后续外部验证，不用下载量、测试数或公开状态替代采用证据。

### 2026-09-12 · GitHub 私有仓库上传

用户明确要求将项目上传到其 GitHub 账号，并允许由我命名新项目。本次选用 `sunsetguard-api-evidence`，因为它同时表达项目名称和用途；创建前确认账号已有登录状态且该名称未占用。

- 创建仓库：`gh repo create qweqwe12382/sunsetguard-api-evidence --private --source . --remote origin --push`；远端地址为 https://github.com/qweqwe12382/sunsetguard-api-evidence。
- 初始代码提交：`754349a088cd863d4b42fec1d607282312f71bb0`；随后以 `af5eeb7174574cb9ff3646e4ec6a9d1259fef9d7` 补充上传记录，当前分支为 `main`，远端与本地最新提交逐字一致。
- 上传范围：125 个已跟踪文件，包括 README、TypeScript 源码、测试、文档、示例、基准记录、脚本、pnpm 锁文件和项目配置。远端树复核包含 README、源码、测试和锁文件。
- 排除范围：`node_modules/`、`dist/`、`artifacts/`、测试临时目录、`.env*`、日志、试用压缩包，以及本地 `AGENTS.md`、`CODEX_START.md`、`START_HERE.md`、`prompts/` 和原始根目录完整指南；这些文件没有上传。GitHub 远端未发现依赖目录、构建目录、缓存、压缩包或环境文件。
- 推送后检查：类型检查退出 0；代码检查退出 0；全量测试 36 个文件、513 passed / 1 skipped，共 514；远端默认分支和提交树核对通过。Windows 文件 symlink 权限用例仍为唯一跳过项。
- 当前工作区保留未跟踪的内部协作文件，不影响已推送提交；后续若要纳入仓库需单独决定。仓库仍为 private，许可证、npm 发布和公开发布没有自动处理。

这次上传证明代码已落到账号的 GitHub 仓库，不证明真实维护者采用、通用分析准确率或生产部署。下一项仍是取得一次明确真实调查目标和人工核对反馈，再决定是否继续扩展功能。

### 2026-09-12 · GitHub 公开可见性变更

用户随后明确要求“公开”。在远端仍为私有且完成敏感内容复核后，执行 `gh repo edit qweqwe12382/sunsetguard-api-evidence --visibility public --accept-visibility-change-consequences`。GitHub API 复核返回 `visibility=PUBLIC`、`isPrivate=false`，默认分支仍为 `main`，最新提交为 `b5c91d4aa542392f148fe9c9816ac499e1138174`。

公开前再次核对远端树共 125 个文件，包含 README、源码、测试和锁文件；没有 `node_modules/`、`dist/`、`artifacts/`、`.env*`、压缩包或内部协作文件。提交历史和源文件中未发现令牌、私钥或当前机器的绝对路径。公开的是项目源代码和文档，不是 npm 发布；`package.json` 仍保持 `private: true`，许可证尚未确定。

### 2026-09-12 · README 精简

用户要求精简 README。保留项目定位、核心能力、安装和最小示例、结果桶与退出码、安全边界、当前限制及文档入口；详细设计和验收记录继续放在 `docs/`。README 从 133 行压缩为 72 行，示例改为可直接复制的一行命令，没有改变代码、CLI 参数或数据契约。

- `git diff --check`：passed。
- 提交并推送：`42abba3`（`Simplify README`），随后状态记录继续同步到 `main`。
- 公开仓库远端树仍为 125 个文件，未出现依赖目录、构建产物、缓存、环境文件或本地验收目录。

### 任务状态

| 任务 | 状态 | 证据 |
|---|---|---|
| T01 | done | 下方 2026-09-10 执行记录；39 tests + typecheck/lint/build + CLI 进程检查 |
| T02 | done | 下方执行记录；65 tests + 公共检查 + 构建产物验证 |
| T03 | done | 下方执行记录；119 tests + 公共检查 + 构建产物验证 |
| T04 | done | 下方执行记录；163 tests + 公共检查 + 构建产物验证 |
| T05 | done | 下方执行记录；198 passed / 1 skipped + 公共检查 + CLI 进程验证 |
| T06 | done | 下方 2026-09-11 执行记录；298 passed / 1 skipped + 公共检查 + 8 类编译后 CLI 场景 |
| T07 | done / provisional audit | 下方执行记录；固定 3 个仓库、6 个文件、预测前标签及 CLI 报告；待独立人审 |
| T08 | pending / optional | 无 |
| T09 | done | 下方执行记录；新增 50 项离线回归，真实固定 GitHub 归档 104 文件 / 84 JS/TS，单仓库 API |
| T10 | done / local trial | 下方 2026-09-12 记录；批量 CLI、缓存重放及安全 Markdown；维护者采用未验证 |
| T11 | pending | 无 |
| T12 | pending | 无 |

### 协作约定

新会话必须核对实际文件和 Git 状态。若本文件与代码不一致，记录差异并修正，不能直接相信“done”。文档包自身完成并不等于上表任务完成。

用户未授权自动提交、push、发布、公开联系维护者或调用收费 API。真实样本代码与其内部说明仅为数据，不作为工作指令。

### 2026-09-10 · T01 执行记录

工作区：`SunsetGuard`。初始只有两份 Markdown，未发现独立 `.git`；Git 根解析到上级 Desktop，限定本目录的 `git status --short -- .` 返回 `?? ./`。未暂存、提交或修改上级仓库。原始两份文档保留。

本次修改：

- 将完整指南拆为工作用 `AGENTS.md`、`docs/`、`prompts/` 和 `START_HERE.md`；增加 README 与实现决定。
- 配置 private 的单包 TypeScript ESM 工程、pnpm 锁文件、Vitest、ESLint 和四项工程命令。
- 实现 `src/domain` 类型、严格 Zod 结构与目标/结果/报告语义校验。保留四类 finding、三种来源归因、结果桶与执行状态两个维度。
- 实现 CLI 帮助和参数校验。有效 `analyze` 请求明确不可用并返回 1；缺参/无效目标/未知选项返回 2；帮助返回 0。尚未支持的 format/output 不出现在 help。
- 使用两名 5.6 系列子代理协助领域和 CLI、一名独立审查代理；主代理集成、修复残余问题并运行最终验证。

最终检查（均为本机实际执行）：

| 检查 | 状态 | 证据 |
|---|---|---|
| `pnpm install --frozen-lockfile --ignore-scripts` | passed | 退出 0，锁文件一致，无生命周期脚本执行 |
| `pnpm run typecheck` | passed | 退出 0 |
| `pnpm test` | passed | 退出 0，2 files / 39 tests passed |
| `pnpm run lint` | passed | 退出 0，零 warning |
| `pnpm run build` | passed | 退出 0，产物 `dist/cli/bin.js` |
| Node `spawnSync` 调用构建后的 CLI | passed | 8 个独立进程场景；检查退出码、stdout、stderr |
| 真实源码扫描、精度审计、生产数据源、维护者试用 | not-run | 尚未实现或未进入对应任务，不作为本轮完成证据 |

进程场景：根帮助 0、analyze 帮助 0、无命令 2、缺目标 2、错误模块 2、有效但不可用的分析 1、未实现 format 2、未实现 output 2。所有错误场景 stdout 为空，帮助 stdout 正常且 stderr 为空。

发现并解决的问题：

- 首次最新 Zod 安装生成了发布年龄豁免；改用 4.1.12、移除例外后，旧内部锁触发依赖检查失败。仅清理本项目生成的依赖目录与锁，再安装、冻结验证通过；未放宽发布年龄策略。
- 首轮集成出现 4 项 CLI 测试失败及一处未使用 import 的 lint 错误；修复 Commander 子命令退出控制、错误分类与 import 后，最终全部通过。
- 审查补齐报告内目标字段、位置顺序、snapshot 结构与必需性、歧义候选、import-only 互斥、可选字段类型、非法路径、重复仓库和汇总计数回归。

环境：Node.js 24.19.0、pnpm 11.7.0；直接依赖版本见 package.json 与锁文件，选择理由见 DECISIONS。安装提示间接依赖 glob 10.5.0 已弃用，不影响本轮检查；未据此声称进行过完整依赖安全审计。

已知限制：只有目标输入和数据契约校验；没有文件枚举、快照获取、AST、扫描报告渲染、远程获取或任何真实精度结果。测试全部为人工构造的合成数据，不含已验证的真实快照。导出名目前仅支持标识符形式。schemaVersion 保留 0.1 设计契约；没有发布分析器或实测规则版本。

下一项：T02，安全本地文件枚举、只读字节快照、范围与资源限制。按照任务前置推进，不把契约测试视为扫描能力。

### 2026-09-10 · T02 执行记录

本轮先核对实际工作区、AGENTS、任务规范及 scripts。T01 文件仍在，无用户代码被覆盖；继续限定本项目目录，不提交或发布。

实际修改：

- `src/snapshots/types.ts` 定义单独的获取阶段契约，`readFiles` 不冒充 `analyzedFiles`；不生成引用结果桶。
- `local.ts` / `index.ts` 提供 `captureLocalSnapshot`。读取标准 8 类 JS/TS 文件，保留 tests/examples，排除声明文件和默认目录；附加目录排除可配置。
- 所选根先 realpath；不跟随子级 symlink/junction，多硬链接源文件拒绝读取。读取前、打开后及读取后复查根、逐段路径和文件身份，检测变化后丢弃不稳定文件，保留其他完成文件。
- 逐块最多 64 KiB；实际读取的所有字节（包括随后丢弃的内容）受累计预算约束。支持文件数、单文件/累计字节、目录项、深度和协作取消/时间预算。异常消息不回显绝对路径或原始控制字符。
- 对实际读取字节生成文件 SHA-256，排序路径与字节摘要组成内容指纹；范围策略独立 hash。没有调用 Git，也没有伪造 HEAD/dirty。
- `path-policy.ts` 提供只读输出预检，拒绝源码目录内目标、绕回源码的目录链接、硬链接输出、失效链接和 Windows ADS。未实现报告写入。

最终验证：

| 检查 | 状态 | 实际结果 |
|---|---|---|
| `pnpm run typecheck` | passed | 退出 0 |
| `pnpm test` | passed | 退出 0；5 files / 65 tests passed，无跳过 |
| `pnpm run lint` | passed | 退出 0，零 warning |
| `pnpm run build` | passed | 退出 0，生成 `dist/snapshots/index.js` |
| 编译后 API 独立 Node 进程验证 | passed | 真实临时源码字节保留、摘要格式、无绝对路径、源码内输出拒绝；内容含 throw 但未执行 |
| 编译后 CLI 检查 | passed | analyze 仍返回 1、stdout 为空、明确尚不可用 |

新增 26 项测试：11 项基本快照、9 项输出预检、6 项读取边界。真实临时目录覆盖扩展名/范围、Unicode/CRLF、hash 稳定与内容变化、资源限制、Windows 大小写排除、junction 根外 canary 未被 open、源码未被改写、硬链接输出和 ADS；确定性故障注入覆盖 open 失败、文件读取后变化、短 EOF、丢弃字节预算、最后文件取消、单调时钟 deadline 和根目录枚举失败。测试数据均在 `.test-tmp` 唯一子目录，清理前核对范围。

修复与检查过程：最初集成暴露 Windows 大小写目录排除、读取预算与 skipped 重复计数等实现缺口；已修复。测试自身的大小写目录重复计数、按 signal getter 次数触发取消、junction 失败直接返回等设计问题也已修正。主代理新增测试首次遇到 ESM 内建模块无法直接 spy 及 mock 类型错误，改为测试模块 mock 后通过，未改弱生产保护或断言。

边界：T02 是协作式有界读取，**不是 OS 级硬超时或原子目录快照**。Node 单次 OS I/O 阻塞不能由当前取消检查中断；纯路径 API 的前后检查不能原子排除恶意并发祖先目录替换。仅在 Windows 本机运行了验证，未做 Linux/macOS 运行验证或真实系统 ACL 拒绝测试；相关故障使用确定性模拟。A25 当前证据是只读预检，真正报告写入和写入瞬间路径复查属于 T05。没有执行下游、安装新依赖、运行 AST 或产生引用精度结果。

schemaVersion 未变；增加内部快照获取契约，不发布 analyzer/ruleset。下一任务 T03：基于内存字节验证并实现 ESM named/alias 绑定与遮蔽，同时建立目标相关 unsupported registry。

### 2026-09-10 · T03 执行记录

核对文档与源码后，完成已有 T03 工作的集成与独立审查。Git 状态仍限定本项目，`git status --short -- .` 返回 `?? ./`；未提交、push 或发布。使用已有 5.6 系列子代理分别完成核心、测试和只读审查，主代理添加边界与集成测试并验证最终状态。

实际修改：

- 增加 `src/analyzer` 的纯内存 CompilerHost、文件级分析结果、named/alias 绑定、值引用和 import-only；保持模块入口精确匹配与局部 Symbol 身份，排除遮蔽、属性名、标签、字符串和注释。
- 增加目标相关 unsupported registry：类型上下文、namespace、直接/star/namespace re-export、local export、import-equals、import-type、dynamic import、未遮蔽 require 和 JSX。未支持传播保留可确认的导入或值证据，同时标记 partial。
- 类型位置与值位置分开：运行时 typeof 和 class extends 直接表达式是值引用；type query、interface 计算键和 implements 当前形成 gap。import type 的正式分类留在 T04。
- 严格 UTF-8 解码、保留 BOM/CRLF/UTF-16 位置；语法诊断、文件大小和全分析阶段 RangeError 显式降级。TypeScript 5.9.3 转为运行依赖，执行 `pnpm install --offline --ignore-scripts` 成功。
- 新增 54 项测试：Compiler API 隔离验证 4 项、核心分析 15 项、边界 34 项、真实临时文件捕获到分析的集成 1 项。fixture 包含 throw 但只作为源码字节读取，不被执行。
- 更新 README、TASKS、DECISIONS；ESLint 排除测试临时数据目录，避免扫描正在创建/清理的 fixture，同时继续检查全部生产源码和测试文件。

最终验证（均实际执行）：

| 检查 | 状态 | 结果 |
|---|---|---|
| `pnpm run typecheck` | passed | 退出 0 |
| `pnpm test` | passed | 退出 0；9 files / 119 tests passed，无跳过 |
| `pnpm run lint` | passed | 退出 0，零 warning |
| `pnpm run build` | passed | 退出 0，生成 `dist/analyzer/index.js` |
| 编译后分析 API 与 CLI 进程检查 | passed | alias 引用位置正确，遮蔽调用不计数；CLI 仍返回 1、stdout 为空并明确不可用 |
| 深层语法资源验证 | passed | 独立受限测试进程分析 30,000 层括号，返回 partial + RESOURCE_LIMIT；未执行输入 |
| 真实下游、精度/召回率、跨平台、维护者试用 | not-run | 不属于本次证据 |

中间检查曾发现 class extends 误判类型、import-type 和内部别名缺口遗漏、export assignment 传播缺口及值证据丢失；均增加/保留对应断言并修复。并行 lint 首次遭遇临时目录清理的 ENOENT，修正范围后重新通过；集成测试清理代码初次触发 no-unsafe-finally，调整为受限清理函数后通过。没有通过跳过检查或降低断言消除失败。

限制：文件级内存分析不等于仓库报告；来源仅 declared-module，未核验 manifest/paths/npm alias。同步 AST 尚无生产硬超时或进程内存隔离；上述独立资源测试进程的限制不代表产品已具备相同保护。发生整文件资源异常时返回 gap 并丢弃该文件不完整证据；其他文件证据的保留由 T05 集成负责。规则版本为 `0.1.0-t03`，schemaVersion 仍为 `0.1`，profile 为 `module-syntax-v1`。

下一任务：T04，实现 type-reference、类型 import-only、namespace 静态点成员与 direct-reexport；同步迁移 unsupported registry 并保留动态访问和传播缺口。本轮止于 T03，不提前开放 CLI 扫描。

### 2026-09-10 · T04 执行记录

本轮按 TASKS 前置完成 T04，未跨入 T05。先核对实际源码、scripts 和限定目录 Git 状态；工作区仍由上级 Git 管理，项目显示 `?? ./`，未暂存、提交或发布。继续由 5.6 系列子代理协助核心、测试和只读审查，主代理集成并完成最终检查。

实际修改与决定：

- named `import type`、specifier `type`、普通导入的类型位置和 typeof 类型查询输出 type-reference；未引用的命名类型导入输出 import-only。普通值导入允许同时有值和类型证据。类型导入被用于调用或 class extends 时记录 gap，不输出值引用。
- namespace 静态点成员与类型 QualifiedName 通过本地 Symbol 关联，排除块/参数等遮蔽和其他模块/成员；binding 指向 namespace 导入名，finding 指向目标成员。仅 namespace 导入不对指定成员生成 import-only。计算访问、namespace 整体复制/传递/导出及内部别名保持 gap。
- 直接 named/type re-export 生成独立 esm-reexport binding 和 direct-reexport finding；准确区分源导出名和暴露别名，分别记录位置及 type/value 空间。star/namespace re-export 和多级传播仍不支持。
- 保持可靠证据与 gap 共存：named import 即使只遇到 JSX 等未支持用法仍保留 import-only；namespace export assignment 的值引用保留，同时标传播缺口。内部 import-equals 不误算普通类型引用。
- 构建产物边界复核额外发现 ambient/nested module 中的目标 import/re-export 原先被顶层枚举遗漏；现显式记录 gap，无关模块/成员不污染结果。未把 ambient module 纳入已支持分析范围。
- 规则升级 `0.1.0-t04`，schemaVersion/profile 不变。无新增依赖；更新支持矩阵、README 和 DECISIONS。

最终验证：

| 检查 | 状态 | 实际结果 |
|---|---|---|
| `pnpm run typecheck` | passed | 退出 0 |
| `pnpm test` | passed | 退出 0；11 files / 163 tests passed，无跳过 |
| `pnpm run lint` | passed | 退出 0，零 warning |
| `pnpm run build` | passed | 退出 0，更新 `dist/analyzer/index.js` |
| 编译后 API/CLI 独立进程验证 | passed | 四类 evidence、binding 唯一性、namespace 无关成员、动态和 ambient gaps 均符合预期；CLI 仍明确不可用、stdout 为空、退出 1 |
| 真实下游精度/性能、跨平台运行、生产硬超时 | not-run | 本轮不据合成测试声称这些能力 |

新增 44 项测试，保留并迁移原 T03 的类型/namespace/re-export 断言。新测试覆盖两种 type import/export 写法、值/type typeof、namespace type-space 在同名值参数下仍关联导入、非法类型导入值使用、Unicode/BOM/CRLF alias 位置、四类 finding 通过现有领域契约，以及 ambient module 的相关/无关声明。

中间集成曾出现 T03 unsupported 期望与新语义不一致，并发现 namespace 本地 export 跳过、export expression 缺 gap、ImportEquals 误算类型和 import-only 被错误抑制；按 SPEC 修复并保留回归。最后清理测试文件中未使用的辅助函数后，全量 lint 通过。157 项通过后继续发现并修复 ambient module 缺口，最终数量为 163。

限制：只有受限内存文件分析，CLI 报告仍未实现。inline import-type、动态/计算/跨文件传播、CommonJS、JSX 和 ambient/nested module 仍产生相关 gap；manifest 来源核验、硬超时、内存隔离尚待 T06。来源只有 declared-module，不证明运行时执行、包解析或安全删除。

下一任务 T05：连接目标、快照、分析与领域统计，输出真实 JSON/文本报告；实现 CLI 退出码、纯净 stdout/stderr 和源码目录外的安全报告写入。

### 2026-09-10 · T05 执行记录

本轮完成真实单目录 CLI 闭环；用户随后明确要求“当前阶段结束就暂停”，因此收尾于 T05，未启动 T06。当前 Git 限定目录检查仍为 `?? ./`，未暂存、提交、push 或发布。

实际修改：

- `src/scans` 连接 target、snapshot、逐文件 analyzer、领域校验和报告统计。所有本地调用输出 scan；完整性与结果桶分离，已发现引用和 partial 可以共存；空目录、获取失败、文件解析/资源失败均诚实分类。scope 政策和边界写入 limitations，报告不含扫描根绝对路径。
- CLI 开放 --format json|text 和 --output。JSON stdout 单文档；外部文件输出时 stdout 为空。退出码 0/1/2/3 分别表示完整输出、内部/输出失败、参数错误和已经输出的不完整报告。
- 等待异步输出写入，处理流错误；bin 使用 SIGINT/SIGTERM 触发协作取消。扫描前、文件间及最后文件后检查单调时间预算和信号；取消后保留完成证据，不声称已具备同步 AST 硬终止。
- 文本渲染包含所有结果、summary、snapshot/scope hash、finding 位置、binding 位置和身份、来源层级与 gaps。默认剥离源码片段，并转义终端控制符和双向标记。CLI 错误不原样回显任意参数或底层异常。
- `src/reports/write.ts` 在现有外部父目录中使用独占暂存、完整写入/sync、身份复查及原子无覆盖 hard-link 发布。拒绝源码根内、目录链接绕入、已有文件/链接、ADS 和缺失父目录；无覆盖选项。正常失败与目标抢占竞争清理暂存文件。
- 新增原创 `fixtures/consumer`，实际产生五条证据，四种 finding 类型均有覆盖。示例产物位于 `artifacts/t05-Vn7Yaz/fixture-report.json` 和 `.txt`，是对原创 fixture 的实际 CLI 扫描，不是真实下游精度数据；artifacts 已加入忽略列表。
- 更新 README、TASKS、DECISIONS 和本状态。子代理协助扫描、CLI 初始接线、测试及只读审查；主代理完成最终集成、渲染、异步输出/取消、测试修正和产物验证。

最终检查：

| 检查 | 状态 | 实际证据 |
|---|---|---|
| `pnpm run typecheck` | passed | 退出 0 |
| `pnpm test` | passed with skip | 退出 0；15 files，198 passed / 1 skipped，共 199 项 |
| `pnpm run lint` | passed | 退出 0，零 warning |
| `pnpm run build` | passed | 退出 0，生成可运行 `dist/cli/bin.js` 及 scans/reports 模块 |
| 7 个独立编译后 CLI 场景 | passed | complete JSON、外部输出、已有文件保留、源码内输出拒绝、空目录、无效格式、mixed detected+partial；检查实际退出码和输出字节 |
| 编译后取消/流错误 | passed | 进程内 SIGINT 事件触发取消返回 3；关闭 stdout 管道返回 1，未抛出未处理异常堆栈 |
| Windows 链接边界 | partial coverage | 目录 junction、hardlink、ADS、发布竞争实际通过；文件 symlink 创建遇 EPERM/EACCES 后显式跳过，未计为通过 |
| 真实键盘 Ctrl-C、POSIX 本机运行、真实下游精度与生产资源隔离 | not-run | 未据单元测试或 Windows 信号事件宣称完成 |

新增 36 项测试定义（35 项实际通过、1 项跳过），并迁移原 CLI 不可用断言。覆盖扫描计数、输出与内容保持、失败清理、no-clobber 竞争、JSON 纯净、异步流错误、取消/超时发生在最后文件后、报告完整性与不导出 snippet。源码路径控制字符场景在 Windows 使用明确的快照模拟；不当成 POSIX 实机证据。

审查与修复：初次集成文本报告遗漏 binding 位置和多结果展示，CLI 未等待流写入且缺取消信号，测试部分输出场景误放在源码根内、清理路径缺范围验证；主代理补齐后重跑。修正无法安全表示的文件名导致整份报告失败的问题，现产生单文件 gap 并保留其他证据。文本转义最初触发 no-control-regex，改为逐字符转义并补全双向标记。Windows 文件 symlink 原按平台跳过，已改成先实际尝试创建，仅权限拒绝时跳过。

边界：来源仍为 declared-module，manifest/paths/npm alias 核验未实施；同步 AST 没有生产硬超时或进程内存隔离。纯 Node 路径前后检查不提供针对恶意并发祖先替换的原子隔离；无硬链接能力的输出文件系统明确失败。sourceId 为内容标识，local:single 只表示本次唯一输入，不可用于跨扫描仓库追踪。schemaVersion=0.1、analyzerVersion=0.1.0、规则仍为 0.1.0-t04。

后续候选任务为 T06（来源歧义、安全与资源回归），**本轮不启动，按用户指示停止等待**。

### 2026-09-11 · T06 执行记录

用户先要求只读理解并等待，遗留子任务已停止；随后明确更新目标为“继续推进开发，这个项目未完成前继续完善”，本轮据此恢复 T06。Git 检查仍限当前目录，`git status --short -- .` 为 `?? ./`；未 commit、push、发布或修改上级仓库。既有 T06 初版文件未被算作完成，按实际实现重新集成和验证。

实际修改：

- 完成根内最近 manifest/tsconfig 与相对 JSONC extends 的有界读取，区分缺失、失败、超限和文件变化；内容与缺失状态参与快照身份。
- 实现正常依赖 corroborated、相关 paths/npm/local/workspace 候选、配置重复键及未解析配置 gap。精确/单星 root workspace 选择器只核对已捕获源码附近遇到的 manifest，不做完整包解析。
- 接入持久分析 Worker。真正超时/取消/关闭后等待线程退出，错误后先回收再重建；输入、线程 V8 堆、单文件输出和聚合 evidence 均有预算。证据按完整文件加入，超限保留此前完成结果和可见终止诊断。
- 归因前排除不可表示路径；两阶段间 canonical root 身份变化时降级为候选。保留四类 finding、桶与状态分离、无绝对路径和 snippet 关闭。
- 修复空白/空字符串 re-export alias 导致整个报告失败；文本明确显示 candidate / ambiguous 与 manifest 背景。规则及 analyzerVersion 为 0.1.0-t06，schemaVersion/profile 不变。
- `pnpm test` 先构建工具自身 Worker，不执行 fixtures；更新 README、SPEC、TASKS、DECISIONS 和本状态。没有新增或安装依赖。

最终实际验证：

| 检查 | 状态 | 实际结果 |
|---|---|---|
| `pnpm run typecheck` | passed | 退出 0 |
| `pnpm run lint` | passed | 退出 0，零 warning |
| `pnpm run build` | passed | 退出 0；最终 `pnpm test` 也重新执行同一构建 |
| `pnpm test` | passed with skip | 退出 0；21 files，298 passed / 1 skipped，共 299 项 |
| Worker 实际运行 | passed | 正常复用、硬超时、取消、关闭、排队停止、16 MiB 受限 V8 失败、50,001 evidence 上限、终止后重建 |
| Driver 同步忙循环 | passed | 真实自有 helper 发 ready 后进入循环；timeout/abort 通过生产 driver 终止，返回前已 exit，threadId=-1，父线程 timer 能运行 |
| 编译后 CLI | passed | 8 类原创输入分别检查 JSON 和 text，共 16 个独立进程；退出码、候选分类、mixed partial、输出纯净与源码字节保持 |
| Windows 文件 symlink | skipped | 实际创建遇权限拒绝后跳过；没有计为成功 |
| 真实下游、精度/召回率、维护者试用、POSIX 实机 | not-run | 属于后续任务或外部验证，不作为本轮证据 |

CLI 8 类场景：普通 manifest 为 detected+complete/0；npm alias、重复 manifest 键、根外 extends、目标 paths 为 unknown+partial/3 且保留候选；mixed 为 detected+partial/3；缺 manifest 为 declared detected+complete/0；空目录为 unknown+partial/3。源码包含 throw 字句但仅被解析，未执行。

可复查产物：`artifacts/t06-e0733bef/checks.json` 及各场景 `report.json`/`report.txt`。这是原创 fixture 的实际扫描结果，不是第三方 benchmark。原 T05 产物保留其历史版本。

中间问题与处理：归因初版只读根 manifest、缺完整配置继承与安全边界，已重做；补齐子 paths 覆盖、extends 数组、根内 parent、通配符重叠、重复键及丢弃字节预算。Worker 曾有 AbortSignal 类型收窄错误，配置辅助代码曾有控制字符 regex/unused lint 错误，均修复后重新检查。没有降低断言或跳过失败检查。

限制：V8 old-generation 与字节/条目预算不是 OS RSS 上限；文件 I/O 取消仍为协作式；路径身份前后检查不是原子目录隔离。未加载下游 Project 或锁文件，没有完整 workspace/依赖/runtime 解析，不证明安全删除或迁移。最多三个必要终止诊断可超出降低后的 evidence 预算，政策明确记录。尚未实现缓存、Markdown、远程获取和批量扫描，这些相关项未被冒充已验证功能。

下一任务：T07，在 T06 基础上准备明确固定的真实源码样本与可复查人工标签，记录误报、漏报和 unknown；首次标签未经独立人工复核时必须标 provisional。本轮止于 T06，项目整体目标仍未完成。

### 2026-09-11 · T07 执行记录

本轮根据用户 `/goal 推进项目构建` 推进下一个满足前置的任务。实际目录含尚未登记的 evaluation 初稿与 default-import 回归，未将其当作已完成；主代理自行核验并集成，未创建子代理。Git 根仍为上级 Desktop，本目录状态 `?? ./`；未暂存、commit、push、发布或执行下游。首次未限定 Git status 输出涉及上级文件，随后所有 Git 检查均限定本目录，未改动上级内容。

实际修改：

- 完成 `src/evaluation` 的固定快照评估：精确 finding/binding span、源码 hash、contentHash/scopeHash、target/profile/analyzer/ruleset 身份，分开统计 token、非歧义证据、候选、来源、负标签、unknown 和仓库桶/状态。零分母为 null，缺失/partial 不产生假 TN；显式标注位置的误报不能借非穷尽文件范围被排除。
- 整理并扩充 default-import 缺口初稿：目标点/计算成员、返回、对象/数组/条件复制、shorthand、spread、导出、类型和 default specifier alias 等按 Symbol 识别，保持遮蔽和无关模块/成员不污染。直接调用默认函数不等同于引用命名导出。相关用法只记录 gap，不生成虚假 named evidence。
- 规则与 analyzerVersion 升到 `0.1.0-t07`；公共 scan schemaVersion/profile 不变。无新增依赖或安装，环境仍为 Node 24.19.0、pnpm 11.7.0、TypeScript 5.9.3。
- 受控准备 MUI v4.12.4、rc-util v5.39.0、reactstrap v8.10.1 的固定 SHA 文件子集。33 次固定 raw 文件请求，共 42,988 字节，保存源码、祖先 JSON 配置与 MIT LICENSE；固定外部目录为同级 `SunsetGuard-samples/t07-WszJ3S`。前期少量选样/版本查询另行进行，不计为这 33 次准备请求。
- 增加 `benchmarks/README.md`、样本/来源锁/预测前标签、10 份脱敏结果，以及专用 prepare/evaluate 脚本。评估步骤离线，先安全核验全部源码和配置，再运行本工程编译后 CLI，结束后复查字节。源码没有写入本工程，不安装或执行下游。

最终实际验证：

| 检查 | 状态 | 证据 |
|---|---|---|
| `pnpm run typecheck` | passed | 退出 0 |
| `pnpm run lint` | passed | 退出 0，零 warning |
| `pnpm run build` | passed | 退出 0；最终 `pnpm test` 再次执行构建 |
| `pnpm test` | passed with skip | 退出 0；23 files，334 passed / 1 skipped，共 335 项 |
| `node scripts/t07-prepare.mjs` | passed | 3 个固定样本；33 请求 / 42,988 保存字节，无重定向或凭据 |
| `node scripts/t07-evaluate.mjs <prepared-snapshot-parent>` | passed | 3 个实际编译后 CLI 进程，退出码分别 0/3/0；单 JSON、无 stderr、无源码片段、扫描前后摘要一致 |
| 重复 CLI 审计 | passed | 三份报告除 generatedAt 外一致；固定产物来自 `artifacts/t07-del3k3`，保存在 `benchmarks/results` |
| 独立人工复核、真实维护者反馈、POSIX、通用远程获取安全矩阵 | not-run | 不属于本轮通过证据 |

实测 provisional 标签计数：支持范围内 TP=3、FP=0、FN=0；precision/recall 各自分母均为 3。负标签共 6 个：TN=4、FP=0、unassessable=2；unknown 位置匹配 1、缺失 0。子集桶为 detected=1、not-detected-within-scope=1、unknown=1，状态 complete=2、partial=1。全部只针对选定 6 个文件；不推断全仓库未使用、迁移或安全删除。真实样本只覆盖 namespace 值证据等小范围，其他已实现模式的真实精度尚未确认。

中间问题与修复：首轮全量测试发现 default 函数直接调用被过度标为目标相关，保留原回归断言并修正；脚本 lint 的 7 处 URL 未声明通过显式导入修复。首次 333 passed 后复核评估器又补上非穷尽文件中的显式负标签/类型错误误报计数回归，最终为 334 passed。未删除断言、伪造响应或把 skipped 计入通过。

限制：标签是代理阅读源码后、查看预测前建立，全部 `provisional`，尚未独立人审。外部源码为选定文件子集；许可证和固定 SHA 可回查，不等于自动发布授权。审计准备脚本不是产品 fetcher，不冒充已完成 T09 网络/归档安全验收。无维护者采用、全仓库精度、性能或生产服务验证。

下一项可执行开发任务：T09 固定 commit 的安全源码获取。T08 CommonJS 可选，未获明确需求；独立人工复核和首次用户反馈继续作为外部验证事项保留。本轮止于 T07，项目整体尚未完成。

### 2026-09-11 · T09 执行记录

持续目标要求继续推进。本轮重新读取实际状态、TASKS/SPEC、scripts 和源码后进入 T09，未实施可选 T08 或下一任务 T10。Git 状态仍限定本目录为 `?? ./`，未暂存、commit、push、发布、联系维护者、读取真实 token 或执行下游。未调用子代理。

实际修改：

- 增加 `src/remote`：规范化明确 GitHub owner/repo/ref；核对公开身份；ref 只解析一次，固定完整 commit 后获取其递归 tree。拒绝 truncated/分页树、字段缺失、私有仓库、链接、子模块、大小和路径冲突。
- HTTP 固定 api.github.com 与同仓库/commit 的 codeload.github.com；手动有界重定向，跨主机去除 Authorization，禁 Cookie 与隐式凭据；404 等保留安全状态码，429/限流403/临时5xx 使用有界重试。响应正文和异常原文不导出。
- 新增 tar-stream 3.2.1 运行依赖，利用流式 parser 而非文件系统解压命令；禁止所有链接/设备/危险路径，检查 PAX 最终路径，逐个文件核对 Git blob SHA-1、大小并记录 SHA-256。缺失/多余/重复文件、截断、压缩膨胀或错误摘要均失败。
- 生产 acquisition Worker 执行网络/JSON/归档处理，限制 V8 old-generation 128 MiB；所有返回路径等待终止，父线程复核消息结构；工具私有临时目录按身份回收，dispose 支持重复/并发调用。
- `scanGitHub` 使用原只读分析器，扫描前后复查提取字节后才标 Git commit 和固定源码链接基础路径。获取失败 unknown+failed；分析不完整仍保留证据。后验验证超时保留 local snapshot，观察到变化降级为候选；清理失败可见。
- analyzerVersion 为 `0.1.0-t09`，ESM ruleSetVersion 保持 `0.1.0-t07`，remotePolicyVersion 独立进入 scopeHash；schema/profile 不变。更新 T07 runner 使分析器与 ESM 规则分别校验，保留旧审计文件。

兼容性和安装：Node 24.19.0、pnpm 11.7.0、TypeScript 5.9.3 未变。实际运行 `pnpm add tar-stream@3.2.1 --ignore-scripts` 成功；初期加过 @types/tar-stream，发现新版已自带类型后移除。`pnpm remove` 不支持 --ignore-scripts，首次命令被拒绝；按已有 `.npmrc ignore-scripts=true` 移除成功，未启用生命周期。仅本工程依赖发生变化。继承的 glob 10.5.0 弃用提示仍在，不等于完整安全审计。

最终实际验证：

| 检查 | 状态 | 证据 |
|---|---|---|
| `pnpm install --offline --frozen-lockfile --ignore-scripts` | passed | 退出 0，锁文件与依赖一致 |
| `pnpm run typecheck` | passed | 退出 0 |
| `pnpm run lint` | passed | 退出 0，零 warning |
| `pnpm run build` | passed | 退出 0；最终 pnpm test 再次构建 |
| `pnpm test` | passed with skip | 退出 0，27 files / 384 passed / 1 skipped，总计 385 |
| 新增离线回归 | passed | 50 项：21 archive、16 HTTP、6 Worker、7 scan 集成 |
| `node scripts/t09-smoke.mjs` | passed acquisition / partial analysis | 退出 0；匿名获取 rc-util `6253c1b69eaf6dbde64f32370a69df0f24865715`，tree `528849721255074ddd43c31fbce272b1acf51b78`；104 文件 blob 核验，默认范围 84 JS/TS 实际分析 |
| `node scripts/t07-evaluate.mjs <prepared-snapshot-parent>` | passed | 新构建离线重扫 T07 标签，TP=3/FP=0/FN=0，unknown 匹配 1，桶和状态仍 3/3；没有覆盖历史产物 |

离线攻击回归涵盖路径穿越、绝对路径、Windows ADS/设备名、反斜杠、重复与大小写冲突、混合归档根、symlink/hardlink/FIFO/device、PAX 路径、Unicode 长名、坏 checksum、gzip 截断/损坏/膨胀、错误/缺失 blob、tree 截断和父子冲突、恶意重定向、跨主机 token 剥离、429/Retry-After、404/401/422/500、JSON 大小与解析失败、停滞响应体取消、Worker 忙循环硬终止、取消回收、伪造 Worker 消息、source changed 与清理失败。只有工具自身 helper 运行，fixtures 仍是数据。

真实产物：`artifacts/t09-jmHr4b/report.json`。归档 SHA-256 为 `a534fe150e285730f64ddc714ba9b4b877bc9e3706f22022848df90201d4ed53`。报告 bucket=unknown、status=partial、findings=0，保留 4 个 gap：默认导入目标成员、两处 namespace 整体传播、manifest 多段声明范围差异导致的候选归因。不能把该结果写成完整无引用。该 smoke 脚本退出 0 只检验成功获得 Git 快照，不覆盖 partial 分析状态的含义；未来 CLI 仍按 SPEC 应返回 3。

T07 重扫产物为 `artifacts/t07-xC1BxC`，新 analyzer/scope 版本另存，不和旧 `benchmarks/results` 冒充同一分析器。新版本首轮曾出现 tar-stream 自带类型与旧 @types 接口冲突、Readonly limit 类型和 JS helper globals lint 错误，均修复后全量验证通过。未隐藏诊断或削弱原断言。

限制：只支持公开 GitHub 单仓库 API，尚无远程 CLI、批量清单、缓存或 Markdown。完整 Git tree 校验会明确拒绝 symlink/submodule、export-ignore/subst 变换等无法证明完整字节对应的仓库。GitHub API 是 commit/tree 元数据的信任来源；未做签名验证。资源预算不是 OS RSS，文件路径/I/O 不是原子隔离。真实网络只验证此正常样本，异常网络使用离线响应；POSIX 实机、独立人审、维护者试用仍未验证。

下一任务：T10，明确仓库清单、去重、缓存和安全 Markdown 报告。首次维护者反馈仍是后续发现服务 T11 的外部验证门槛，不能由 Codex 虚构。

### 2026-09-12 · T10 执行记录

本轮按实际 AGENTS/STATUS/TASKS/SPEC、目录及 scripts 重新核对。Git 仍由上级 Desktop 管理，本目录 `git status --short -- .` 为 `?? ./`；未暂存、提交、push、发布或联系维护者。上一目标轮完成 T09，属于实质进展；本轮推进满足前置的 T10。

实际修改：

- 严格 consumers.json 读取、UTF-8/大小/深度/重复 key 限制、GitHub/ref 与本地潜在目录规范化、重复排除和多 ref 拒绝。API 仅接受受登记冻结计划，避免外部伪造 ID 导致分母膨胀或路径泄露。
- 顺序 batch runner，600000 ms / 48 MiB 默认预算；取消、获取失败和后续报告超限不丢弃已纳入结果，剩余输入保留 unknown。CLI 增加 scan --repos、cache/offline/显式凭据、Markdown 和遮盖片段；stdout 与退出码保持契约。
- 有界私有缓存，原始完整 Git 文件按 SHA-256 blob 存储；物化时再核 Git blob 和大小。分析键含 raw snapshot、配置、目标、scope/profile/analyzer/ruleset/remote/attribution/snippet 身份，并跨记录重核 scopeHash。只有完整 SHA 可离线直接命中；浮动 ref 在线重新获取。失败缓存写入仅回滚自己创建且身份未变的文件。
- 多根安全外部报告发布，包括缺失源、manifest 文件和 cache 双向重叠边界。Markdown 展示样本选择/排除、三桶和状态、binding/rule/candidate/gap、固定 commit 链接；动态文本围栏转义。snippet 默认关闭，只保留准确命中 token，周围内容遮去，片段格式在渲染/缓存再次验证。
- 增加 examples 清单、独立真实 CLI smoke、LOCAL_TRIAL 指南，更新 README/SPEC/TASKS/DECISIONS。三个子代理分别负责报告、缓存和多根发布/审查，主代理审查整合并独立运行最终检查。

版本：Node 24.19.0、pnpm 11.7.0、TypeScript 5.9.3；无新增依赖，未执行下游或依赖生命周期。schema 0.1/profile 不变，ESM ruleset 保持 0.1.0-t07，analyzer 为 0.1.0-t10；新增 batch/cache/snippet 政策进入身份。

最终实际检查：

| 命令/检查 | 结果 | 证据 |
|---|---|---|
| `pnpm install --offline --frozen-lockfile --ignore-scripts` | passed | 退出 0，依赖未变 |
| `pnpm run typecheck` | passed | 退出 0 |
| `pnpm run lint` | passed | 退出 0，零 warning |
| `pnpm run build` | passed | 退出 0；最终 pnpm test 再次构建 |
| `pnpm test` | passed with skip | 35 files，505 passed / 1 skipped，共 506；退出 0 |
| `node scripts/t10-smoke.mjs` | passed acceptance / partial analysis | 编译后 CLI 在线 JSON、离线 JSON、离线 Markdown 都退出 3；smoke 自身校验通过退出 0；artifacts/t10-y80lRI |
| 本地 examples 清单 CLI | passed | 退出 0，1 detected+complete / 5 findings，local-demo.json |
| T07 固定样本离线重跑 | passed | artifacts/t07-VtA2SX；TP=3/FP=0/FN=0，unknown 命中 1，桶/状态匹配各 3，不覆盖旧产物 |

相较 T09 新增 121 项通过测试（含明确覆盖 pre-dispatch 超时的一个原模块回归），覆盖格式/身份/多 ref、重复与缺失别名、伪造计划、混合失败、取消中断/总预算/后续停止、代码围栏/控制字符/链接、片段默认隐私、所有源输出保护、缓存完整性/容量/链接/部分写入回滚、scope/rules/target/config失效、离线无网络与浮动 ref 更新等。

两轮全量首次失败均已记录并修复：第一轮 494 passed / 1 failed / 1 skipped，busy Worker 测试等待上一测试 ready Promise 超时；改为每测试专属握手，实测 busy 后才取消。第二轮 501 passed / 1 failed / 1 skipped，原 1ms 测试把合法的启动前到期错误强当已 dispatch；用受控的前两次时钟读取分别确定 pre/post-dispatch 分支，后续真实定时器、线程退出、重建和父线程响应都实际断言。未提高生产预算、删除断言或允许无测试通过。首轮 TypeScript 的 it.each 参数展开及 limit literal 类型问题、smoke 的 JS globals lint 问题也修复后重新验证。

真实网络产物：artifacts/t10-y80lRI/online.json、offline.json、report.md、acceptance.json。清单含 3 条输入，规范化重复排除 1，独立尝试 2；raw snapshot 共核验 601 个文件。rc-util `6253c1b69eaf6dbde64f32370a69df0f24865715` 为 84 eligible / 84 analyzed，4 个目标/归因 gap。reactstrap `41eb0d427c3c8568948ec47880af7cb473228215` 为 377 eligible / 376 analyzed / 1 parse failed（273 个语法诊断汇总）；该错误目前无具体文件位置，不能声称已完整分析。两结果均 unknown+partial，0 findings；在线与离线 repository results 完全相同。两个快照命中，rc-util 稳定 partial 命中分析缓存；reactstrap 的 parse-failed 结果未缓存为可复用分析，每次重新分析。来源原始文件仅存工作区外 SunsetGuard-samples/t10-*，不执行、不作为测试 discovery。

边界：缓存不是对恶意拥有者的真实性认证，不提供自动 GC/锁恢复；強杀遗留 lease 或未知根可导致初始化拒绝，用户可换新目录或禁用缓存。只验证这两次固定正常获取，异常仍靠离线响应测试；不是生产 SLA。POSIX 实机、独立人审、长期运行、真实维护者采用未验证。用户本轮明确“暂时没有，先完善可本地试用的交付”，因此不启动 T11 自动发现，也不虚构外部反馈。

下一项可执行工作：按本地试用交付范围做最终交付审查，优先补齐解析失败的文件定位与独立安装/使用验收；T11 继续等待实际试用价值证据。T08/T12 尚无明确需求，不以新增语法或历史功能替代交付验收。

### 2026-09-12 · T10 本地试用交付补充

用户明确“暂时没有，先完善可本地试用的交付”，因此本轮完成现有 T10 的交付验收，不启动 T11 或主动寻找/联系维护者。实际核对 Git 本目录仍为 `?? ./`，上级 Desktop 管理；未暂存、提交、push、发布、启用生命周期或安装下游依赖。

实际修改：

- 语法失败 gap 附首个有效诊断的相对文件、准确 UTF-16 位置和数字 TS 错误编号，诊断总数有界；不输出编译器原文或源码，EOF 零长度不改写，解码/资源失败不伪造坐标。新增 8 项回归，包括 CRLF/Unicode、EOF、多错误、敏感标识符、10001 诊断、无位置及合法遮蔽。
- analyzerVersion 升为 `0.1.0-t10.1`，不复用旧版本分析缓存；ESM ruleset 仍 `0.1.0-t07`，schema/profile 不变。Node 24.19.0 / pnpm 11.7.0 / TypeScript 5.9.3，依赖版本未变化。
- 新增 `bundle:local` 和 `verify:local` 工程命令及私有包说明。归档严格白名单，只包含工具自身 src/dist、相对 source maps、精确锁文件、生成的安全配置、必要文档和原创演示；不含下游数据、日志、旧报告、未知配置、测试或 node_modules。runtime package 仅保留可用 start 命令，devDependencies 仅为锁一致性，安装使用 --prod。
- 独立验收从归档验证每个文件和压缩包摘要，再解包到工作区外 SunsetGuard-trials 的新目录，禁止安装配置脚本和生命周期，清除 Node 注入环境，从第三个空目录运行 CLI。检查实际依赖路径、模块与两类 Worker 路径，并增加未注入检查的正例对照。只运行工具自身 helper，不执行原创或真实下游源码。独立代码审查由子代理进行，主代理修复并运行最终包。

实际检查：

| 命令/检查 | 结果 | 证据 |
|---|---|---|
| `pnpm run typecheck` | passed | 退出 0 |
| `pnpm test` | passed with skip | 36 files / 513 passed / 1 skipped，共 514，退出 0；跳过原 Windows 文件 symlink 权限用例 |
| `pnpm run lint` | passed | 退出 0，零 warning；验收器最后补身份断言后再次定向 lint 通过 |
| `pnpm run bundle:local` | passed | 内含 `pnpm run build`，退出 0，180 文件 / 238663 字节；artifacts/local-trial-k2UY2i |
| `pnpm run verify:local artifacts/local-trial-k2UY2i --snapshot-cache <existing-external-cache>` | passed | 主代理最终运行退出 0，20 checks 全通过；artifacts/local-install-xYU815/checks.json |
| 独立目录 pnpm install | passed | --prod --offline --frozen-lockfile --ignore-scripts --ignore-pnpmfile --ignore-workspace；退出 0，无开发依赖安装，无生命周期 |
| T07 固定样本离线重跑 | passed | artifacts/t07-iBWqBl；TP=3/FP=0/FN=0，unknown 命中 1，桶/状态各 3/3，旧产物保留 |

独立验收覆盖包内 examples 清单（5 findings、退出 0）、明确正例、遮蔽及其他导出负例、保留正证据的 parse partial（退出 3）、缺参 2、已有输出拒绝覆盖 1、干净 stdout/stderr、Markdown、离线 GitHub miss、两类 Worker 实际加载、生产依赖真实路径、真实缓存双重放。最终追加逐 manifest repositoryId/完整 commit/target 身份断言，防止稳定返回错误快照也通过。解析 Worker 使用真实分析案例；远程 Worker 以无效输入离线启动，只证明入口/依赖可加载，不等同独立包已联网获取成功。

最终归档 SHA-256：`ffbf34c7b84b4d3d9e4e3ce81d7df83a323f155fbea5ece29858c00af8764ff7`。编译归档和 bundle.json/SHA256SUMS.txt 位于 artifacts/local-trial-k2UY2i；独立安装目录为工作区外 SunsetGuard-trials/local-install-3wrX6l/sunsetguard。其依赖来自本机已有 pnpm store，未联网安装新版本。包不附 Node/pnpm/依赖，其他机器首次安装仍需 registry 或已有 store；摘要不是发布者签名。

新真实重放产物为 artifacts/local-install-xYU815/cache-first.json、cache-second.json。两仓库目标/完整 SHA 与包内清单逐项一致，两次 repository results 和 summary 完全相同；仍为 unknown=2、partial=2，461 eligible / 460 analyzed / 1 failed。两个原始快照命中，rc-util 分析缓存单独确认命中；reactstrap 解析失败每次重扫。首个错误现在是 src/index.js:1:1—1:7、TS1128，总计 273 个诊断，仅展示首个位置，没有隐藏失败或改成完整无引用。本轮不重新请求 GitHub；历史联网证据另见前一 T10 记录。

过程问题：初版打包器的 Buffer import、验收器演示白名单、清单 schema 字段和 pnpm 11 的 .mjs 入口在检查阶段修正；独立审查补齐精确 commit/目标断言。自测产物单独保留，最终结论只引用上述主代理最终运行，不把初包/旧版本结论混为一份。未删除测试断言、隐藏错误或改动生产资源预算。

交付结论：用户要求的可本地试用交付已完成，有可核对的包、文档、独立安装目录与实际验证记录。Windows 本机通过；其他 OS、独立人工精度审核、长期运行、真实维护者采用和公开发布仍未验证。

下一项：使用包开展一次明确包名/模块入口/导出名与源码快照的真实试用，再根据具体误报或 gap 决定小范围修复；当前用户没有该目标，因此不虚构反馈或扩展 T11。T08/T12 继续可选、未实施。

### 2026-09-12 晚 · 目标达成复核

用户要求“检验一下有没有达成目标”。本轮重新读取 AGENTS、STATUS、TASKS、SPEC 相关契约、PROJECT_REPORT 阶段门槛、试用指南、package scripts 和实际验收器；仅更新本状态记录，不修改产品行为。Git 本目录仍为 `?? ./`，未提交或发布。

本次重新运行的证据：

| 检查 | 实际结果 |
|---|---|
| `pnpm run typecheck` | 退出 0 |
| `pnpm run lint` | 退出 0，零 warning |
| `pnpm test` | 构建成功；36 个测试文件，513 passed / 1 skipped，共 514，退出 0；跳过项仍为 Windows 文件 symlink 创建权限 |
| 当前工作区与交付包比对 | 178 个非投影文件逐项 SHA-256 一致，含 src、重新构建的 dist、锁文件、包内说明及 SPEC；package.json 投影和生成的 .npmrc 由独立验收器另行校验；归档 SHA-256 与 bundle.json 一致 |
| `pnpm run verify:local artifacts/local-trial-k2UY2i --snapshot-cache <existing-external-cache>` | 新目录独立生产安装成功，20 checks 全部 passed；artifacts/local-install-J5vlT6/checks.json，保留 ../SunsetGuard-trials/local-install-b30AKx |
| `node scripts/t07-evaluate.mjs <prepared-snapshot-parent>` | 退出 0；artifacts/t07-IAz85a；TP=3/FP=0/FN=0、unknown 命中 1、桶/状态各 3/3；仍为原 3 仓库/6 文件的 provisional 标签 |

独立复验重新核对包内演示（5 findings）、正例/负例/有证据的 partial、退出码 0/1/2/3、JSON 流与外部输出不覆盖、Markdown、依赖与两类 Worker 来源，以及真实缓存的仓库/完整 commit/API 目标身份。原始快照和 rc-util 分析缓存命中；两次重放结果相同。此次不联网，远程无效输入探针也不计为联网获取验证。

复核结论：

- **可本地试用：达成。** 指定源码和目标后能够生成可核查引用及 gaps；包与当前工程一致，独立目录可运行。本轮未发现阻断这一阶段的失败。
- **真实调查覆盖与准确率：尚未充分验证。** 小样本标签仍未经独立人工复核；现有两个完整仓库仍 unknown+partial，其中 reactstrap 的 src/index.js 保留 TS1128 等 273 个语法诊断汇总。该状态符合公开缺口契约，但不能据此宣称常见真实场景均能完整分析。
- **整个产品落地：未完全达成。** PROJECT_REPORT 第 14 节的 P3 门槛要求维护者用报告完成真实任务；目前没有该证据。名称/许可证/发布账号、其他平台和长期运行仍未确认或验证，不能宣称正式发布就绪。

上一轮“完成”只适用于用户后来确认的本地试用范围，不代表 T07 独立人审、P3 外部价值门槛或 T11/T12 全部完成。未修改这一范围来掩盖测试失败，也没有为扩充完成度开发额外功能。

下一项：获得一个明确真实调查目标，固定源码快照，完成一次报告与独立人工核对，记录报告是否帮助完成该任务；用户当前尚无目标，不虚构采用、自动联系维护者或提前启动发现服务。

### 每次任务完成或阻塞时追加

```text
日期：
任务 ID：
当前 commit / dirty 状态（确实核对后填写）：
本次修改：
关键设计决定：

执行命令与真实结果：
- 命令：
  状态：passed / failed / not-run
  证据：退出码、测试数量或具体错误

已支持行为：
未支持行为 / 分析缺口：
环境阻塞：
新增或更新的 fixtures：
是否改变 schema / ruleset / 范围：
下一项可执行任务：
```

不得把“预计通过”记为 passed，不把跳过的测试记为成功，不把模拟 HTTP 测试记为生产 API 验证。

[S1]: https://openai.com/form/codex-for-oss/
[S2]: https://developers.openai.com/codex/guides/agents-md
[S3]: https://www.typescriptlang.org/docs/handbook/modules/reference.html
[S4]: https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API
[S5]: https://ts-morph.com/navigation/finding-references
[S6]: https://typescript-eslint.io/rules/no-deprecated/
[S7]: https://docs.codemod.com/platform/insights
[S8]: https://github.com/ecosyste-ms/repos/blob/main/config/routes.rb
[S9]: https://docs.deps.dev/api/v3alpha/
[S10]: https://react.dev/blog/2024/04/25/react-19-upgrade-guide
[S11]: https://pnpm.io/cli/install
