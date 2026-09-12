# SunsetGuard

Find who still references the API you plan to remove.

面向 npm 库维护者的只读 JS/TS API 引用证据工具。目标由包名、精确模块入口和命名导出共同标识，输出可复查的位置、绑定、源码快照与分析缺口。

## 当前状态

已提供本地单目录分析、明确清单批量扫描、GitHub 固定快照缓存、分析缓存和 JSON/文本/Markdown 报告。T07 的真实样本标签仍为 provisional，维护者试用尚未验证。分析器支持精确模块入口的 ESM named/alias 导入、同文件值与类型引用、import-only、namespace 静态成员、直接命名重导出和作用域遮蔽。各任务及实际验证记录见 [docs/STATUS.md](docs/STATUS.md)。

快照模块保留实际源码字节与 SHA-256 摘要，执行文件/字节/目录范围限制，跳过符号链接，记录读取失败、文件变化与取消。其 `phase: "snapshot"` 和 `readFiles` 只表示获取阶段，不表示已完成 API 分析。模块说明与平台限制见 [docs/DECISIONS.md](docs/DECISIONS.md)。

底层 `analyzeFile(snapshotFile, target)` 只分析传入字节，不加载下游依赖、类型库或完整 Project。CLI 在受限 Worker 中调用它，超时、取消或内存失败后等待线程退出。证据提供绑定、引用位置及规则版本；namespace 计算访问或逃逸、star/多级/本地重导出传播、inline import-type、dynamic import、CommonJS 和 JSX 等目标相关未支持模式仍记录 gap。

来源核验只读取根内最近的 package.json、tsconfig.json 及受限 JSON/JSONC extends。普通依赖可标为 `manifest-corroborated`，缺 manifest 保持 `declared-module`；paths、npm/local/workspace、重复配置键和未解析配置保留 `ambiguous` 候选，不计入确定 detected。三个层级都不证明实际 npm 或运行时解析。

仅导入整个 namespace 不表示引用了指定成员；未使用的命名导入才产生目标 import-only。类型证据与值证据独立分类，重导出也不会被计为调用。默认导入的目标成员或整体传播形成 gap，不假定与命名导出等价。当前规则为 `0.1.0-t07`，详细支持矩阵见 [SPEC](docs/SPEC.md)。

未检出不代表已迁移；源码引用不证明运行时执行；报告不保证 API 可以安全删除。详细进度及实际检查结果见 [docs/STATUS.md](docs/STATUS.md)。

## 本地扫描

首次试用可按 [本地试用指南](docs/LOCAL_TRIAL.md) 使用独立目录试用包，或在工作区构建、运行离线演示与核查结果。试用包包含编译产物和固定依赖锁，安装工具自身运行依赖后即可使用。

构建后运行原创 fixture，无需安装或执行其中的虚构依赖：

```sh
node dist/cli/bin.js analyze fixtures/consumer --package example-lib --symbol oldApi --format json
```

该 fixture 预期退出 0，得到一个 detected + complete-within-scope 结果及五条证据。它用于演示命令和回归，不是真实下游精度基准。默认格式为 text；`--module` 默认等于包名，扫描子入口时必须精确指定。

```sh
node dist/cli/bin.js analyze <source-directory> --package <package-name> --module <exact-entry> --symbol <export-name> --format text
```

`--output <file>` 将完整报告写到源码根外，stdout 保持为空。父目录必须已存在，文件必须不存在；不会自动覆盖文件或创建父目录。静态目录链接绕回源码、已有链接和 Windows ADS 均被拒绝。原子发布依赖同文件系统硬链接能力；不支持时明确失败。

| 退出码 | 含义 |
|---|---|
| 0 | 范围内完成并成功输出，允许存在引用 |
| 1 | 内部错误或输出失败，不能把输出当作成功报告 |
| 2 | 参数无效或缺失 |
| 3 | 已输出报告，但至少一个结果 partial/failed |

JSON stdout 是单个文档；诊断走 stderr。Ctrl-C/终止信号请求取消，等待分析 Worker 终止并生成不完整报告；底层 OS 文件读取仍在读取边界协作取消。空目录、读取失败和解析失败不会变成完整无引用。只有具备可计数证据才进入 detected，文件数量和引用次数不被当作仓库数量。

CLI 每次分析单个 API 目标，支持单目录或明确仓库清单。配置单文件 256 KiB、累计 2 MiB、最多 128 个文件，extends 深度最多 16；默认分析线程的 V8 old-generation 限额 128 MiB，单文件结果最多 50,000 条证据记录 / 16 MiB，聚合证据预算 100,000 条 / 32 MiB。这些限制不是整个进程的 RSS 保证。Node 路径前后检查也不是原子文件系统隔离。实际政策写入 `snapshotScope`、`analysisPolicy`、`attributionPolicy`，源码与实际读取配置共同形成内容身份。

Workspace 只核对根声明与已捕获源码附近遇到的 manifest，支持精确或单星选择模式；没有完整工作区、安装版本、锁文件或包解析。tsconfig 不作为 Project 加载，其 include/exclude 不替代公开扫描范围。[T07 审计](benchmarks/README.md)覆盖 3 个固定仓库的 6 个选定文件，TP=3、FP=0、FN=0、预期 unknown 缺口命中 1；标签均未经独立人工复核，不能扩展成全生态准确率。POSIX 实机和维护者试用尚未验证。

## GitHub 单仓库 API

T09 还提供 `dist/scans/index.js` 的 `scanGitHub({repository, ref}, target, options?)`，接受明确公开 GitHub 仓库和 ref，解析并固定 commit。它从有界 Git tree 核对所有归档文件的 blob 摘要，拒绝不安全链接、路径、缺项和资源超限，再运行同一只读分析器并自动回收临时目录。默认匿名；不会自动读取环境中的 GitHub 凭据。低层 `fetchGitHubSnapshot` 返回私有句柄，需要调用者在 finally 中等待 `dispose()`，不能直接序列化这个含本地目录的内部句柄。

`node scripts/t09-smoke.mjs` 是单独显式联网验证入口，固定扫描 rc-util 的历史 commit，正常报告写到 `artifacts/t09-*`。T09 实际验证了 104 个下载文件，分析范围包含 84 个 JS/TS 文件；结果为 unknown+partial，含默认导入、namespace 传播和来源歧义缺口，不声称无引用。默认 `pnpm test` 始终离线。详细网络/解压边界见 [SPEC](docs/SPEC.md)，当前 analyzerVersion 为 `0.1.0-t10.1`，ESM 规则保持 `0.1.0-t07`。

## 明确清单批量扫描

先离线试用项目自带的原创 fixture：

```sh
node dist/cli/bin.js scan --repos examples/consumers.local.json --package example-lib --symbol oldApi --format markdown
```

`consumers.json` 使用受限 JSON 格式，不能包含脚本、任意 URL 或额外字段：

```json
{
  "schemaVersion": "0.1",
  "repositories": [
    { "kind": "github", "repository": "react-component/util", "ref": "6253c1b69eaf6dbde64f32370a69df0f24865715" },
    { "kind": "local", "path": "../my-consumer" }
  ]
}
```

相对目录以清单所在位置为基准。GitHub owner/name 规范化大小写；重复的同一仓库/ref 或规范化本地目录只尝试一次，重复项记入 exclusions。同一 GitHub 仓库的不同 ref 要拆成不同扫描。本地和 GitHub 身份分开，同字节的两个本地目录也不会被冒充为同一仓库。`knownTotal` 仅为该清单的独立仓库数，不是生态总量；没有 Star 筛选。

清单最多 256 KiB、50 个原始条目；顺序分析，总时间预算 10 分钟，聚合结果预算 48 MiB。取消、获取失败或预算耗尽保留已经完成的结果，并为其余条目输出 unknown。预算超限时一个仓库报告整体省略，另为最多 50 个必要失败诊断预留空间。

指定 `--output` 时，报告必须位于全部源码目录、清单文件与缓存边界之外；文件必须不存在、父目录必须已存在。清单旁的新报告允许写入。JSON stdout 始终只有一份报告；`partial` 或 `failed` 返回 3。

## 缓存与离线重放

缓存默认关闭，仅对明确 GitHub 快照启用。本地目录每次重新读取实际源码和配置。第一次对固定历史样本联网扫描并保存缓存，再离线重放：

```sh
node dist/cli/bin.js scan --repos examples/consumers.github.json --package react-dom --symbol findDOMNode --cache ../sunsetguard-cache --format json
node dist/cli/bin.js scan --repos examples/consumers.github.json --package react-dom --symbol findDOMNode --cache ../sunsetguard-cache --offline --format markdown
```

缓存目录必须是父目录已存在的新目录，或本工具识别的完整缓存；不能与源码根重叠。原始文件以内容摘要保存，不在缓存内执行源码或分析。缓存命中先重新核对字节和 Git blob，再复制进私有临时目录；分析缓存还校验快照、目标、范围和全部相关版本。默认最多 512 MiB、100000 个目录项、512 个记录、单个 JSON 记录 16 MiB，不自动删除历史文件。容量或完整性问题会停止缓存复用并在报告中说明；现存未知目录拒绝使用。

只有完整 commit SHA 可直接命中离线快照；浮动 branch/tag 每次在线重新获取，不能把旧结果当作当前 ref。离线 miss 产生 unknown+failed，不联网寻找替代来源。分析缓存命中的 `generatedAt` 是报告组装时间，原有证据、状态和范围不变。缓存检查提供本地完整性校验，不认证能够重写所有文件与摘要的缓存拥有者。

默认匿名；只有显式传入 `--github-token-env` 才读取 `SUNSETGUARD_GITHUB_TOKEN`。该选项与 `--offline` 互斥。凭据不写入清单、缓存、URL 或报告，不自动使用 Git/gh 登录信息。

`--include-snippets` 同时适用于 `analyze` 和 `scan`：最多输出 160 字符的命中 token 片段，周围源码一律遮去，标记 `snippetRedacted=true`；不能将其当作通用秘密检测。Markdown 对不可信字段使用动态长度代码围栏和控制字符转义，源码链接仅指向已验证固定 commit。

`node scripts/t10-smoke.mjs` 是独立联网验收入口：通过编译后的真实 CLI 扫描两个固定仓库、验证重复项、重放离线缓存并生成 Markdown。缓存源码存放在工作区外的 `SunsetGuard-samples`，脱敏报告存放在 `artifacts/t10-*`。该脚本只验证这些场景，不代表真实维护者采用或通用分析准确率。

本地 API 可组合 `readConsumers(file)` 与 `scanConsumers(plan, target, options)`；plan 是该读取调用产生的冻结执行句柄，不能从报告或任意 JSON 伪造，需要重用文件时重新读取清单。自动发现、历史比较和迁移补丁尚未实现。

## 本地开发

当前验证环境为 Node.js 24.19.0、pnpm 11.7.0。版本选择见 [docs/DECISIONS.md](docs/DECISIONS.md)。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run typecheck
pnpm test
pnpm run lint
pnpm run build
node dist/cli/bin.js --help
```

只在 SunsetGuard 项目目录内执行上述开发命令。测试默认离线，仅发现 `tests/**/*.test.ts`；`fixtures` 和真实下游样本不是可执行测试。安装默认禁用生命周期脚本。

`pnpm test` 会先构建本工具自身的 Worker，然后运行离线测试。默认测试不下载真实仓库，不执行下游代码。

包保持 `private: true`，尚未发布，许可证和版权主体尚未确定。

## 文档

- [实现规范](docs/SPEC.md)：产品行为、结果语义、安全和验收契约。
- [开发任务](docs/TASKS.md)：T01—T12 的顺序与前置条件。
- [项目报告](docs/PROJECT_REPORT.md)：定位、架构与产品验证路线。
- [当前状态](docs/STATUS.md)：已执行工作和检查证据。
- [本地试用](docs/LOCAL_TRIAL.md)：已验证命令、缓存重放和结果解读。
- [协作规则](AGENTS.md)：开发与审查要求。

原始完整指南与根目录 `CODEX_START.md` 保留作为交付基线；日常实现以拆分文档和真实状态记录为准。文档中的扫描命令和示例数据均不代表功能已实现或真实扫描结果。
