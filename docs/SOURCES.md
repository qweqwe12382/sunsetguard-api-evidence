## 十、官方资料与验证边界

对应分文件：`docs/SOURCES.md`。

文档版本：0.2.1；核对日期：2026-09-16。

本文件区分“官方文档支持的事实”和“项目仍需实际验证的假设”。引用不代表推荐某个供应商，也不代表对其服务持续可用性的保证。

### 资料目录

#### S1 · OpenAI：Codex for Open Source

来源：<https://openai.com/form/codex-for-oss/>

用途与边界：核对公开申请条件：实际使用、生态重要性、活跃维护。不能据此推算本项目入选概率。

#### S1a · OpenAI：Codex for Open Source Program Terms

来源：<https://developers.openai.com/codex/codex-for-oss-terms>

用途与边界：核对申请信息需准确完整、维护者身份可被验证、API credits/Codex Security 只能用于有权管理或审查的仓库与代码，以及申请材料不应包含机密信息。项目申请材料不能把公开可读的第三方源码视为已取得使用计划权益下的审查授权。

#### S2 · OpenAI：Custom instructions with AGENTS.md

来源：<https://developers.openai.com/codex/guides/agents-md>

用途与边界：核对 AGENTS.md 的发现、目录作用域和默认文档体积限制。官方入口当前重定向至 ChatGPT Learn。

#### S3 · TypeScript：Modules — Reference

来源：<https://www.typescriptlang.org/docs/handbook/modules/reference.html>

用途与边界：核对模块入口、类型导入、paths 与模块解析。解析模式与实际运行环境需要分别考虑。

#### S4 · Microsoft TypeScript：Using the Compiler API

来源：<https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API>

用途与边界：核对 Compiler API、Program、TypeChecker 和 getSymbolAtLocation。

#### S5 · ts-morph：Finding References

来源：<https://ts-morph.com/navigation/finding-references>

用途与边界：核对引用查找接口。不是对 SunsetGuard 准确率或性能的证明。

#### S6 · typescript-eslint：no-deprecated

来源：<https://typescript-eslint.io/rules/no-deprecated/>

用途与边界：核对已有的 deprecated 引用检测能力及其类型信息要求。

#### S7 · Codemod：Insights

来源：<https://docs.codemod.com/platform/insights>

用途与边界：核对跨仓库迁移、API adoption、趋势和快照能力；不沿用未经本轮核验的价格。

#### S8 · ecosyste.ms：Repositories routes.rb

来源：<https://github.com/ecosyste-ms/repos/blob/main/config/routes.rb>

用途与边界：官方源码存在 dependent_repositories 路由；本轮未实测生产 API 的覆盖、鉴权、分页或稳定性。

#### S9 · deps.dev：API v3alpha / GetDependents

来源：<https://docs.deps.dev/api/v3alpha/>

用途与边界：GetDependents 提供公开依赖包计数，不是可直接扫描的完整下游仓库列表；计数也非完整生态普查。

#### S10 · React：React 19 Upgrade Guide

来源：<https://react.dev/blog/2024/04/25/react-19-upgrade-guide>

用途与边界：核对 findDOMNode 的来源包为 react-dom 及其历史移除背景。不是历史生态迁移率数据。

#### S11 · pnpm：pnpm install

来源：<https://pnpm.io/cli/install>

用途与边界：核对 --ignore-scripts 和 --frozen-lockfile 等选项；仅适用于经允许的本项目依赖安装，不授权安装下游依赖。

### 本轮确实完成的工作

阅读并核对上述官方页面或官方项目源码；整理产品边界、协议、任务和验收标准。没有访问用户的 GitHub 私有仓库，没有运行 SunsetGuard，没有测试外部 API 的真实下游列表。

### 不能写成“已验证通过”的事项

| 事项 | 当前状态 | 后续验证方式 |
|---|---|---|
| SunsetGuard npm 名称与商标可用性 | 未验证；仅工作名 | 发布前查询官方注册表并核实命名风险，不抢注占位刷包 |
| 自动发现下游的生产接口 | 未实测 | 对选定包进行带记录的契约测试，验证分页、错误和覆盖 |
| 分析器真实误报率和漏报率 | 未测量 | 固定快照、人工标注、独立复核 |
| 第三方维护者愿意使用 | 未验证 | 先提供少量报告，再观察实际使用行为 |
| 大仓库时间与内存开销 | 未测量 | 在声明硬件和输入规模的条件下记录实际测量 |
| 任意 API 都能分析 | 明确不承诺 | 根据支持矩阵逐项验收 |
| API 可以安全删除 | 不属于产品可证明的结论 | 维护者结合版本、私有用户、测试与发布政策判断 |
| Codex for OSS 申请成功率 | 无公开依据可计算 | 只依据届时的官方条件提交真实材料 |

### 如何更新资料

实现涉及外部接口或新依赖时，核实官方文档与选定版本；记录检索日期、请求类型和结论。只记录脱敏的响应片段，不保留 token。不能把“仓库源码定义了路由”升级成“该 API 已验证可用”。如文档与实测不同，保留两者并解释差异。

---


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
