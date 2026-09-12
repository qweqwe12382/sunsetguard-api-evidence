# SunsetGuard 本地试用包

这是私有目录试用包，已经包含编译后的 CLI，不需要重新构建。需要 Node.js 24.x 和 pnpm 11.7.0。尚未发布 npm 包，也没有验证真实维护者采用。

## 解包和安装

在工具目录以外放置要分析的消费者源码。先核对随包提供的 SHA256SUMS.txt，再解包（Windows 自带 tar 或兼容工具均可）：

```sh
tar -xzf sunsetguard-local-trial.tgz
cd sunsetguard
pnpm install --prod --frozen-lockfile --ignore-scripts
node dist/cli/bin.js --help
```

此步骤只安装 SunsetGuard 自身的运行依赖，不安装或运行被分析项目。首次安装依赖需要 npm registry 网络；如果本机 pnpm store 已有锁定版本，可以增加 `--offline`。包未附带 node_modules 或 Node/pnpm 安装程序。

目录包使用包内 node 入口，不假设存在全局 sunsetguard 命令。只要提供完整路径，可以从任意工作目录运行：

```sh
node <tool-directory>/dist/cli/bin.js --help
```

## 离线演示

在工具目录运行：

```sh
node dist/cli/bin.js scan --repos examples/consumers.local.json --package example-lib --symbol oldApi --format markdown
```

该命令只读取附带的原创 fixture；不执行它。预期为 1 个 detected + complete-within-scope、5 条 finding、退出 0。它不是生态精度基准。

## 自己的调查

```sh
node dist/cli/bin.js analyze <consumer-source-directory> --package <package-name> --module <exact-entry> --symbol <named-export> --format json
```

module 可省略，此时等于 package；子入口必须精确填写。批量使用 examples 清单格式，local 相对路径以清单位置为准，GitHub 必须有明确 owner/repo 和 ref。清单最多 50 条、256 KiB；重复仓库不会扩大分母，同仓库不同 ref 分成不同扫描。没有自动生态发现或 Star 筛选。

## 保存与缓存

`--output <new-file>` 将报告写到已存在的外部目录，stdout 为空；目标文件必须不存在，且不能位于任何消费者源码或缓存目录内。支持 json、text、markdown。

对固定 GitHub 历史样本先联网建立缓存：

```sh
node dist/cli/bin.js scan --repos examples/consumers.github.json --package react-dom --symbol findDOMNode --cache ../sunsetguard-cache --format json
```

然后离线重放：

```sh
node dist/cli/bin.js scan --repos examples/consumers.github.json --package react-dom --symbol findDOMNode --cache ../sunsetguard-cache --offline --format markdown
```

缓存目录第一次必须是新目录，父目录已存在；不能与源码根重叠。只有完整 SHA 可直接离线命中。离线缺失返回 unknown+failed，不会联网回退。默认缓存 512 MiB，不自动删除历史记录；损坏/残留锁可能需要换新目录。快照与分析缓存分别验证，规则或目标变动会重新分析。缓存完整性检查不认证能改写全部摘要的拥有者。

默认匿名访问 GitHub；显式 `--github-token-env` 才读取 SUNSETGUARD_GITHUB_TOKEN，不能与 offline 同用。不要把令牌写入清单、命令参数或报告。

## 解释结果

| 字段 | 含义 |
|---|---|
| detected | 已发现可计数的声明/引用证据 |
| not-detected-within-scope | 在本次快照、支持范围内完成且未检出 |
| unknown | 有获取或分析缺口，需要核查 gaps |
| complete-within-scope / partial / failed | 独立的执行状态，有引用也可以 partial |
| candidate / ambiguous | 来源未确定的候选，不计入 detected |

退出 0 表示报告完整生成、所有输入在限定范围内完成，允许有引用；退出 3 表示报告有 partial/failed；2 是参数/清单错误；1 是内部或输出错误。类型引用、值引用、import-only、direct-reexport 分开记录，都不证明运行时执行。标准语法错误提供首个 TS 诊断的文件/位置，EOF 位置可以是零长度；无法解码或超限时不伪造坐标。

默认不导出源码片段。`--include-snippets` 只保留准确命中 token，周边内容遮去，不能视作通用秘密检测。未检出不等于迁移、安全删除或全局未使用。证据的准确范围与限制见 [SPEC](docs/SPEC.md)。

## 包含内容与验证边界

此包包含本工具的 dist、对应 TypeScript 源码与相对 source maps、固定依赖锁、安全 .npmrc、必要文档和原创演示。源码供溯源检查；目录包不附开发测试/重建命令。package.json 的 devDependencies 保留用于锁文件一致性，安装命令的 `--prod` 会跳过它们。

不会包含下游真实源码、缓存、日志、历史报告、私有配置或原工作区 node_modules。文件白名单和摘要见包外的 bundle.json，归档摘要见 SHA256SUMS.txt；这些用于检验本地交付一致性，不是发布者签名。开发记录与测试结果在原工程 STATUS 中，未捆绑为采用证据。

本轮只验证 Windows 本地交付；其他平台、独立人审、真实维护者采用和长期运行不能视为已通过。自动发现、历史趋势、迁移补丁与公开发布不在此包内。
