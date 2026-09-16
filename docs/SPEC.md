## 三、实现规范与验收契约

对应分文件：`docs/SPEC.md`。

> 版本：0.5.1 · 日期：2026-09-12
> 类型：拟议行为契约。TypeScript 类型块是结构设计，不是完整产品实现。
> 核心原则：限定范围的静态引用证据，不输出安全删除结论，不输出横截面迁移率。

### 1. 规范层级与实现策略

本文件固定产品数据语义、分析边界和验收口径。`TASKS.md` 决定当前实现哪部分。尚未实现的功能不得出现在 README 的“支持”列表中。

必须允许一个很小的实现：本地目录、单目标、named import 与 alias、JSON。完整类型允许逐任务扩展，但不能通过把未知写成成功来省略领域概念。变更公共字段、结果分类或安全边界时记录设计决定；不要静默改动。

设计中需要 TypeScript 模块语义与 Symbol 查询的地方，以官方文档为依据。[S3][S4] 下面的规则选择、状态模型、默认限制和任务边界属于本项目设计，不是外部平台规范。

### 2. 目标 API 的身份

一个目标由 `packageName + moduleSpecifier + exportName` 标识，而不是只有函数名字。

例如：

```json
{
  "id": "example-lib::example-lib::oldParse",
  "packageName": "example-lib",
  "moduleSpecifier": "example-lib",
  "exportName": "oldParse",
  "deprecation": {
    "status": "user-declared"
  }
}
```

这是虚构测试目标。默认 `moduleSpecifier` 等于 `packageName`。`example-lib/parser` 必须显式指定；不能因为前缀相同就匹配全部子路径。`pkg` 不匹配 `pkg-extra` 或 `@scope/pkg`。

v0 不自动确认 API 真的已 deprecated，也不从 README 猜导出关系。用户声明的目标保留 `user-declared`；要标 `verified`，必须保存上游包版本和可核对来源。原型不需要实现上游验证器。

### 3. 核心数据结构

以下契约类型应在实现时保持等价；可调整文件拆分，不能改变语义。外部 JSON 需要运行时校验，TypeScript 接口本身不提供运行时验证。

```typescript
export type AnalysisStatus =
  | "complete-within-scope"
  | "partial"
  | "failed";

export type RepositoryBucket =
  | "detected"
  | "not-detected-within-scope"
  | "unknown";

export type FindingKind =
  | "import-only"
  | "value-reference"
  | "type-reference"
  | "direct-reexport";

export type AttributionStatus =
  | "declared-module"
  | "manifest-corroborated"
  | "ambiguous";

export interface ApiTarget {
  id: string;
  packageName: string;
  moduleSpecifier: string;
  exportName: string;
  deprecation?: {
    status: "user-declared" | "verified";
    packageVersion?: string;
    sourceUrl?: string;
    checkedAt?: string;
  };
}

export interface Position {
  line: number;
  column: number;
}

export interface Location {
  file: string;
  start: Position;
  end: Position;
}

export interface Snapshot {
  kind: "local" | "git";
  sourceId: string;
  contentHash: string;
  scopeHash: string;
  gitCommit?: string;
  dirty?: boolean;
}

export interface Binding {
  id: string;
  targetId: string;
  location: Location;
  localName?: string;
  form:
    | "esm-named"
    | "esm-namespace"
    | "esm-reexport"
    | "cjs-namespace"
    | "cjs-destructure";
  importSpace: "value" | "type";
  attribution: {
    status: AttributionStatus;
    reasons: string[];
    manifestFile?: string;
    /** Legacy input compatibility only; renderers and reusable caches reject or omit this value. */
    declaredRange?: string;
    dependencyKind?:
      | "dependency"
      | "devDependency"
      | "peerDependency"
      | "optionalDependency"
      | "unknown";
    resolvedVersion?: string;
  };
}

export interface Finding {
  id: string;
  targetId: string;
  bindingId: string;
  kind: FindingKind;
  location: Location;
  ruleId: string;
  snippet?: string;
  snippetRedacted?: boolean;
}

export type GapCode =
  | "SOURCE_UNAVAILABLE"
  | "NO_ANALYZABLE_FILES"
  | "FILE_READ_FAILED"
  | "PARSE_FAILED"
  | "RESOURCE_LIMIT"
  | "SYMLINK_SKIPPED"
  | "SNAPSHOT_CHANGED"
  | "UNSUPPORTED_TARGET_PATTERN"
  | "MODULE_ATTRIBUTION_AMBIGUOUS"
  | "CONFIG_UNRESOLVED";

export interface AnalysisGap {
  code: GapCode;
  message: string;
  targetId?: string;
  location?: Location;
  affectsConclusion: boolean;
}

export interface Inventory {
  discoveredFiles: number;
  excludedByPolicy: number;
  eligibleFiles: number;
  analyzedFiles: number;
  failedOrSkippedEligibleFiles: number;
}

export interface RepositoryTargetResult {
  repositoryId: string;
  targetId: string;
  snapshot?: Snapshot;
  status: AnalysisStatus;
  bucket: RepositoryBucket;
  inventory: Inventory;
  bindings: Binding[];
  findings: Finding[];
  gaps: AnalysisGap[];
}

export interface ScanReport {
  schemaVersion: "0.1";
  reportKind: "scan" | "synthetic-example";
  analyzerVersion: string;
  ruleSetVersion: string;
  analysisProfile: "module-syntax-v1";
  generatedAt: string;
  target: ApiTarget;
  limitations: string[];
  sample: {
    source: "local" | "explicit-list" | "provider";
    selected: number;
    excluded: number;
    attempted: number;
    knownTotal: number | null;
    knownTotalUnit: "repositories" | "unknown";
    exclusionReasons: Record<string, number>;
  };
  summary: {
    detected: number;
    notDetectedWithinScope: number;
    unknown: number;
    completeWithinScope: number;
    partial: number;
    failed: number;
  };
  results: RepositoryTargetResult[];
}
```

#### 3.1 类型约束

`complete-within-scope` 仅表示按照本次明确范围完成，不表示支持任意 JavaScript。缺失总量用 `null`。未知的版本字段省略，不填空字符串或猜测值。

`Location` 行列均从 1 开始，结束位置采用不包含末端的约定；列按 TypeScript/JavaScript 字符串的 UTF-16 code unit 计数。报告显示的行号可与源码平台核对，列号不是视觉字符宽度。统一路径分隔符为 `/`，禁止绝对路径、`..` 和盘符。

`Finding.location` 指向实际引用 token 或 re-export 的导出 token，`Binding.location` 指向对应导入位置。`import-only` 的位置为导入 token。命名空间成员引用应同时能够追溯 namespace binding 和目标成员位置。

`reportKind=synthetic-example` 只用于文档/测试示例。真实 CLI 输出必须为 `scan`，不得把模拟数据写成生产扫描。

#### 3.2 归因层级

`declared-module`：源码声明来自目标模块入口，未执行完整模块解析。

`manifest-corroborated`：在静态可读取 manifest 中找到相应依赖声明且未见已知冲突；仍不是运行时解析证明。

`ambiguous`：发现 `paths` 映射、workspace/local/alias 依赖、未解析配置或其他与目标有关的来源歧义。保留候选发现，明确不计入确定的 detected。

v0 所有结果统一 `analysisProfile=module-syntax-v1`。报告固定提示“依据源码模块声明及有限静态核验，不证明实际加载 npm 产物”。这一全局限制与具体文件的 gap 分开，不要因为所有项目都有这一理论限制，就让所有结果一律失败。

#### 3.3 计数不变量

对单目标扫描：

```text
sample.selected = sample.excluded + sample.attempted
sample.attempted = results.length
summary.detected + summary.notDetectedWithinScope + summary.unknown
  = sample.attempted
summary.completeWithinScope + summary.partial + summary.failed
  = sample.attempted
inventory.eligibleFiles
  = inventory.analyzedFiles + inventory.failedOrSkippedEligibleFiles
```

如果文件枚举本身中断，已知文件数只是已观察数量；用 gap 表示，不能将其解释为根目录真实总量。`knownTotal` 只有同一计量单位的可信来源才可填写。

按 `FindingKind` 展示的仓库数允许重叠，必须标注“可重叠”。一个仓库里 20 次引用不能被算成 20 个下游项目。v0 批量按规范化仓库身份和同一选定 ref 去重；同一仓库配置多个 ref 时要求拆成不同扫描，避免扩大样本数。

### 4. 结果桶与执行状态

#### 4.1 什么是可计数证据

`findings` 中对应 binding 的 attribution 不是 `ambiguous`，即是当前 `module-syntax-v1` 层级下的可计数证据。这个定义证明的是声明与引用关系，不是 npm 运行时解析。

有歧义的候选也可以保留在 findings，渲染为“candidate / ambiguous”；单独计数，不进入 detected。报告应允许直接检查候选，不能只丢掉它们。

#### 4.2 分类顺序

```text
如果至少有一条可计数证据：
  bucket = detected
否则，如果 status = complete-within-scope 且无影响本目标结论的 gap：
  bucket = not-detected-within-scope
否则：
  bucket = unknown
```

有正向证据但部分文件失败：`detected + partial`。这是合法结果。

只有来源有歧义的候选：`unknown + partial`，不能展示为已迁移或无引用。

获取完全失败：`unknown + failed`。可访问目录中没有任何可分析源码：记录 `NO_ANALYZABLE_FILES`，`unknown + partial`，不让空目录显示“安全”。

#### 4.3 Scope exclusions 与 gaps

按公开策略排除 `node_modules` 或声明文件，属于 scope exclusion，必须统计和显示政策，但不自动造成执行失败。

在原本应分析的文件上遇到权限、大小上限、解析失败或目标相关不支持语法，属于 gap，影响完整性。

语法解析失败只输出首个有效 TS 诊断的相对文件、1 起始 UTF-16 行列、end-exclusive 结束位置和数字错误编号；EOF 可为零长度。诊断数量超过 10000 时有界表述，不展开所有诊断。编译器 messageText 可能含源码标识符，不能直接导出；缺少有效位置、UTF-8 解码失败或资源边界时不伪造 1:1 坐标。语法失败文件仍计入 failedFiles，不因补充位置变成 complete。

一般代码里出现未支持语法，不自动让仓库 unknown。需要目标关联，例如 `import("example-lib")`、目标 namespace 被动态索引、目标 binding 发生未支持的传播。无法判断的跨文件间接引用已由 profile 限制说明；不能声称已穷尽检测所有未知路径。

### 5. AST 支持矩阵

| 模式 | 阶段 | 行为 |
|---|---|---|
| ESM named import + 同文件直接引用 | T03 | 通过本地 binding 匹配 |
| ESM alias + 同文件直接引用 | T03 | 引用 alias 对应同一导入绑定 |
| 遮蔽参数/局部变量 | T03 | 不计为目标引用 |
| 仅观察到导入声明 | T03 | `import-only`，不是运行时使用 |
| `import type` / 类型位置 / `typeof` 类型查询 | T04 | `type-reference` 或带 type importSpace 的 import-only |
| Namespace 静态点成员 | T04 | `ns.oldApi`，必须证明 ns 绑定 |
| `export { oldApi } from "pkg"` | T04 | `direct-reexport`；保留别名和类型空间 |
| CommonJS namespace 与解构 | T08 | 限定未被遮蔽的 require，处理重绑定 |
| Namespace 计算属性、传递和别名链 | 暂不支持 | 目标相关 gap，不声称等价解析 |
| Default import 的目标成员与整体传播 | T07 缺口检测 | 按本地 binding 记录 gap，不证明等价于命名导出 |
| `export *` / 多级 re-export | 暂不支持 | 目标相关 gap，不能证明单个 export 被传播 |
| Dynamic import / dynamic require | 暂不支持 | 能关联到目标时 gap |
| JSX props、实例方法、继承、运行时反射 | 暂不支持 | 文档明确排除，识别到目标相关逃逸时 gap |
| 生成代码和 bundled code | 默认排除已知目录 | 报告排除策略；不能自动识别所有生成文件 |

在 T03 尚未支持 namespace 或 re-export 时，相关语法必须进入 unsupported registry，而不是暂时忽略。每当支持一个模式，从该注册表迁移并保留回归测试。

实现进度附注：T04 规则 `0.1.0-t04` 将 named 类型引用、namespace 静态成员和直接命名 re-export 从 registry 迁移为证据；完整验收记录见 STATUS。`import("pkg").Type` 等 inline import-type 仍标记目标相关 gap，不能与已经支持的 `import type { Type }` 混淆。

### 6. 识别规则与具体边界

#### 6.1 Named import 与 alias

```ts
import { oldApi as legacy } from "example-lib";
legacy();
const callback = legacy;
```

两处表达式均是 `value-reference`，不跟踪 `callback` 的后续传播。使用本地导入 symbol/binding 身份比较，不能只比较字符串。

不要求解析 `example-lib` 实际的类型声明。未解析模块的诊断不能把所有导入别名解析到同一个 unknown symbol；保留各自 import binding 身份。使用 ts-morph 或 Compiler API 前为这一行为写 spike 和测试。[S4][S5]

#### 6.2 遮蔽和名称空间

```ts
import { oldApi } from "example-lib";
function run(oldApi: () => void) {
  oldApi();
}
```

函数内调用不是导入引用。导入只有声明时可以输出 `import-only`；报告不能凭该调用输出 `value-reference`。同理排除 catch 参数、块内变量、函数名遮蔽、对象属性键、标签名和来自另一模块的同名符号。

#### 6.3 Import-only 的精确定义

含义是“在已支持的分析范围内，仅观察到该 binding 的导入声明”。不是死代码证明，也不是认定该 API 一定无用。

若 binding 有已识别值/类型引用，不再为这个 binding 额外输出 `import-only`。同一个文件另一个独立未引用导入 binding 可以有自己的 import-only。出现未支持的引用传播时同时保留 gap，不用 import-only 掩盖它。

#### 6.4 类型位置

```ts
import type { OldOptions } from "example-lib";
type Config = OldOptions;
```

引用属于 `type-reference`。`import { oldApi }` 后在 `type F = typeof oldApi` 出现，也属于类型上下文，不是运行时调用。TypeScript 类型导入不会成为生成 JavaScript 的普通运行时导入。[S3]

只保留类型导入但未使用时，用 `import-only` 和 binding 的 `importSpace=type` 表达。重新导出类型仍标 `direct-reexport`，由 binding 的 type/value 信息补充。

#### 6.5 Namespace

```ts
import * as api from "example-lib";
api.oldApi();
```

匹配成员名与 namespace binding。`other.oldApi()` 不匹配。`api[key]`、`const clone = api`、`consume(api)` 在未支持传播时记录目标相关 gap。`api.oldApi` 的源码引用不代表该路径被执行。

`api["oldApi"]` 首版可明确列为 unsupported，不必为了单个例子仓促引入常量求值；后续扩展必须一起更新矩阵和测试。

仅观察到 namespace 导入或其他静态成员，不证明指定命名导出被引用，因此不产生该目标的 import-only。namespace 的 binding 可保留以供回查；计算访问、整体传递及未支持传播仍产生 gap。类型限定名 `api.OldOptions` 按同一 namespace 绑定关联，产生 type-reference。

T07 规则 `0.1.0-t07` 补充 default import 的边界：`import api from "pkg"`（包括 `import { default as api }`）不证明命名导出身份。目标静态成员、可能命中目标的计算成员及整体传参、返回、复制、导出等传播生成 gap；仅导入、直接调用默认函数、访问明确其他成员及局部遮蔽不据此归因目标。默认导入不生成该命名目标的 finding/binding，已有 named/namespace 证据仍可与 gap 共存。

#### 6.6 Re-export

```ts
export { oldApi as legacy } from "example-lib";
```

报告 `direct-reexport`，而不是 import-only 或调用。`export * from "example-lib"` 首版记录 gap，因为不解析目标包导出集合。先 import 再 `export { legacy }` 的同文件传播可后续支持；未支持时记录 gap。

#### 6.7 CommonJS，后续任务

```ts
const api = require("example-lib");
api.oldApi();
const { oldApi: legacy } = require("example-lib");
legacy();
```

只支持 literal specifier 和可证明的绑定。若 `require` 是参数/局部函数，不是 Node require，不能归因给目标包。`api` 后来重绑定、属性被改写或解构不明确时降级为 gap；不要通过执行代码判断值。

### 7. 模块来源与 manifest 背景

有限静态检查优先读取最近的 `package.json` 与安全可读取的 `tsconfig.json`。只按 JSON/JSONC 解析，不执行任何配置。

发现目标依赖为 `npm:other-package@...`、`file:`、`link:`、workspace 本地包或 `paths` 可能重映射目标入口时，保留歧义。若 `extends` 指向外部包、根外路径或循环链，不递归越界，不安装缺失配置，记录 `CONFIG_UNRESOLVED`。

TypeScript 的 `paths` 可以改变编译器模块解析，但不直接改写生成的导入路径。[S3] 因此不能根据它自动推断唯一运行时行为；这里只把相关配置当作来源风险证据。

依赖声明存在，只能提升为 `manifest-corroborated`。缺 manifest 仍可在 `declared-module` 层级报告，不代表 npm 依赖已经核实。锁文件多版本不得折叠成猜测的单一 `resolvedVersion`；v0 可先不解析锁文件。

T06 实现附注（规则 `0.1.0-t06`）：按每个源码目录向根内寻找最近 manifest 和 tsconfig；缺失与读取失败分开处理。JSON/JSONC 重复键、无效形状、根外或包形式 extends、循环和上限形成配置缺口。仅 `./` 或 `../` 开头的根内 extends 可读取，省略后缀时尝试 `.json`；继承数组按顺序覆盖，子配置的 paths 整体覆盖父 paths。缺失 manifest 不伪造 corroborated。

目标 npm/file/link/workspace 声明、本包同名、命中精确/单星 paths，以及根 workspace 选择器匹配的已观察同名包，都产生候选归因。根 workspace 选择器当前支持精确和单星模式，复杂模式作为未解析配置；只核对已捕获源码附近的 manifest，不枚举完整 workspace 或安装依赖。目标无关的有效 paths 不污染结果。dependency 声明值只用于进程内的保守归因判断，不进入新生成的报告；旧报告输入中的 `declaredRange` 由 renderer 丢弃，含该字段的分析缓存不复用。该边界不能据此声称自动识别任意秘密。

### 8. 文件范围、快照与只读输入

#### 8.1 默认范围

包含 `.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs`。默认排除 `node_modules/.git/dist/build/coverage/.next/.cache/vendor` 以及 `.d.ts/.d.mts/.d.cts`。测试、examples 和 demo 不默认全部排除，应在报告中与使用场景一起解释。

排除项可配置且必须记录；默认不声称精确遵从全部项目自定义构建规则。`gitignore` 支持若未实现就明确说明，不靠一个简单规则假装完整兼容 Git。

#### 8.2 文件读取与宿主

对下游文件只读取，不 `require/import`。TypeScript 分析宿主仅返回已允许的快照字节和本工具受控内容，不隐式扫描外部 `node_modules`、用户主目录或其他磁盘路径。

不自动把下游 tsconfig 作为完整 Project 初始化入口。先显式枚举源码，再使用隔离选项或受限 CompilerHost。未解析依赖属于分析 profile 的限制，不用下载依赖消除诊断。

根目录 realpath 后约束所有读取，子级符号链接不跟随。发现应该分析的 symlink 文件记录 gap。读取发生变化时标记或重试，不把混合字节集合伪装成某个 Git commit。

#### 8.3 初始资源预算

下表是可调整的工程默认值，不是性能测量或适配所有仓库的承诺。

| 限制 | 初始默认 |
|---|---:|
| 单源码文件 | 2 MiB |
| 可分析源码文件数 | 5,000 |
| 源码累计读取 | 50 MiB |
| 单仓库分析预算 | 120 秒 |
| 本地仓库并发 | 1 |
| 后续网络重定向 | 最多 3 次，主机白名单内 |
| 后续下载大小 | 压缩 50 MiB，解压累计 150 MiB |

时间与内存边界应在实际实现中通过 worker/进程隔离或可验证的取消机制执行；不能只包一个 Promise.race 然后让同步 AST 工作继续跑。T02 先实现大小、数量和取消边界；进入远程扫描前验证硬超时与回收。

超限保留已完成证据，同时标 gap。每次只解析一个受限仓库，处理完释放 AST 对象。不要默认常驻全部仓库的 TypeChecker。

本地枚举对每个目录先在全局目录项预算内完整收集，再按名称排序后处理，避免文件数或字节截断选择随操作系统目录顺序变化。若 entry 上限在当前目录完整枚举前触发，不从该不完整目录产生任意子集；已经完成的其他目录证据仍保留并标记资源 gap。

T06 增加以下实际资源政策：

| 限制 | 默认 / 上限 |
|---|---:|
| 单配置文件 / 配置累计读取 | 256 KiB / 2 MiB |
| 配置文件数 / 查询数 | 128 / 20,000 |
| 配置目录深度 / extends 深度 | 128 / 16 |
| Worker V8 old-generation | 128 MiB |
| 单文件结果记录 / JSON 字节 | 50,000 / 16 MiB |
| 聚合证据记录 / 序列化字节之和 | 100,000 / 32 MiB |

CLI 的 `scanLocal` 使用单个持久 Worker 顺序处理源码，超时、取消、关闭或线程错误后等待终止，后续重建也须等待回收。Worker 仅运行工具自己的固定入口；源码只是消息中的字节。源文件失败不丢弃之前已完成的证据。内存约束针对 V8 堆和有界输入/结果，不宣称限制进程总 RSS 或所有 native/ArrayBuffer 分配。

`LocalScanOptions.analysisLimits` 可降低聚合记录数、字节预算和 Worker 堆限制，不能提高默认上限；堆限制最低 16 MiB。按整个文件加入证据，超限时舍弃当前文件并标记其余文件未完成。为了保持未知、空输入和获取失败语义，最多三个必要终止诊断允许超过用户降低后的证据预算，政策随 scopeHash 记录；字节预算不是完整文本报告的长度限制。未提供 CLI 调整这些内部 API 限额的选项。

#### 8.4 快照身份

远程报告使用固定 commit，源码链接也指向该 commit。未验证实际获取内容对应指定 commit，不生成“精确链接”。

本地使用排序后的相对路径和实际字节摘要建立内容指纹，并记录范围策略。HEAD、dirty 可选；dirty=false 仅在确实检测过时填写。输出中不展示本地用户名，完整扫描根仅作为进程内部路径。

T06 的本地内容指纹合并源码内容摘要与实际配置相对路径、读取字节摘要及缺失/失败状态；scopeHash 同时包含归因和分析政策版本。只改配置也会改变内容指纹。跨阶段根身份变化时保留源码证据作为候选并记录 SNAPSHOT_CHANGED；这仍不是原子快照。

无可复用快照时不启用持久结果缓存。错误和 partial 结果可以作为诊断缓存，但不能在下一次扫描静默提升为 complete。

### 9. CLI、输出与退出码

#### 9.1 统一参数

P1 支持：`analyze <path>`、`--package`、`--module`、`--symbol`、`--format json|text`、`--output <file>`。`--module` 默认为包名，默认格式可为 text，但 JSON 必须严格可解析。

P3 增加 `scan --repos <file>` 和 markdown。未实现的选项不能出现在 help 中。`--fail-on-reference` 属于后续可选 CI 策略，不提前实现。

T10 实现：`scan --repos <file> --package <name> [--module <entry>] --symbol <name>` 支持 json/text/markdown、`--output`、`--cache <directory>`、`--offline`、`--github-token-env` 和 `--include-snippets`。analyze 同步支持 markdown 和显式 snippets，默认输出仍不含源码片段。离线模式禁止联网，CLI 不允许同时要求 GitHub 凭据。

#### 9.2 stdout/stderr

JSON 模式 stdout 只能包含单个 JSON 文档；进度、警告、调试日志全部 stderr。指定 output 时将完整报告写入外部路径，stdout 不输出混杂的人类摘要。文件写入采用同目录临时文件 + 原子 create-if-absent，不覆盖已有目标；发布失败时只清理由本次操作创建且身份仍匹配的文件。

源码片段默认关闭；开放 `--include-snippets` 时进行限长、控制字符处理和最佳努力脱敏，并说明不能保证覆盖全部秘密。Markdown 默认生成代码块而不是原始 HTML，动态反引号长度与转义要防止源码破坏报告结构。

T10 使用更保守的 token excerpt：每个冻结源文件最多 2 MiB / 100000 行，只索引一次；仅保留已核对位置的目标导出名或相应 local binding token，同一行其余内容遮去，总长度最多 160 UTF-16 字符，`snippetRedacted=true`。渲染及缓存读取还核对这一片段格式。超出片段预算不影响已有引用证据，也不截取任意后续源码。默认不启用；policy 和开关纳入范围/缓存身份。这不识别任意秘密，证据中已有的标识符与相对路径仍可见。

Markdown 的所有自由文本均转义控制/格式字符并放入比内容中最长反引号串更长的代码围栏；计数及枚举独立展示。仅在 repositoryId、Git snapshot/sourceId、完整 commit 三者匹配且未标 dirty 时，按固定 github.com 模板和逐段 URL 编码生成源码链接；不读取 limitations 中的 URL 作为可信链接。批量文件发布保护全部源码根、清单文件和缓存目录，包含缺失根的规范化潜在路径；保持已有父目录、新目标文件、原子 create-if-absent，不覆盖用户文件。

#### 9.4 明确清单与批量预算

`consumers.json` 为严格 UTF-8 JSON，结构 `{ "schemaVersion": "0.1", "repositories": [...] }`。每项只能为 `{ "kind": "github", "repository": "owner/repo", "ref": "explicit-ref" }` 或 `{ "kind": "local", "path": "relative-or-absolute-directory" }`；拒绝额外字段、重复 JSON key、任意下载 URL 和空清单。文件最多 256 KiB、结构深度 8、原始条目 50，读取前后核对文件身份，拒绝 manifest symlink/hardlink。

本地相对路径以清单的规范化父目录为基准。已有目录 realpath 规范化；缺失目录沿最近存在祖先规范化潜在路径，避免 junction 别名膨胀分母。不可确定的不可读路径保留为尝试对象，后续不能推断为无引用。GitHub owner/repo 不区分大小写，同一 ref 的重复项排除；同仓库不同 ref 为配置错误，需拆扫描。本地身份是规范化绝对路径的 SHA-256（只导出摘要），与 github:owner/repo 不混用；两个独立路径的相同字节不合并。

sample.selected 是原始条目数、excluded 是重复项数、attempted 是独立输入数；exclusionReasons 使用 duplicate-input。knownTotal 只描述该输入清单独立仓库数，没有生态总量推断、Star 筛选或自动发现。scanConsumers API 只接受 readConsumers 产生并冻结登记的执行计划，不能传入伪造 repositoryId 的任意对象或反序列化计划来绕过去重或泄露路径。

一次仅执行一个仓库，默认总预算 600000 ms 和 48 MiB 聚合仓库结果/限制说明，API 只可降低。前者对后续仓库和下层中断信号生效；底层 I/O 仍为协作取消。后者以序列化字节计量，一个仓库作为整体加入；预算耗尽时保留已纳入结果，剩余输入 unknown+failed，另为最多 50 个必要失败诊断及固定元数据保留有限空间。不静默丢掉条目，不将遗漏输入标 complete。

#### 9.5 持久 GitHub 缓存

缓存必须显式选择；本地目录当前每次重新捕获源码/配置，不复用没有冻结身份的持久结果。缓存根不能与任何源码根重叠，清单文件也是受保护输入。只初始化父目录已存在的新叶子，现存目录必须具备本工具完整版本结构。短期独占 lease、祖先与文件身份复查、无链接规则、64 KiB 逐块读取和有限库存检查约束缓存访问。失败写入只清理确认为本操作创建且身份未变的未完成文件，不覆盖原有损坏数据，不自动删除历史缓存。

默认缓存容量 512 MiB、100000 个目录项、512 个 snapshot/analysis 记录、单 JSON 记录 16 MiB、每操作最多 120000 ms，并受调用剩余预算约束，API 只能降低。超限或损坏在线回退新获取/分析并有可见限制说明；离线缺失/损坏为 unknown+failed。未知格式缓存根在初始化时拒绝，不能悄悄删除修复。

快照缓存保存已验证 commit 的完整原始文件（按 SHA-256 blob 存储）和 Git blob/路径/大小/tree/archive 元数据；读取时复核并复制至新的私有临时目录，不在持久缓存中执行或分析。只有完整 SHA 能直接命中；浮动 branch/tag 每次在线重新获取，离线拒绝。分析键包含规范 GitHub 身份、完整原始快照摘要（含所有配置文件）、target、完整 scope policy/profile、analyzer/ruleset/attribution/remote/snippet 版本与片段开关，不含凭据或本地路径。

分析记录复核 checksum、结构/计数不变量、snapshot record 对应关系及 scopeHash。仅稳定 Git 结果可复用；资源不足、文件读取失败、变化或回收失败不进入可复用分析缓存，partial 不会提升为 complete。命中报告的 generatedAt 为本次组装时间，原始证据和政策保留，并明确标记缓存命中。本地校验是完整性检测；不认证可重写全部缓存文件及摘要的恶意拥有者。analyzerVersion 为 0.1.0-t10.1，ESM ruleSetVersion 为 0.1.0-t07，attributionVersion 为 0.1.0-t06.1；归因版本更新使可能包含旧 dependency 声明值的分析缓存失效，schema/profile 不变。

#### 9.3 退出码

| 退出码 | 含义 |
|---:|---|
| 0 | 报告正常生成，所有 attempted 输入在范围内完成；允许存在引用 |
| 1 | 无法生成可信报告的内部错误或输出写入失败 |
| 2 | 无效参数或配置，如缺目标字段、无效选项 |
| 3 | 报告已生成，但至少一个结果 partial/failed；即使存在 detected 也用 3 |
| 4 | 后续启用 `--fail-on-reference` 时命中策略，且不存在更高优先级错误 |

优先级：1/2 终止错误，其后 3，其后 4，最后 0。核心函数返回结构化结果，不在分析器里直接 process.exit。Ctrl-C 等取消应回收临时目录，记录未完成，不能输出全成功。

### 10. 报告算例与不能采用的公式

假设有 10 个明确扫描单元：3 detected，其中 1 partial；5 未检出且 complete；2 unknown，其中 1 partial、1 failed。

```text
detected=3, notDetectedWithinScope=5, unknown=2
completeWithinScope=7, partial=2, failed=1
```

以上是测试算例，不是真实用户数据。严禁计算 `7 / 10 = 迁移率` 或 `5 / 10 = 安全删除率`。需要比例时只能给明确定义的样本结果占比，默认 v0 不显示百分比。

不同规则版本、来源级别和范围政策的样本不能不加说明地混合。后续 multi-target 模式应按 target 单独汇总，不把同一仓库重复当成多个生态使用者。

### 11. 测试矩阵与边界验收

| 编号 | 场景 | 关键预期 |
|---|---|---|
| A01 | named import + call | value-reference，位置对应调用处 |
| A02 | alias import + call | 绑定指向原导出 |
| A03 | import 被参数遮蔽 | 参数调用不计数，导入可为 import-only |
| A04 | 其他模块同名 API | 不匹配目标 |
| A05 | `pkg-extra` vs `pkg` | 不按前缀匹配 |
| A06 | 仅注释、字符串出现 | 不输出 finding |
| A07 | 未观察到引用的 import | import-only，不计成调用 |
| A08 | type import/type query | type-reference，非值调用 |
| A09 | namespace dot access | 绑定与成员共同匹配 |
| A10 | namespace 被局部变量遮蔽 | 局部成员不匹配 |
| A11 | direct re-export | direct-reexport，非调用 |
| A12 | star re-export | gap，不能无声略过 |
| A13 | literal dynamic import 目标 | gap，不能 complete-clean |
| A14 | unrelated dynamic import | 不因此污染本目标结论 |
| A15 | require 被局部声明遮蔽 | 不认为来自目标包 |
| A16 | require namespace 重绑定 | 不把后续对象当原模块 |
| A17 | paths / npm alias 冲突 | ambiguous，不计为确定 detected |
| A18 | 缺失 manifest | 声明层级报告，不伪造已验证来源 |
| A19 | 一处有证据、另一文件失败 | detected + partial |
| A20 | 空目录/全是排除文件 | unknown，NO_ANALYZABLE_FILES |
| A21 | 超大文件/累计超限 | gap + partial，保留已找到证据 |
| A22 | symlink 指向根外 | 不读根外字节，记录缺口 |
| A23 | 扫描时文件变化 | 标记快照不稳定，不绑定 HEAD |
| A24 | JSON 模式产生 warning | stdout 仍可 JSON.parse |
| A25 | 输出到源码根内 | 拒绝写入 |
| A26 | Unicode、CRLF、反引号 | 位置可核对，Markdown 不损坏 |
| A27 | 同一仓库重复输入 | 去重不扩大样本 |
| A28 | 仅 ambiguous 候选 | unknown + partial |
| A29 | parse diagnostics | 不凭容错 AST 标 complete |
| A30 | 含恶意 README/AGENTS 指令 | 只按数据处理，不执行 |

安全 tests 使用临时目录、伪造请求和无害 canary，不用真实秘密。恶意 fixture 不得被 Vitest 作为测试文件发现或被构建脚本执行。

### 12. 精度验证方案

建立独立的标签单位 `(snapshot, file, target, binding/reference span, expected kind)`。人工标签应在查看预测前或独立复核时建立，不能只从工具的正向输出里抽样，否则看不到漏报。

```text
Precision = TP / (TP + FP)
Recall = TP / (TP + FN)
```

分母为零时为不可计算，不填 100%。报告支持模式内 recall、来源层级、候选样本中的 unknown 比例和来源误归因次数。对仓库级 detected 与 token 级 finding 分别评估，不混成同一个“准确率”。

准备原创 fixtures 作为可重复回归集；真实仓库小样本作为外部审计集。只在已授权的验证任务中联网获取，并保留可再获取的 commit、文件和许可线索。

### 13. 远程获取和发现的验收约束

远程第一实现只支持公开 GitHub 仓库，先规范化 owner/repo 和 ref，再解析一次 commit。URL host 使用白名单，禁任意内网 URL。下载归档必须防穿越、链接条目、过量解压和不受控重定向。

token 仅来自指定环境变量或受控凭据配置，不能写入报告、缓存 key、异常或 URL。跨主机重定向不转发 Authorization；不支持需要扩大权限的场景时明确失败。

数据源实现必须验证分页、429、退避、超时、缺字段和数据量含义。服务失败时保留 provider 错误，并允许用户选择显式仓库清单；不能自动换到未授权或未核实的爬虫。

T09 实现附注：`fetchGitHubSnapshot` / `scanGitHub` 支持单个明确 `owner/repo + ref` 的公开 GitHub 仓库；批量 CLI、缓存和 Markdown 留给 T10。输入不接受任意 URL、.git 后缀或未给出的默认 ref。先核对公开仓库身份，解析一次 commit，再取得其完整递归 Git tree；truncated 或分页树不能作为完整清单。commit 接口的文件 diff 分页只作为无关元数据忽略，不作为源码 inventory。

仅请求 api.github.com 和固定同仓库/commit 路径的 codeload.github.com。重定向手动处理，最多 3 次，跨主机永不发送 Authorization；不携带 Cookie，不读取响应中的任意 blob/下载 URL。默认匿名；仅调用者显式设置 `tokenEnvironment: "SUNSETGUARD_GITHUB_TOKEN"` 时读取该变量，不自动寻找 Git、gh 或其他凭据。

实际默认限额为压缩 50 MiB、解压流累计 150 MiB（含 tar 头和填充）、单 JSON 响应 8 MiB、tree/归档最多 50,000 条目、路径深度 64、网络请求总计 20、每请求重试最多 2 次、单次退避最多 2 秒。限额只可降低。429、标识限流的 403 与 502/503/504 按有界策略处理；超过 Retry-After/次数预算即明确失败。硬超时为 120 秒，Worker V8 old-generation 为 128 MiB，不声称 OS RSS 总量限制。

通过 tar-stream 解析数据而非调用文件系统解压命令。先拒绝树内 symlink/submodule、不安全/跨平台冲突路径，再验证所有归档文件的大小和 `SHA1("blob " + size + NUL + bytes)` 是否匹配该 commit tree。文件还记录 SHA-256。拒绝穿越、绝对路径、反斜杠、ADS/设备名、重复条目、链接/设备/FIFO、PAX 越界或 sparse、混合顶层目录、截断和摘要不符。缺失任何 tracked file 都失败，因此 export-ignore/export-subst、Git LFS 内容替换等不能静默伪装成完整 commit。GitHub API 是 commit/tree 元数据的信任来源，未独立验证签名。

网络、JSON 和归档处理运行在可终止 Worker。超时、取消、失败和成功均等待线程终止；失败回收工具创建的私有临时目录。成功句柄由调用者 `dispose()`，`scanGitHub` 自动等待回收。解压文件无执行权限继承，不运行任何源码、包脚本、Git hook/filter/submodule 或下游配置。文件系统清理前核对私有根身份；Node 路径与 I/O 仍非 OS 原子隔离。

`scanGitHub` 前后核对已验证树中的文件字节。通过后生成 `snapshot.kind=git`、准确 commit 和固定 permalink base；本地内容 hash 和扫描范围仍单独保留。获取失败为 unknown+failed+SOURCE_UNAVAILABLE；有证据仍可 partial。若扫描后超时，保留已完成的本地内容证据但不标 Git commit；检测到文件变化时保留候选并加 SNAPSHOT_CHANGED。清理失败可见，不丢弃已完成 finding。schemaVersion/profile 不变，analyzerVersion=`0.1.0-t09`，ESM ruleSetVersion 仍为 `0.1.0-t07`，独立 remotePolicyVersion 随 scopeHash 保存。

### 14. 后续扩展的稳定边界

趋势使用相同队列、目标、范围和规则，或显式记录差异。`reference-no-longer-detected` 不自动变成 `migrated`。AI 后续只处理用户明确选择的证据和迁移任务；补丁、测试执行和公开 PR 都需要新的独立安全设计与授权。

任何扩展都不能删除“不执行下游”“不保证安全删除”“未知不充当成功”的基本原则。

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
