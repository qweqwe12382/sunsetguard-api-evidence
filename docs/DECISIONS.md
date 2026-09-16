# 实现决定

## T01 · 工程范围与工具链（2026-09-10）

- 使用单包 ESM TypeScript 工程。`src` 生成至 `dist`，测试与配置只参与类型检查，不进入产物。启用 strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes。
- 本机 Node.js 24.19.0、pnpm 11.7.0；Node 24 为本项目当前验证系列，engines 限定 24.x。Node 官方发布记录标记 24.19.0 为 LTS：[官方记录](https://github.com/nodejs/node/releases)。其他 Node 主版本尚未验证。
- npm registry 实际查询确认 Commander 15.0.0、Vitest 4.1.0 的 engines 接受 Node 24。typescript-eslint 8.70.0 的 peerDependencies 要求 TypeScript >=4.8.4 <6.1.0，因此选择已查询存在的 TypeScript 5.9.3，不采用 registry 当前默认的 TypeScript 7.0.2。
- ESLint 9.39.1、@eslint/js 9.39.1、typescript-eslint 8.70.0 提供简单静态 lint；Vitest 4.1.0 做默认离线测试。Zod 4.1.12 用于运行时领域校验。所有直接依赖固定版本并保留 pnpm 锁文件。
- 首次安装 Zod 4.6.1 时 pnpm 自动生成了 minimumReleaseAgeExclude 条目；已改用查询存在的 4.1.12 并删除该生成的例外文件，保留默认发布年龄检查。
- `.npmrc` 默认 ignore-scripts；首次安装执行 `pnpm install --ignore-scripts`，后续冻结锁文件。不启用任何被阻止的依赖脚本。
- T01 CLI 只提供帮助与参数校验。有效 analyze 请求返回明确“尚未实现”错误和非零退出码，不能输出合成扫描结果。不读取扫描路径，不创建输出报告；报告渲染、源码快照和 AST 分析按后续任务实施。
- Zod strict schema 检查外部对象的完整结构并拒绝未知字段；领域函数在解析后的对象上检查引用关联、分类、快照要求和计数。结构 schema 本身不替代语义验证；外部调用应使用 `parseApiTarget`、`validateRepositoryTargetResult` 或 `validateScanReport`。
- 当前目标导出名限于 JavaScript 标识符形式，不支持字符串命名导出。目标字段不做静默 trim；证据相对路径保留合法的文件名空格，禁止控制字符、绝对路径和点路径段。位置按一基 UTF-16 坐标约定，结束位置不得早于开始位置；与真实源码字节的对应验证属于 T02/T03。
- 有已分析文件或 finding 时要求快照身份；源码获取失败允许无快照。任意 ambiguous 候选均要求 partial 和影响结论的 gap，存在 confirmed 证据时仍保留 detected。单 binding 的 import-only 不与其他 finding 类别共存。报告拒绝重复仓库身份，排除原因计数之和等于 excluded。
- 测试发现限制在 `tests/**/*.test.ts`，排除 fixtures 和 benchmarks。fixture 源码不得由测试运行器作为脚本执行。
- 工作区最初只有两份 Markdown，无 package、源码或独立 `.git`。Git 向上解析到 Desktop；不初始化或修改上级仓库，不暂存、不提交。检查改动只限定当前项目路径。
- 从完整指南拆分 `docs`、`prompts` 和 `AGENTS.md`，保留两份原始文档。`docs/STATUS.md` 此后记录实际开发，原指南中的初始状态仍为历史模板。

T01 时尚未选定 AST 方案；T03 的隔离验证与最终选择见下文。T01 工程依赖本身不证明分析器可用。

## T02 · 本地字节快照（2026-09-10）

- 入口 `captureLocalSnapshot(rootPath, options)` 返回 `phase: "snapshot"`；其 status 仅表示获取阶段完整性，`inventory.readFiles` 不能直接冒充领域结果的 analyzedFiles。空输入以 partial 和 NO_ANALYZABLE_FILES 表达；真正的引用结果与 unknown 分类由后续分析集成负责，当前 CLI 保持不可用。
- 默认单文件 2 MiB、实际累计读取 50 MiB、源码文件 5,000、观察目录项 20,000、目录深度 128、协作时间预算 120 秒。调用方只可降低这些上限，不能借公开 API 放大默认读取或时间预算；正整数配置必须有效。默认排除不能通过附加排除选项取消。限制目录项/深度是为了让非源码目录枚举也有界。
- inventory 只记实际观察的文件与目录项，剪枝目录不递归统计内部文件。触发预算时观察计数可能包含用于发现超限的首个额外条目；不是仓库真实总量。eligibleFiles 始终等于 readFiles + failedOrSkippedEligibleFiles。
- 目录排除在 Windows 不区分大小写，其余平台按大小写区分；策略写入 directoryCaseSensitive 并参与 scopeHash。扩展名匹配不区分大小写；不解析 gitignore。默认排除路径中的链接也视作范围排除，其余链接不跟随并产生 gap。
- 文件按最多 64 KiB 一块读取，实际 bytesRead 全部计入预算，即使该文件后续因变化被丢弃。捕获错误、取消、短 EOF 和身份变化后释放文件句柄。多硬链接普通文件也拒读，避免静态别名指向根外字节。
- 输出 API 仅预检，不创建目录、不写文件、不授权覆盖。通过预检不代表未来写入瞬间的路径安全；T05 必须复查并使用安全写入流程。
- 内容标识基于按 UTF-16 code-unit 排序的精确相对路径、长度和每文件字节摘要；每文件与集合均使用 SHA-256，scopeHash 包括限制与范围策略。sourceId 目前采用内容指纹，不含绝对路径；它不是独立的仓库身份。相同字节和路径的目录拷贝具有相同内容指纹。
- 根目录、逐段路径、打开后的文件及读后元数据做前后检查，但不承诺原子快照或对恶意并发路径替换的原子隔离。时间预算使用单调时钟，取消在块与枚举边界检查，不假装终止底层 OS 请求。[Node 官方 fs 文档](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisesreadfilepath-options)也明确说明其文件取消不等于中止单次 OS I/O。T06 再验证分析 worker 的硬超时与回收。
- 这里只读取源码字节；不解析配置、不加载项目依赖、不执行源码、测试、构建、Git hook 或配置脚本。当前验证平台为 Windows；跨平台运行与真实权限拒绝仍未验证。

## T03 · 内存 ESM 绑定分析（2026-09-10）

- 采用已固定的 TypeScript 5.9.3 Compiler API，将 TypeScript 从开发依赖移动到运行依赖；不额外引入 ts-morph。使用纯内存 CompilerHost、noLib/noResolve/types=[]，只返回传入的一个虚拟源码文件。不调用文件系统宿主，不加载下游 tsconfig、默认类型库或外部模块。接口背景见 [TypeScript 官方 Compiler API 文档](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)。
- 技术验证证实：外部模块未解析时，各个本地 import alias 仍具有独立 Symbol；参数遮蔽产生不同 Symbol。最终匹配使用本地 Symbol，不能调用 getAliasedSymbol 后把未解析导入合并。对象 shorthand 使用 getShorthandAssignmentValueSymbol，local export 使用 getExportSpecifierLocalTargetSymbol。
- `analyzeFile(file, target)` 返回文件级 bindings/findings/gaps 与完整性，不生成仓库桶或报告。只分析精确 moduleSpecifier 与 exportName 的 named/alias 导入；不追踪赋值后形成的新别名。直接值引用包括传参、shorthand、计算属性和 class extends 表达式，但不推断运行时执行或继承后的成员。
- 每条证据关联导入绑定；同一 binding 有已支持值引用时不再输出 import-only。目标 value 导入仅出现未支持传播时，保留 import-only 与 gap；这不是未使用或死代码结论。类型导入暂保留 type binding 和 gap，正式 type-reference/type import-only 分类在 T04 实现。
- 命中目标的 namespace、re-export、import-equals、类型 import、动态 import、未遮蔽 require、类型位置和 JSX 进入 unsupported registry。无关导入和被局部绑定遮蔽的 require 不污染目标结果。冲突导入声明产生 gap，不生成无法可靠归属的引用。
- UTF-8 严格解码，保留 BOM；位置是一基 UTF-16 列、结束位置不含末端，路径保持相对形式。证据 ID 使用带长度分隔的 SHA-256 输入，包含目标、规则、路径、绑定和 token 位置；ID 是快照内证据身份，复查仍必须结合快照内容摘要。
- 当前规则版本为 `0.1.0-t03`，profile 为 `module-syntax-v1`，schemaVersion 仍为 `0.1`。所有来源为 declared-module；manifest、paths、workspace、npm alias 尚未核验，不伪造实际 npm 或运行时解析。
- 单源码输入上限 2 MiB，解析失败和资源异常产生可见 gap。同步 AST 分析尚无可中断的硬超时或进程内存隔离；T06 验证 worker/进程终止与回收，当前不能宣称具备该保护。
- CLI 集成属于 T05，本轮不开放 format/output，不把单文件函数或合成 fixture 当成完整扫描产品；未进行真实下游精度、跨平台或维护者采用验证。

## T04 · 类型空间、namespace 与直接重导出（2026-09-10）

- 沿用 TypeScript 5.9.3 和纯内存宿主，不新增依赖；规则升级为 `0.1.0-t04`，schemaVersion/profile 不变。原 T03 类型与静态 namespace/re-export 缺口迁移为明确证据，动态访问与未支持传播保留回归。
- named `import type` 和 specifier 级 `type` 设置 binding.importSpace=type；实际类型位置产生 type-reference，未使用的命名类型导入产生 import-only。普通 value import 可以同时有值引用与类型引用，不重复添加 import-only。类型导入用于值位置则产生 gap，不把非法语法使用包装为值证据。[TypeScript 官方说明](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-8.html#type-only-imports-and-export)明确类型导入会擦除，不能作为 class extends 的运行时基类。
- namespace 的静态点成员和类型 QualifiedName 必须通过本地 import Symbol 关联，证据位置指向目标成员，binding 位置指向 namespace 导入名。仅导入 namespace 或访问其他静态成员不证明引用了指定命名导出，因此不产生该目标的 import-only；整个 namespace 的计算访问、传递、复制或未支持导出形成目标相关 gap。
- 直接命名 re-export 单独创建 esm-reexport binding 和 direct-reexport finding；以源导出名匹配目标，binding 位置指向源导出 token，finding 位置指向实际暴露的导出 token。既有 localName 字段对 re-export 保存导出别名；type/value 空间依据 export type 或 specifier type。
- star/namespace re-export、多级和本地导出传播、inline import-type、dynamic import、CommonJS、JSX 仍不声称支持。ambient/nested module 内的目标 named/namespace import 和 re-export 显式产生 gap，不把顶层枚举的遗漏当作完整结果。只把受支持的直接词法证据升级，未建立跨文件或运行时传播分析。
- CLI 报告仍待 T05；manifest 来源核验、生产硬超时和内存隔离仍待 T06。新增语义覆盖不等于真实下游精度或产品发布验证。

## T05 · 单目录 CLI 与报告发布（2026-09-10）

- `scanLocal` 将本地快照、内存分析及领域验证连接起来，真实调用使用 reportKind=scan。单次 selected/attempted/knownTotal 为 1，repositoryId=local:single 仅在本次扫描内标识输入，不能充当跨扫描身份。scope 原有结构暂保存在 limitations 的 snapshotScope JSON 条目中，schemaVersion 仍为 0.1，不静默添加公共字段。
- unsupported-only 文件完成了受限 AST 分析，因此 analyzedFiles 增加，同时 status 保持 partial；解析/资源失败增加 failedOrSkippedEligibleFiles。两者都遵守 eligibleFiles 分解。零 eligible 且不是获取完全失败时补 NO_ANALYZABLE_FILES。无法安全表示的文件路径产生单文件 FILE_READ_FAILED gap，保留其他文件证据，诊断不回显该路径。
- capture 与 analysis 的整体预算采用单调时钟。文件间以及最后文件后 yield 并检查 AbortSignal/期限，最后文件超限仍标 partial，已完成证据保留。bin 处理 SIGINT/SIGTERM；测试中的 SIGINT 是同一 Node 进程发出的信号事件，不宣称已验证 Windows 控制台真实键盘 Ctrl-C。同步 AST 的硬超时、内存限制与回收仍待 T06。
- JSON 渲染先验证报告，再输出一个文档；text 渲染全部结果、summary、snapshot、scope hash、finding/binding 两个位置、归因与 gaps。源码片段默认剥离，未提供开启选项；文本控制符和双向标记转成可见转义，原始底层错误及任意 CLI 参数不直接回显。
- stdout/stderr 写入按顺序等待；可执行文件使用写入回调和流错误监听，输出错误优先返回 1。参数错误为 2，已输出的 partial/failed 报告为 3，成功 complete 为 0，即使发现引用也不视作命令失败。没有 fail-on-reference、Markdown 或远程选项。
- 文件输出要求现有外部父目录和新文件名。先验证路径，创建 0600/wx 唯一暂存文件，完整写入并 sync，关闭后复查源码根、父目录和文件身份，再用 link 原子 create-if-absent 发布并清理暂存名。rename 可能覆盖竞争中出现的文件，因此在未授权覆盖的本版不使用覆盖式 rename。硬链接发布只改变完整暂存文件的名称可见性，不安装或执行源码；不支持硬链接的文件系统会失败，不降级成可见的部分写入。
- 输出检查不等于操作系统级目录隔离，不能保证抵抗恶意并发祖先替换；父目录改变或暂存身份无法确认时不会冒险删除替换对象。正常发布失败、EEXIST 竞争均清理自己的暂存文件。源码目录内、绕入源码的链接、已有输出、ADS 和不存在父目录均被拒绝。
- 新增原创 fixtures/consumer，构建和测试发现仍排除 fixture 执行。它用于 CLI 真实路径验收，不能代替真实下游人工精度审计。


## T06 · 来源归因、硬终止与资源回收（2026-09-11）

- 保持单包 TypeScript 5.9.3、Node 24、pnpm 和现有依赖，不安装下游依赖，不引入新的工具链。规则与 analyzerVersion 升为 `0.1.0-t06`，schemaVersion=0.1、profile=module-syntax-v1 不变。SPEC/TASKS 工作文档更新为 0.3.0。
- `src/attribution` 在源码根内读取最近 package.json、tsconfig.json 与相对 extends。纯 JSON/JSONC 解析，不调用 TypeScript 项目加载或模块解析。每次读取前限制大小，读取时累计实际字节；相对路径、目录链、root 和文件 handle 身份前后核对，拒绝文件/目录链接、多硬链接、越界路径和不可表示路径。对已观察目录保存身份；操作系统级路径替换竞争仍不是原子防护。
- 正常注册表依赖提升为 manifest-corroborated；缺 manifest 保持 declared-module。npm/file/link/workspace、同名本地包、相关 paths、根 workspace 中已捕获的同名包和无法安全读取的配置生成 ambiguous 候选。只支持精确/单星 workspace 选择器，不声称已穷尽 workspace。JSON 重复键会掩盖前面声明，显式记录 CONFIG_UNRESOLVED；URL、路径和可识别令牌格式不复制到 range 字段。
- extends 仅允许根内 `./`、`../`，可补 `.json` 后缀；裸包标识（包括裸 `base.json`）、越界、循环和资源上限不解析。支持继承数组顺序覆盖，子 paths 覆盖父 paths 整体；有效无关 paths 不误标目标。paths 的静态意义参见 [TypeScript 官方说明](https://www.typescriptlang.org/tsconfig/paths.html)，不把它解释成运行时加载结果。
- `createIsolatedAnalyzer` 使用工具自己的固定 Worker 入口，按队列处理纯字节。禁继承 execArgv，消费而不转发 Worker stdout/stderr。超时、AbortSignal、close、worker error 都等待终止；close 幂等并阻止排队工作重新开启线程，失败后的下一次分析先等待回收。等待队列与创建线程的时间都计入单调 deadline。
- Worker 的 128 MiB 是 V8 old-generation 预算；16 MiB / 50,000 条单文件输出限制在发回父线程前检查。scanner 再限制聚合证据 32 MiB / 100,000 条，按完整文件加入；初始 gaps 同样受预算约束，必要诊断保留少量固定预留。该预算不等于进程总内存限制。[Node 官方文档](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html#new-workerfilename-options)明确 resourceLimits 不覆盖 ArrayBuffer 等外部分配；[terminate 文档](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html#workerterminate)说明其 Promise 在 exit 时完成。
- `pnpm test` 先构建本工具再运行 Vitest，使 Worker 测试使用本轮产物。busy helper 是工具自己的测试驱动：真实线程发 ready 后进入同步循环，测试只替换构造目标，timeout/abort 经生产 driver 发起，返回前断言 exit 与 threadId=-1。不是执行被扫描 fixture，不以单独 Promise.race 当作终止证据。
- 源码摘要与配置字节/相对路径/缺失状态共同组成 contentHash/sourceId，策略进入 scopeHash。根在 capture/config 两阶段间替换时生成 SNAPSHOT_CHANGED，并把绑定全部降为 ambiguous。没有持久结果缓存，不能把缓存键更新说成完成缓存功能。
- 合法的字符串命名 re-export 别名可为空、空白或带转义字符；仅 esm-reexport 放宽 localName，其他绑定保留原约束。回归核对带引号 token 位置和 JSON/text 输出，不再因一个合法别名丢失整份报告。
- 文本将歧义 evidence 标为 `candidate / ambiguous`，显示可核对的 manifest 相对路径和声明范围。源码片段保持关闭。真实下游精度、维护者试用、POSIX 实机和底层 OS I/O 硬中断均不属于本轮完成证据。

## T07 · 固定真实样本与 provisional 评估（2026-09-11）

- 延续现有工具链，无安装。接收工作区已有 evaluation/default-import 初稿，主代理独立修正与验收；不自动启动其他代理或 T09。
- 固定 3 个不同仓库、6 个源码文件，另存工程外；保留源码与祖先 package/tsconfig、根 LICENSE 的固定 SHA URL、内容 hash 和明确缺失状态。审计采用文件子集作为范围，CLI 的 local 快照不伪装成产品 Git 快照。
- 先读取源码并冻结标签，再查看编译后 CLI 预测。标签均 provisional，exhaustive 只表示代理已完整检查该选定文件的目标证据，不代表人审。样本和统计详见 [benchmarks/README.md](../benchmarks/README.md)。
- 独立评估 API 验证目标、规则、分析器、profile、内容与范围 hash、实际观察的文件 hash、精确 finding/binding 位置。token 与仓库分类分开；候选与确定声明证据分开；unknown 必须命中全部期望的结论相关 gap。缺失报告、partial 和未支持用法不转换成 TN。
- 对非穷尽文件只排除未标注预测，显式负标签或错误类型位置仍计 FP；分母为零返回 null。confirmed 字段表示非 ambiguous 声明证据，不表示标签已人审。不将比例或结果提升为产品总体准确率。
- 默认导入对象的成员与命名导出并非可证明等价。default 目标访问及整体传播记录 gap，按 Symbol 排除遮蔽，其他明确成员和默认函数直接调用不误归因。保持已有 named/namespace 正向证据。规则与 analyzerVersion 为 `0.1.0-t07`，scan schemaVersion/profile 不变。
- prepare 是显式联网的固定审计脚本，evaluate 是离线的自有 CLI 驱动；它们不是数据中的脚本。默认测试不联网、不发现 benchmarks 或下游源码。准备过程没有归档解压、凭据或重定向，不据正常请求成功声称通用远程安全已验收。
- 独立人工复核和维护者试用仍未发生。T07 工程产物可交付，下一开发任务 T09，T08 在出现明确 CommonJS 需求后再决定。

## T09 · 固定 GitHub commit 的安全获取（2026-09-11）

- 复用现有 Node 24/TypeScript/pnpm；新增 tar-stream 3.2.1，核对其流式 API、PAX 4 MiB 元数据上限及自带类型，只使用 parser，不调用 tar 命令或文件系统 extractor。[tar-stream 官方仓库](https://github.com/mafintosh/tar-stream)提供实现依据。安装保持 ignore-scripts，不需要下游依赖。
- 采用公开仓库元数据 → commit → recursive tree → 固定 SHA 归档的顺序。GitHub 的 [tree API](https://docs.github.com/en/rest/git/trees#get-a-tree)明确给出 truncated 状态，不能将其当完整 inventory；本版限制 tree 条目与 JSON 大小并拒绝截断。commit 接口的 diff 文件分页不用于 inventory。
- 归档接口会产生 [GitHub archive 重定向](https://docs.github.com/en/rest/repos/contents#download-a-repository-archive-tar)，仅允许到 codeload 的同仓库/完整 SHA 路径。跨主机永不带 Authorization；拒绝端口、用户信息、query/fragment 和其他主机。只在显式 tokenEnvironment 选项下读取一个指定变量，默认匿名；实际本轮未读取真实 token。
- 归档文件必须匹配该 commit tree 的 Git blob hash、路径和大小，另存 SHA-256。所有 tracked files 必须存在，拒绝链接、子模块、重复、设备、PAX 路径穿越和摘要不符。对 export-ignore/subst 或 LFS 替换导致的差异报失败，不生成伪精确源码链接。GitHub metadata 仍是信任来源，不声称独立签名认证。
- 网络及 tar/JSON 解析在工具自身固定 Worker 中运行，硬超时/取消后等待真正终止，再回收私有临时目录。Worker 不继承环境或 execArgv，不转发输出；父线程校验返回数据并重新构建安全错误消息。压缩/解压、tree、请求、重试、路径和堆预算见 SPEC；不承诺 OS RSS 总量或原子 filesystem 防护。
- 单仓库 scan API 在分析前后重核提取树。通过才使用 git snapshot 和固定 permalink base；失败/超时/改变分别保留 unknown、partial 或候选，不因取消丢弃已完成 finding。scopeHash 包含实际扫描政策与 remotePolicy。analyzerVersion 为 0.1.0-t09，ESM ruleSetVersion 保持 0.1.0-t07，避免把传输变更冒充语法规则变更。
- T09 只提供 API 和显式固定 smoke 脚本；CLI 的 scan --repos、缓存、Markdown 均属于 T10。默认测试离线，真实 rc-util 获取另行实际验证，不把模拟异常当作生产异常验证。独立人工复核、维护者试用、POSIX 实机仍未完成。

### 2026-09-12 · T10 明确清单与离线交付边界

- 沿用 schema 0.1 / module-syntax-v1 / ESM ruleset 0.1.0-t07，分析政策和 snippets 范围身份升至 analyzer 0.1.0-t10。单包 TypeScript CLI，不引入数据库或新依赖。
- consumers.json 严格 JSON、最多 256 KiB / 50 原始条目，显式 GitHub/ref 或本地目录；重复项排除，多 ref 拆扫描。readConsumers 返回不可伪造的冻结执行句柄，API 不接受任意报告 ID 作为源码身份。本地缺失路径也按最近存在祖先规范化，保留 unknown，不扩重复分母。
- 批量顺序处理并限制总时间/聚合报告；独立输入失败不能丢失其他证据。缓存和报告路径保护包括全部源码根、manifest 与缓存本身，不把源码可写当输出成功。
- 快照缓存按完整 Git 原始内容复用，分析缓存额外绑定 target/scope/所有政策版本；只对固定 SHA 直接离线命中，浮动 ref 在线重新获取。本地目录继续每次捕获，不把 HEAD 或内容相等冒充仓库身份。完整性校验不等于对恶意缓存拥有者的认证。
- 缓存显式开启、有容量边界、不自动 GC、不自动修复或覆盖未知目录。只有自己创建且身份未变的失败写入可回滚，避免一次取消留下可误命中的未完成记录。
- snippets 采用只保留准确命中 token 的遮盖式上下文，默认关闭；渲染及缓存再次核对片段形状。Markdown 自由文本使用动态围栏，来源链接只从已核对 commit 身份构造。
- 用户明确当前尚无维护者或具体 API 需求，优先完善本地试用交付；这不作为采用证据，也不满足 T11 自动发现前置。无公开联系、提交、发布或付费服务授权。

### 2026-09-12 · T10 本地交付补充

- 标准语法错误保留首个有效诊断位置与数字 TS 编号，最多表述 10000 个诊断数量，不复制可能含源码标识符的 messageText。EOF 使用真实零长度位置；不能解析字节或超限时不捏造坐标。analyzer 升为 0.1.0-t10.1，旧分析缓存失效；引用规则、schema/profile 不变。
- 使用白名单私有目录归档，包含本工具源码、对应编译文件/相对 source maps、精确版本锁、固定安全配置和原创演示。不使用 npm 默认打包范围，不捆绑下游数据、测试、缓存、日志或依赖目录，不进行发布。
- 包内仅保留可用的 start 命令；devDependencies 元数据保留以匹配同一锁文件，独立安装使用 --prod --frozen-lockfile --ignore-scripts。不假设目录自安装会创建自己的 CLI shim，文档直接使用 node dist/cli/bin.js。
- 验收将包物化到工作区外新的 SunsetGuard-trials 目录，从第三个空目录调用入口，禁用安装配置脚本与生命周期。审计运行依赖实际路径，并用专属加载记录核对两个 Worker 和模块来自安装目录；另用未注入检查的 CLI 核对正例结果。验收只执行工具自身 helper，不运行原创或真实消费者源码。
- 归档与文件摘要用于检查交付一致性，不是发布者签名；仅 Node/pnpm store 已缓存的本机生产依赖安装可以离线。不把本地包验收提升为公开发布、跨平台、真实维护者采用或生产验证。
