# T07 固定真实源码审计

2026-09-11：完成首批真实文件子集扫描、标签与评估。**所有标签仍为 provisional，由 Codex 在查看预测前阅读源码建立，未经独立人工复核。** 这不是全仓库扫描、外部精度认证或维护者试用证据。

## 目标与样本

目标为 `react-dom::react-dom::findDOMNode`。React 官方的 [React 19 升级指南](https://react.dev/blog/2024/04/25/react-19-upgrade-guide#removed-reactdomfinddomnode)明确讨论该历史 API，并展示其命名导入。本次使用历史消费者版本；以下范围均来自 manifest，不代表实际安装或锁定的 React DOM 版本。

| 样本 | 固定 commit | 所选源码与 manifest 背景 |
|---|---|---|
| [mui/material-ui v4.12.4](https://github.com/mui/material-ui/tree/a563a60219f7f6519fb0f34f6d8e3bf0974e6495) | `a563a60219f7f6519fb0f34f6d8e3bf0974e6495` | RootRef、Portal、setRef；最近 @material-ui/core manifest 的 peer react-dom 为 `^16.8.0 \|\| ^17.0.0` |
| [react-component/util v5.39.0](https://github.com/react-component/util/tree/6253c1b69eaf6dbde64f32370a69df0f24865715) | `6253c1b69eaf6dbde64f32370a69df0f24865715` | Dom/findDOMNode.ts、Dom/canUseDom.ts；peer `>=16.9.0`，dev `^18.0.0` |
| [reactstrap/reactstrap v8.10.1](https://github.com/reactstrap/reactstrap/tree/41eb0d427c3c8568948ec47880af7cb473228215) | `41eb0d427c3c8568948ec47880af7cb473228215` | Button.js；peer `>=16.3.0`，dev `^16.3.2` |

这是按源码语法选择的便利样本，每个仓库只有一个选定文件子集，共 3 个独立仓库、6 个源码文件。选样时也查看了未入选的 react-transition-group，未根据工具预测筛选阳性。当前覆盖 namespace 引用、注释/字符串和无关组件负例、默认导入成员未知例；真实 named alias、类型、import-only、direct-reexport、来源歧义、遮蔽分布仍未审计，只有原创回归证据。

`samples.json` 列出仓库、SHA 和源码路径；`sources.lock.json` 记录 33 次准备请求的 SHA-256/字节数或 404 缺失状态，共保存 42,988 字节。源码所有祖先目录均查询 package.json、tsconfig.json，MUI 根内 extends 配置已纳入。标签仅在选样时解析一次，准备脚本始终使用固定 SHA。

三个根 LICENSE 均为 MIT，随外部样本保存并记录摘要。源码及其注释中的命令只作为数据，不复制到本工程、不执行、不安装下游依赖。首轮样本位于本工程同级 `SunsetGuard-samples/t07-WszJ3S`，未在其中启动 Codex。

## 标签与计数

`annotations.json` 在查看本轮预测前冻结，记录理由、一基 UTF-16 位置和 binding 位置。每个文件已由代理全文阅读；`exhaustive=true` 只表示对这个文件、这个目标的预期 finding 集合穷尽，不等于人审。没有从 AST 预测复制标签。

独立人审应先读取固定源码及标签理由，再核对预测，检查完整文件中的遗漏、token/binding、类型空间、归因及缺口。只有实际完成后才可记录 `human-reviewed`；本轮没有这种外部复核或维护者反馈。

| 单位 | 实测计数 | 分母和含义 |
|---|---|---|
| 支持范围内 finding | TP=3、FP=0、FN=0 | precision 分母 TP+FP=3；recall 分母 TP+FN=3，仅 namespace 值引用 |
| 未支持位置 | 匹配=1、缺失=0 | 预期 unknown 标签分母=1；不作为 TN 或支持模式 FN |
| 负标签 | TN=4、FP=0、无法充分判定=2 | 共 6 个；两个属于 partial 子集，未认证为 clean |
| 来源层级 | 正确=3、错误=0 | 已匹配 finding 分母=3，仅核对 manifest-corroborated 声明层级 |
| 子集 detected 二分类 | TP=1、FP=0、FN=0、TN=1 | 可确定期望的子集 2 个；unknown 子集 1 个独立报告 |
| 子集结果桶 | detected=1、not-detected-within-scope=1、unknown=1 | 分母 3；unknown 占 1/3，仅所选样本占比 |
| 执行完整性 | complete=2、partial=1、failed=0 | 分母 3；桶与状态分别均有 3/3 相符 |

evaluation JSON 保留数值比值，零分母为 null。`confirmed` 仅指非 ambiguous 的句法/归因证据，不表示已人审。样本小且有选择偏差，不能推导生态准确率、安全删除、迁移率或性能 benchmark；不能以三条匹配宣称通用准确性。

## 复现与产物

准备快照后的评估全程离线，只在 SunsetGuard 工程执行：

```sh
pnpm run build
node scripts/t07-evaluate.mjs <prepared-snapshot-parent>
```

runner 在任何预测前冻结全部标签，通过本工具有界 snapshot/config reader 校验源码、配置及缺失状态，并计算预期内容指纹。随后仅执行编译后的 SunsetGuard CLI，扫描后再次校验字节。ESM 规则版本匹配冻结标签，分析器版本按本次构建记录，二者独立校验；历史 dataset/report 不被覆盖。实际 scopeHash 随报告保存，跨版本或平台比较必须声明政策差异。

新结果写入 `artifacts/t07-*` 独占目录，验证 CLI 退出码、单 JSON stdout、空 stderr、领域不变量、无片段及扫描根泄漏。评估器比较完整 finding/binding span、归因、负标签、结论相关 gap、桶和状态；不从缺失或 partial 报告制造 TN。它不强制阈值全绿，失配会如实保存。

重新下载本批固定文件可单独执行以下显式联网命令，不属于默认测试或产品远程能力：

```sh
node scripts/t07-prepare.mjs
```

仅接受脚本列出的三个仓库与 SHA，固定 raw.githubusercontent.com、不携带凭据、禁重定向、单文件 256 KiB、总计 2 MiB、最多 64 请求、总预算 120 秒。新建工程外唯一目录；已有锁只能验证，不能静默替换。失败时保留不完整目录用于诊断。该专用脚本只验证了本次正常请求；429、重定向、恶意归档等完整安全验收留给 T09。

最终 [results](results/) 保存每个样本的 dataset、report、evaluation 和 [summary.json](results/summary.json)，汇总绑定 annotations/source lock 摘要。结果没有源码片段、本地绝对路径或凭据。CLI 仍输出真实 scan 和 local 快照，固定仓库 SHA 与源码链接由本清单提供，不伪造产品 Git 快照能力。

## 验收边界

T07 工程交付完成；独立人工复核、维护者试用、其他 ESM 模式的真实精度、POSIX 实机均未完成。下一开发任务为 T09 安全固定 commit 获取；T08 CommonJS 可选且尚无明确需求。本轮不跨入 T09。
