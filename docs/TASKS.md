## 四、开发任务与阶段验收

对应分文件：`docs/TASKS.md`。

版本：0.5.2（2026-09-16）。以下任务初始全部未实施。状态以代码、测试和 `docs/STATUS.md` 的真实记录为准。

### 使用规则

每次只执行一个满足前置条件的任务；大任务可在内部拆成更小补丁。完成后做相关测试和公共检查，更新状态，不自动跨越产品验证门槛。用户说“继续”时，读取实际仓库和状态，推进下一个可执行任务，不照抄旧的完成记录。

“文档有命令”不等于“命令已存在”。第一次建立 scripts，后续先读取 `package.json` 再运行。不要使用 `--passWithNoTests` 掩盖缺测试，不为了过关删除断言，不在默认测试中访问生产服务。

### 任务总览

| ID | 任务 | 阶段 | 前置 | 当前状态 |
|---|---|---|---|---|
| T01 | 工程初始化与领域契约 | P0 | 仓库检查 | done，见 STATUS 2026-09-10 |
| T02 | 安全本地文件与快照 | P1 | T01 | done，见 STATUS 2026-09-10 |
| T03 | ESM named / alias 与作用域 | P1 | T02 | done，见 STATUS 2026-09-10 |
| T04 | 类型、namespace 与直接 re-export | P1 | T03 | done，见 STATUS 2026-09-10 |
| T05 | JSON/文本报告与 CLI 集成 | P1 | T04 | done，见 STATUS 2026-09-10 |
| T06 | 来源歧义、安全和资源回归 | P1 | T05 | done，见 STATUS 2026-09-11 |
| T07 | 固定真实样本与人工验证 | P2 | T06 | done / provisional，见 STATUS；待独立人审 |
| T08 | 有限 CommonJS，可选扩展 | P2 | ESM 审计可接受且明确需要 | pending |
| T09 | 固定 commit 的安全源码获取 | P3 | T07，无阻断安全问题 | done，见 STATUS 2026-09-11；单仓库 API |
| T10 | 明确仓库清单、缓存与 Markdown | P3 | T09 | done / local trial，见 STATUS 2026-09-12 |
| T11 | 一个可选发现服务 | P4 | T10，已有实际试用证据 | pending |
| T12 | 固定队列历史比较 | P5 | T10，用户需要重复扫描 | pending |

T08 不是 T09 的硬性前置；T12 也不依赖自动发现。不要用“支持更多模式”或“全自动”作为默认进度指标。

### T01 · 工程初始化与领域契约

**目标：** 形成最小、可测试、可构建的 TypeScript CLI 工程，固定诚实的结果语义。

先检查 Git 状态、已有文件和 scripts。空仓库使用单包 TypeScript、pnpm、Commander、Vitest；存在工程时最小改动。选择并记录实际兼容的 Node LTS 和依赖版本，提交锁文件的准备由用户控制。保持 package `private: true`，许可证未确认时不伪造版权主体或对外发布。

建立 `typecheck`、`test`、`lint`、`build` scripts；安装仅在 SunsetGuard 工程内，优先禁依赖生命周期脚本。添加基本 `--help` 与参数校验。`analyze` 未实现时必须明确不可用，不能返回模拟的空成功报告。

定义 `SPEC.md` 的核心接口、枚举和运行时验证策略；至少验证目标必填项、无效参数和桶/状态不变量。不要空跑测试，也不要第一轮就写抓仓库功能。

**验收：** `pnpm run typecheck`、`pnpm test`、`pnpm run lint`、`pnpm run build` 实际成功；至少一个帮助/参数测试和一个真实领域验证测试。不能执行时明确阻塞，不写完成。

**停止点：** 更新 STATUS，只交付 T01，不自动进入 T02。

### T02 · 安全本地文件与快照

**目标：** 在只读边界内获取可复查的源码字节。

实现扩展名与排除策略、根路径校验、不跟随子级 symlink、资源限额、文件读取错误、内容摘要和规范化相对路径。快照包含实际读入的字节，不能仅记 Git HEAD。允许无 Git 的本地目录。

默认不加载下游配置、不解析外部依赖、不调用下游脚本。保留文件 inventory 和 gaps；空目录为 unknown。AST 还未加入时不可声称完成真实引用分析。

**验收：** SPEC 的 A20—A23、A25、部分 A26；测试能证明根外 canary 未读取，输出未写回源码。资源上限触发有明确错误状态。

**交付：** 可独立测试的 snapshot/inventory 模块及 fixtures，不强行建立数据库。

### T03 · ESM named / alias 与作用域

**目标：** 给定冻结的源码字节，准确识别一个指定模块的命名导出在同文件中的引用。

先验证 ts-morph/Compiler API 在不安装下游依赖时是否保留本地 import symbol 身份。处理 named、alias、value-reference、import-only 和 shadowing。证据同时有 binding 与引用位置。不得按名字全文匹配，也不得把全部未解析 alias 合并成同一 unknown symbol。

同步建立目标相关 unsupported registry：namespace、re-export、dynamic import 等在当前任务尚未支持时，要记录 gap。不要等到后续阶段才承認早期存在漏报。

**验收：** A01—A07、A12—A14、A29；至少覆盖参数/块/catch 遮蔽、其他包同名、类似包名、字符串和注释。

**交付：** 内存分析函数、原创 fixtures、binding/finding/gap 单元测试。

### T04 · 类型、namespace 与直接 re-export

**目标：** 扩展 ESM 支持但保持证据分类清楚。

区分 import type、type query、value 位置；namespace 静态点成员必须关联 import binding；direct re-export 独立分类。不能把未使用 import 当调用，也不能把 re-export 当无风险。

namespace 计算属性、namespace 逃逸、多级重导出依旧是 gap。可按三种模式拆成小补丁，但每次都必须保持已有测试通过。

**验收：** A08—A14、A26；类型与值不能混为“运行时使用”。更新支持矩阵和规则版本。

### T05 · JSON/文本报告与 CLI 集成

**目标：** 用户能够在本地使用一条命令获得真实结果。

连接 target → snapshot → analyzer → domain summary → report。按照 SPEC 实现退出码、JSON stdout 纯净、stderr 诊断和原子外部输出。暂不需要 Markdown。

默认不导出源码片段、不泄露绝对路径。统计按仓库结果去重，不把 token 数当仓库数。示例使用 synthetic-example，真实 CLI 不允许调用模拟生产数据路径。

**验收：** A19、A20、A24—A28；测试覆盖检测到引用且 complete 的退出码 0、partial 的退出码 3、参数错误 2、输出失败 1。

**交付：** 一个本地端到端 fixture、CLI 文档和可用构建产物路径。

### T06 · 来源歧义、安全和资源回归

**目标：** 防止工具把“句法匹配”过度包装成包来源或完整分析。

安全解析最近 manifest 与受限 JSON/JSONC；识别影响目标的 paths、npm alias、local/workspace 和无法安全解析的 extends。来源歧义保留候选但不纳入确定 detected。缺 manifest 可保留 declared-module 层级，不能伪造 corroborated。

检查分析宿主是否越界读取、同步 AST 是否能被超时真正终止、取消后是否回收资源、缓存是否污染、JSON/Markdown 是否泄露路径。AST 工作不可由只做 Promise.race 的假超时保护。

**验收：** A17—A30；安全测试不执行 fixture；输出明确标识分析层级。修复所有阻断性安全问题后才进入真实仓库批量任务。

### T07 · 固定真实样本与人工验证

**目标：** 验证工具不是只对自造例子有效。

先使用用户提供或明确获准读取的固定快照。需要下载时遵守环境授权；未有安全远程 fetcher 时可由受控方式准备本地快照，不扩大成自动爬取。读取和保存源码都不意味着可以执行。

选择少量有明确模块导出的 JS/TS 仓库，固定 commit 或内容摘要。建立包含正、负、未知的人工标签，不仅抽查预测阳性。可参考 `react-dom/findDOMNode` 历史 API，但重新核对具体包版本和目标文件。

**验收：** 有可复查标注、TP/FP/FN、分母和未知统计；精度目标未达时写真实结果，不编造通过。未完成人工复核的标签明确 provisional。

**交付：** `benchmarks/README.md`、样本清单、脱敏结果和审计说明。首次用户反馈为外部验证门槛，不由 Codex 虚构。

### T08 · 有限 CommonJS，可选

**目标：** 在已有需求下补充 require namespace 和解构模式。

验证 require 未被局部遮蔽；按 binding 追踪；重绑定、属性修改或复杂解构不做假推断。所有新增能力由 fixtures 定义。不把这一任务扩大成控制流分析器。

**验收：** A15—A16，配套正反例，以及全部 ESM 回归。没有需求可以延后，不阻碍明确仓库清单产品化。

### T09 · 固定 commit 的安全源码获取

**目标：** 将指定公开 GitHub 仓库变成可靠、受限的源码快照。

只支持明确主机和仓库格式；解析 ref 后固定 SHA；下载来源、重定向、认证、大小和解压均受限。拒绝路径穿越、symlink/hardlink、压缩炸弹式资源增长。不得执行 git hook、filter、submodule 或 package script。

对网络功能使用模拟响应测试，默认不联网。真实网络测试单独执行并记录权限与结果。获取失败变成该仓库 unknown，不让其他结果丢失。

**验收：** 404/429/超时/分页不适用错误、主机重定向、token 不泄露、归档攻击 fixtures、commit 对应关系。

### T10 · 明确仓库清单、缓存与 Markdown

**目标：** 为维护者交付可批量使用的调查工具。

定义 `consumers.json` 的受限格式、规范化与去重；不按固定 Star 自动过滤用户提供清单。加入快照缓存和分析缓存，键包含 target、scope、analyzer 和 ruleset。再实现 Markdown，防止代码块注入与路径泄露。

默认 source snippet 关闭，显式开启时限制与脱敏。报告包含样本选择、排除、桶和执行状态。不实现 readiness 分数。

**验收：** 相同快照重复结果稳定；规则变化缓存失效；重复仓库不增加分母；部分失败保留；本地/远程身份不混淆。确认真实维护者是否愿意使用，不能把下载量当采用证据。

当前交付附注（2026-09-12）：工程实现、默认离线回归及固定真实 CLI 在线/离线重放已完成，见 STATUS 和 LOCAL_TRIAL。用户确认尚无维护者或具体目标，先完善本地试用交付；采用证据仍为未验证，不能据此越过 T11。T10 交付补充包括首个解析错误定位、私有目录包和独立安装验收；具体产物与实测状态以 STATUS 的本地交付记录为准。

### T11 · 一个可选发现服务

**目标：** 只在明确样本模式有价值之后降低选样成本。

先核对当前官方接口与服务授权，完成真实契约验证再写 adapter。RepositoryDiscovery 与 PackageStatistics 分开；deps.dev counts 不能假装仓库清单。分页停止理由、未知总量、筛选与排除记录在结果中。

**验收：** 一页/多页/中断/限流/字段缺失等测试；实际请求验证有记录；人工清单仍能离线或按既有快照工作。未经验证的生产接口不写“可用”。

### T12 · 固定队列历史比较

**目标：** 比较同一批源码对象的观察变化，不制造迁移率。

保持 target、ruleset、scope 可比较；若规则变更，重跑旧快照或标不可比。区分 still-detected、no-longer-detected、source-unavailable、scope-changed 等。移除依赖或功能不自动算“已使用替代 API”。

**验收：** 样本变化不能提升假迁移指标；失败不算消失；默认分支与已发布产物范围说清。Action 调度、自动通知和 AI 不在这个任务内。

### 每个任务共同的完成标准

代码有针对性测试；文档与实现一致；没有未解释失败；`STATUS.md` 记录真实命令、结果、限制和下一任务。没有自动 commit、push、npm publish、创建公开 Issue/PR 或开通付费服务。

新增依赖应有当前必要性，不通过更换整个工具链逃避一个局部问题。遇到环境限制先完成可离线部分，再精确报告阻塞。

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
