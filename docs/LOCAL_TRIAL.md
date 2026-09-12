# 本地试用指南

适用状态：2026-09-12 的 T10 本地交付版本。当前为 private 本地 CLI，未发布 npm 包，未验证第三方采用。使用 Node 24.x 和 pnpm 11.7.0。

独立试用包包含编译后的 CLI。可在工作区运行 `pnpm run bundle:local` 生成新的本地归档，再按随包 [安装说明](LOCAL_PACKAGE.md) 解包，只安装工具运行依赖，即可从任意工作目录使用。归档、摘要和本地验收目录默认不纳入版本库；包未捆绑 Node/pnpm 或 node_modules，首次依赖安装需要 registry，已有对应 pnpm store 时可加 `--offline`。

在开发工作区也可以自行构建：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
node dist/cli/bin.js --help
```

工程内的 `pnpm run bundle:local` 会构建并生成新的 artifacts/local-trial-* 目录，不覆盖旧产物。独立验收入口为 `pnpm run verify:local <artifact-directory>`，要求本机 store 已缓存锁定的生产依赖；解包目录位于工作区外 SunsetGuard-trials，检查记录位于 artifacts/local-install-*。可选 `--snapshot-cache <existing-cache>` 复用两个示例的已有真实快照，离线重放并核对分析缓存；不传时该项明确记为 not-run。验收保留独立目录供检查，不自动清理用户数据，也不执行下游源码或依赖生命周期。

## 1. 先跑离线演示

```sh
node dist/cli/bin.js scan --repos examples/consumers.local.json --package example-lib --symbol oldApi --format markdown
```

该清单只读取原创 fixture，不安装虚构 example-lib、不执行 fixture。当前已实际验证：退出 0，1 个 detected + complete-within-scope，5 条 finding。演示用于理解输出，不代表真实生态准确率。

## 2. 换成自己的源码和目标

```sh
node dist/cli/bin.js analyze <source-directory> --package <package-name> --module <exact-module-entry> --symbol <named-export> --format json
```

`--module` 可省略，此时等于包名；子入口必须精确填写。源码根可在项目外，不需要安装或构建被分析项目。工具不会执行下游 README、AGENTS、配置、测试或 package scripts。

调查多个消费者时复制 `examples/consumers.local.json` 的格式；相对路径以清单位置为准。支持混合 local 和明确 GitHub/ref，规范化重复项会排除；同仓库不同 ref 要分开扫描。清单最大 256 KiB / 50 项，不是自动生态搜索。

## 3. 读取结果

先看结果桶，再看执行状态和 gaps：

| 输出 | 如何使用 |
|---|---|
| detected | 已观察到可计数引用，按 finding 和 binding 的位置核查 |
| not-detected-within-scope | 在该快照和支持范围内完成且未检出；不等于全局不用或安全删除 |
| unknown | 获取或分析存在缺口，需要看具体 gap |
| partial | 有未完成部分，仍可能同时 detected |
| failed | 该输入未获得可信扫描；不会算作无引用 |
| candidate / ambiguous | 来源有歧义的候选，未纳入 detected |

`import-only`、`value-reference`、`type-reference`、`direct-reexport` 分开显示；都不证明运行时实际执行。引用记录有准确相对路径/位置、绑定、规则与快照身份。语法错误提供首个有效 TS 诊断的位置和错误编号，不导出可能含源码的编译器原文；行列从 1 开始、列按 UTF-16 计，EOF 可以是零长度。解码或资源错误可能没有位置，不会伪造坐标或假设其他文件完整覆盖。

退出 0 表示所有尝试对象在限定范围内完成，允许有引用；3 表示报告已生成但包含 partial/failed；2 是参数/清单错误；1 是内部或输出失败。不要把退出 3 当作“没有发现引用”。

## 4. 保存报告和离线重放

在已存在的外部目录选择一个新文件，加 `--output <new-file>`；文件不能已存在，也不能落在任何被扫描源码目录或缓存内部。报告可放在清单旁。默认没有源码片段；显式 `--include-snippets` 也只保留命中 token，周边内容遮盖。

第一次扫描两个固定 GitHub 历史样本：

```sh
node dist/cli/bin.js scan --repos examples/consumers.github.json --package react-dom --symbol findDOMNode --cache ../sunsetguard-cache --format json
```

第一次需要联网；缓存目录应是新目录、父目录已存在，且与源码目录不重叠。再次离线运行：

```sh
node dist/cli/bin.js scan --repos examples/consumers.github.json --package react-dom --symbol findDOMNode --cache ../sunsetguard-cache --offline --format markdown
```

离线仅能命中完整 commit SHA，缺失记录会返回 unknown+failed。浮动 branch/tag 不会离线当作当前版本。raw snapshot cache 与 analysis cache 分开：同一个已缓存快照可能因规则/目标改变或之前解析失败而重新分析。

缓存默认最多 512 MiB，不自动删除历史记录。强制杀死进程后的残留 lease、未知目录或超限目录可能使初始化拒绝；可以去掉 `--cache` 做新的在线扫描，或指定新的外部缓存目录。工具不自动删除或修复用户已有缓存。缓存拥有者若改写全部字节与摘要，完整性校验不能代替身份认证。

## 5. 本轮真实检查

- 当前全量离线验证：36 个测试文件，513 passed / 1 skipped；typecheck、lint、build 通过。增加 8 项解析诊断位置、Unicode/CRLF/EOF、数量边界和源码不泄露回归。
- 真实批量 CLI：2 个完整 GitHub commit、3 个输入条目去重为 2 个仓库；601 个原始文件通过获取校验。默认分析范围 461 个文件，其中 460 个已分析、1 个语法失败。
- 在线 JSON、离线 JSON、离线 Markdown 均退出 3，结果为 unknown=2、partial=2。在线与离线 repository results 完全一致。两个快照均可缓存，rc-util 稳定 partial 复用分析缓存；reactstrap 因一个解析失败文件重新分析，没有将其提升为 complete。
- 这些真实扫描和演示产物保存在本地 `artifacts/` 目录，默认被版本控制忽略；它们是本工作区的运行记录，不是随 npm 发布的公共文件。

上述联网记录来自 T10 首轮，未覆盖后续诊断位置变更。当前 analyzer 为 0.1.0-t10.1，ESM ruleset 为 0.1.0-t07；独立试用验收重放已有真实快照，未重新访问 GitHub。reactstrap 的首个语法诊断现在定位到 src/index.js:1:1—1:7（TS1128），总计 273 个诊断，仅展示首个位置；该文件仍失败、仓库仍 unknown+partial。

最终本地验收包含 180 个白名单文件、独立生产依赖安装和 20 项检查，包括从第三个空目录运行包内演示、正/负/partial、退出码、外部输出拒绝覆盖、Markdown、两个 Worker 入口和真实缓存重放；逐项核对目标、仓库及完整 commit。远程 Worker 的无效输入探针只验证入口加载，不作为联网下载验收。具体归档摘要和检查记录只在生成它们的本地 `artifacts/` 目录保留。

独立安装目录位于工作区同级的 `../SunsetGuard-trials/`（每次验收随机生成子目录），可直接使用其中的 `dist/cli/bin.js`；完整解包和依赖目录保留供检查。独立验收入口、包摘要与实际安装不依赖原工作区 node_modules。

Windows 上本机验证通过；POSIX 实机、独立人审、真实维护者试用与长期运行尚未验证。T07 小样本标签仍为 provisional。自动发现、历史比较、迁移补丁均未实现；没有安全删除分数或迁移率。

后续试用反馈只需记录目标三元组、快照身份、具体证据/缺口和期望行为。不要分享令牌、完整本地路径、私人源码或未经允许的完整报告。
