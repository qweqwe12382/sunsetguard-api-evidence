# SunsetGuard 项目状态

更新日期：2026-09-16。当前公开版本：[v0.1.1](https://github.com/qweqwe12382/sunsetguard-api-evidence/releases/tag/v0.1.1)。

本文件只记录当前实现、可复核验证和已知限制。历史开发过程可通过 Git 提交与 GitHub Actions 查看。

## 发布状态

- 公开仓库：<https://github.com/qweqwe12382/sunsetguard-api-evidence>
- 默认分支：`main`
- 当前发布：`v0.1.1`
- 许可证：MIT
- 包分发：提供 GitHub Release 本地试用包；npm 包保持 `private: true`，尚未发布到 registry
- 维护入口：`MAINTAINERS.md`、`.github/CODEOWNERS`、`CONTRIBUTING.md`、`SECURITY.md`
- GitHub private vulnerability reporting：已启用

## 已实现能力

- 扫描明确指定的本地源码目录，或固定 commit 的公开 GitHub 仓库。
- 识别 ESM named/alias import、import-only、value-reference、type-reference、静态 namespace 成员和 direct re-export。
- 依据本地 binding 处理词法遮蔽，不使用名称或正则表达式作为最终引用证据。
- 输出 JSON、文本或 Markdown；JSON stdout 保持单份有效文档，诊断写入 stderr。
- 将结果桶 `detected`、`not-detected-within-scope`、`unknown` 与执行状态 `complete-within-scope`、`partial`、`failed` 分开。
- 对解析错误、未支持语法、来源歧义、源码变化和资源上限生成可见 gap。
- 支持受限 `consumers.json` 清单、顺序批量扫描、有界缓存和固定快照离线重放。
- 不执行被扫描项目的源码、测试、构建、配置或生命周期脚本，也不安装其依赖。

## 当前验证

| 检查 | 当前证据 |
|---|---|
| 本地完整检查 | `pnpm run check` 通过；36 个测试文件，527 passed，1 个 Windows symlink 权限用例 skipped；typecheck、lint、build 通过 |
| 最终远端 CI | [GitHub Actions run 35053225665](https://github.com/qweqwe12382/sunsetguard-api-evidence/actions/runs/35053225665) 成功；Ubuntu 和 Windows 共 2 个 job |
| Ubuntu CI | 36 个测试文件，526 passed，2 skipped |
| Windows CI | 36 个测试文件，528 passed |
| 发布包 | 181 个文件，241991 字节，SHA-256 `90c420828c944054cc6a37f0760b277b00e959caab4e831bed307dcae0032d25` |
| 独立包验收 | 解包、冻结生产依赖安装、CLI、Worker、缓存和许可证共 20/20 checks passed |
| 生产依赖审计 | `pnpm audit --prod --registry https://registry.npmjs.org` 返回 `No known vulnerabilities found`；仅代表当时 registry advisory 数据 |

发布包包含工具源码、对应编译产物、锁文件、MIT 许可证、实现规范和原创示例，不包含 `node_modules`、运行时、缓存、扫描报告或下游源码。具体安装步骤见 [LOCAL_TRIAL.md](LOCAL_TRIAL.md)。

本次复核首次在受限 Windows 账户运行完整套件时，因用户目录祖先的 `realpath` 访问被拒绝而出现 29 个缓存相关环境失败；相同代码和命令在正常仓库权限下重跑后为 36 files / 527 passed / 1 skipped。该失败未计为产品通过，也未通过删除断言处理。

## 真实样本证据

- 固定 benchmark 包含 3 个仓库、6 个选定源码文件，标签仍为 provisional，未经独立人工复核。
- 该小样本结果只能验证既定 fixture 和评估流程，不能推导通用 precision、recall 或安全删除结论。
- 固定公开仓库批量扫描曾核验 601 个文件；默认范围为 461 eligible、460 analyzed、1 parse failed。两个仓库结果均为 `unknown + partial`，在线与离线重放一致。
- 真实网络正常路径已有记录；生产 SLA、任意异常网络和任意仓库兼容性没有得到证明。

## 安全与结论边界

- 未检出引用只表示在声明范围内未发现证据，不表示 API 已迁移、运行时未使用或可安全删除。
- 模块字符串只表示声明来源，不证明 npm 或运行时解析结果。
- ambiguous 证据只作为候选展示，不计入确定 detected。
- 有 finding 的结果仍可能是 partial；空目录、解析失败和资源上限不能显示为完整无引用。
- 证据包含固定快照身份、相对路径、准确位置、binding、分析器版本与规则版本。
- 默认不输出源码片段；启用片段时仅保留有界、遮盖后的目标 token 上下文。

## 已知限制

- CommonJS、dynamic import、namespace 整体传播、多级重导出和运行时别名传播没有完整支持。
- benchmark 尚未完成独立人工复核，也没有可验证的第三方维护者采用证据。
- macOS、长期运行、生产 SLA 和大规模生态准确率尚未验证。
- 自动生态发现、历史趋势比较、迁移补丁、Web UI、账号和 npm 发布不属于 v0.1.1。

## 后续验证优先级

1. 由独立人员复核固定 benchmark 标签及 finding/binding 位置。
2. 使用发布包完成一次真实维护任务，记录报告是否帮助完成判断。
3. 根据真实 gap 决定是否增加有限 CommonJS 或其他语法支持。
4. 在出现重复扫描需求后再评估历史比较；在有采用证据后再评估自动发现。

## Codex for Open Source 申请

申请字段、可粘贴回答和提交检查清单见 [CODEX_FOR_OSS_APPLICATION.md](CODEX_FOR_OSS_APPLICATION.md)。公开仓库不保存申请人的真实姓名、ChatGPT 账号邮箱或 OpenAI Organization ID。仓库准备完成不等于申请已提交或获批。
