# SunsetGuard 路线图

更新日期：2026-09-16。当前发布为 `v0.1.1`。

路线图描述公开产品范围和验证前置条件。功能是否完成以实现、测试和 [STATUS.md](STATUS.md) 的当前证据为准。

## 已交付

| 领域 | 状态 | 说明 |
|---|---|---|
| 领域契约与 CLI | complete | 明确结果桶、执行状态、退出码和 JSON stdout 契约 |
| 安全本地快照 | complete | 有界读取、路径与链接限制、内容身份和可见 gap |
| ESM binding 分析 | complete | named/alias、遮蔽、value/type、namespace 静态成员、direct re-export |
| 来源归因 | complete within scope | 受限读取 package/tsconfig；歧义保持 candidate |
| 隔离与资源限制 | complete within scope | 固定 Worker、超时/取消回收、输出与聚合预算 |
| 报告 | complete | JSON、文本、Markdown，安全外部写入和默认关闭片段 |
| 固定 GitHub commit 获取 | complete within scope | 受限主机、commit/tree/archive 核对、归档攻击防护 |
| 批量清单与缓存 | complete | 受限 consumers manifest、去重、有界缓存、离线重放 |
| 本地试用发布 | complete | MIT、v0.1.1 Release、独立包验收、Linux/Windows CI |
| 固定真实样本 | provisional | 工程流程完成，仍待独立人工复核 |

`complete within scope` 表示已实现并测试声明范围，不表示所有 JavaScript/TypeScript 模式、任意仓库或生产网络条件均已覆盖。

## 验证优先事项

### R1 · 独立 benchmark 复核

复核 `benchmarks/` 中固定源码、标签理由、finding/binding 位置、负例和预期 gap。只有独立复核完成后才能增加 `human-reviewed` 证据；现有小样本不得当作总体准确率。

### R2 · 真实维护任务试用

使用发布包调查一个明确的包名、模块入口、命名导出和固定源码快照。记录报告是否帮助维护者完成判断，以及误报、漏报或阻碍使用的 gap。不得用下载量、star 或测试数量代替采用证据。

### R3 · 跨平台和规模验证

补充 macOS、长时间运行和声明硬件条件下的大仓库资源测量。Linux/Windows CI 已覆盖当前离线套件；这些结果不自动扩展为生产 SLA。

## 可选功能

### 有限 CommonJS 支持

只有真实样本表明 ESM-only 范围阻碍使用时，才实现明确的 `require` 解构、静态成员读取和直接 `module.exports` 模式。动态属性、赋值传播和条件加载继续形成 gap。新增模式必须包含正例、负例、遮蔽和未支持情况测试。

### 仓库发现

只有在真实维护任务和手工清单流程证明价值后，才评估一个只读发现来源。发现提供者必须与包统计分开，记录分页终止、覆盖范围、未知总量和排除理由；不得把依赖包计数冒充可扫描仓库列表。

### 固定队列历史比较

只有在同一目标和仓库集合存在重复扫描需求时，才比较相同 target、scope、analyzer、ruleset 和 snapshot 身份。历史变化不能自动解释为迁移完成或安全删除。

## 明确不在当前路线图

- 自动生成迁移 PR 或自动删除 API
- 跨主机传递用户凭据
- 执行或安装被扫描项目
- Web UI、账号、支付、MCP 或多语言分析
- 依据未检出生成安全评分、迁移率或 `safeToRemove`

## 贡献选择标准

优先处理会导致错误来源归因、unknown 被当 clean、partial 丢失、越界读取或执行、凭据泄露、JSON 污染、不可复查证据和资源限制失效的问题。功能扩展需先说明真实用例、范围、失败表达和回归测试。
