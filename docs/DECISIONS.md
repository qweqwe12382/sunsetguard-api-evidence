# 设计决定

更新日期：2026-09-16。本文记录 `v0.1.1` 的当前设计取舍；行为契约以 [SPEC.md](SPEC.md) 为准。

## 1. 保持问题范围狭窄

SunsetGuard 只回答：在一个明确源码快照和声明范围内，指定包、精确模块入口与命名导出出现在哪里。产品不生成迁移率、`safeToRemove` 或安全删除评分，也不从未检出推断迁移完成。

结果桶与执行完整性分开：

- `detected`、`not-detected-within-scope`、`unknown` 描述证据结论。
- `complete-within-scope`、`partial`、`failed` 描述执行完整性。

因此有 finding 的结果仍可能是 partial，空目录或关键分析失败也不能显示为完整无引用。

## 2. 单包 TypeScript CLI

项目采用 ESM TypeScript、Node.js 24.x 和 pnpm 11.7。TypeScript strict、`noUncheckedIndexedAccess` 与 `exactOptionalPropertyTypes` 保持开启。直接依赖固定版本并提交锁文件；`.npmrc` 默认关闭依赖生命周期脚本。

JSON、文本和 Markdown 由同一领域报告渲染。JSON stdout 只包含一个有效文档，诊断进入 stderr。CLI 使用退出码区分成功、内部/输出失败、参数错误以及带 partial/failed 输入的已生成报告。

## 3. 下游源码只作为不可信数据

本地快照只读取允许的 JS/TS 扩展名和受限 JSON/JSONC 配置。不执行下游源码、测试、构建、Git hook、插件或配置脚本，不安装下游依赖。

扫描不跟随符号链接，拒绝多硬链接普通文件和越界路径。读取受单文件、累计字节、文件数量、目录项、深度和时间预算限制。资源上限、读取错误与源码变化形成可见 gap。

快照身份包含规范化相对路径、文件字节摘要和范围政策，不使用本地绝对路径作为公开身份。Git HEAD 只能作为辅助信息，不能替代实际读取字节的内容身份。

## 4. 按 binding 识别引用

分析器使用受限内存 TypeScript CompilerHost：`noLib`、`noResolve`、空 `types`，只暴露已捕获源码字节。最终引用关联基于本地 Symbol 和 binding，不按名字或正则表达式计数。

`import-only`、`value-reference`、`type-reference` 与 `direct-reexport` 分开。命名/别名导入、词法遮蔽、静态 namespace 成员和直接命名重导出都有独立规则。动态访问、整体传播、多级重导出和其他未支持模式形成 gap。

## 5. 来源归因保持保守

模块字符串表示声明来源，不表示已验证 npm 或运行时解析。分析器可在源码根内受限读取最近的 `package.json`、`tsconfig.json` 与相对 `extends`，但不加载完整 TypeScript Project。

正常 registry 声明可提升为 `manifest-corroborated`。npm/file/link/workspace、同名本地包、相关 paths、无法安全读取的配置及其他冲突形成 ambiguous 候选。ambiguous 证据不计入确定 detected。

## 6. 分析工作使用固定 Worker

AST 分析和远程获取使用工具自身的固定 Worker 入口。Worker 不继承任意 `execArgv`，不转发 stdout/stderr；超时、取消、关闭和错误都等待线程终止后再返回。

Worker 的 V8 old-generation、单文件输出和聚合证据均有独立预算。预算不等于操作系统 RSS 上限，也不宣称能原子隔离恶意并发文件系统替换。

## 7. 固定 GitHub commit 获取

远程流程解析公开仓库 ref 后固定完整 commit SHA，再核对 recursive tree 和 commit 对应归档。只允许 GitHub API 与同仓库、同 commit 的 codeload 重定向；跨主机不传播 Authorization。

归档中的每个普通文件必须匹配 Git tree 的路径、大小和 Git blob hash。拒绝路径穿越、链接、子模块、重复/大小写冲突、设备文件、PAX 越界和资源膨胀。GitHub metadata 仍是信任来源，不构成独立签名认证。

默认匿名访问。只有调用方显式选择 token 环境变量时才读取指定值；工具不自动复用 Git 或 `gh` 登录状态。

## 8. 批量清单和缓存

`consumers.json` 使用严格 JSON、大小与条目上限，并要求明确本地路径或 GitHub owner/repository/ref。输入先规范化和去重，重复不进入统计分母。

快照缓存绑定完整 Git 源码身份；分析缓存另外绑定 target、scope、analyzer、ruleset、remote、attribution 与 snippet 政策。只有完整 SHA 可直接离线命中，浮动 ref 必须在线重新解析。

缓存显式开启、有容量边界、不自动 GC。完整性校验用于检测损坏和错配，不用于认证恶意缓存拥有者。

## 9. 报告写入与隐私

外部报告采用 create-if-absent 语义，不覆盖已有文件。写入前后复核源码根、输出父目录和暂存文件身份；失败只清理仍能证明由本次操作创建的对象。

源码片段默认关闭。启用时只保留准确命中 token 的有界遮盖上下文，并在渲染与缓存入口重复验证。报告不复制凭据、本地绝对路径、原始底层错误或任意配置值。

## 10. 评估不冒充总体准确率

固定 benchmark 在查看预测前冻结标签，比较完整 finding/binding span、归因、负例、桶、状态和预期 gap。候选与确定证据分开，partial 或未支持用法不转换成 true negative。

当前标签仍为 provisional，未经独立人工复核。小样本数值只描述固定文件集合，不外推为通用 precision、recall、生态覆盖或安全结论。

## 11. 发布包采用显式白名单

本地试用包只包含工具源码、对应编译产物、相对 source map、锁文件、安全配置、许可证、必要文档和原创示例。它不包含测试、缓存、扫描报告、下游数据、`node_modules` 或 Node 运行时。

独立验收使用冻结生产依赖安装并从单独目录运行 CLI，核对依赖与 Worker 来自解包后的安装目录。归档摘要证明下载内容一致性，不是发布者签名。
