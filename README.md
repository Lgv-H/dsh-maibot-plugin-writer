# dsh-maibot-plugin-writer

> 🤖 **本仓库（含全部代码、测试与文档）由 AI 编写与维护** —— 由 DeepSeek Harness 的 agent 在人类需求驱动下生成，见 [AI 编写声明](#ai-编写声明)。

[![ci](https://github.com/Lgv-H/dsh-maibot-plugin-writer/actions/workflows/ci.yml/badge.svg)](https://github.com/Lgv-H/dsh-maibot-plugin-writer/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![AI 编写](https://img.shields.io/badge/%E7%94%B1_AI_%E7%BC%96%E5%86%99-DeepSeek_Harness-black.svg)](#ai-编写声明)

[English](README.en.md) | 中文

让 **DSH（DeepSeek Harness）自己写麦麦（MaiBot）插件**：读当前宿主的真实契约 → 生成骨架 → 校验到 0 error → 安装。

装上它之后，你对 DSH 说"给麦麦写一个每天早上的天气播报插件"，它会自己查宿主的真实 SDK 契约、生成三件套、把校验跑到干净，再交付给你启用——而不是凭记忆猜 API。

---

## 这是什么

一个 DSH 插件（cordis bundle），向 agent 注册 5 个麦麦插件开发工具，并随包投放 1 个 skill：

| 层 | 内容 |
|---|---|
| **工具** | `maibot_plugin_catalog`、`maibot_sdk_reference`、`maibot_plugin_scaffold`、`maibot_plugin_validate`、`maibot_plugin_install` |
| **Skill** | `maibot-plugin-writer`（加载时投放到 `<dshHome>/skills`，热加载生效） |
| **事实源** | 能力白名单与 `ctx.*` 方法表实时取自运行中的 MaiBot 源码与已安装的 `maibot_sdk` |

## 为什么需要它

MaiBot 的插件契约细节多、版本内演进快。凭记忆写，踩的都是"加载失败 / 运行时报错"这类硬问题：

| 宿主真实约束 | 凭记忆写的常见后果 |
|---|---|
| `_manifest.json` 是 `extra="forbid"` 的强类型模型 | 多写一个字段、版本号写成 `0.1`、`author.url` 不是 http(s) URL → manifest 校验失败 |
| `capabilities` 是授权层白名单，运行时逐次校验 | 代码用了没声明 → `未获授权能力`；声明了宿主没注册的名字 → manifest 非法 |
| SDK 接口会随版本变化 | `ctx.frequency.check` / `ctx.person.get` / `ctx.render.render` 在当前 SDK 里**并不存在** |
| `@EventHandler` 默认 `intercept_message=False` | 返回 `{"blocked": True}` 被丢弃，消息照常继续处理 |
| ON_MESSAGE 只传 `message` 参数 | 取 `stream_id` / `plain_text` 都是空的：正确写法是 `message["session_id"]`、`message["processed_plain_text"]` |
| 只有 `[plugin].enabled = true` 的插件会被激活 | 插件写好了却"没反应"；反之缺 `[plugin]` 段会被当作已启用 |

`maibot_plugin_validate` 把上面这些全部静态检查一遍；能拿到 Python 时还会用 AST 深检语法、导入、调用链与类结构。

## 核心能力

### `maibot_plugin_catalog`

列出 `plugins/` 下的已有插件（ID / 名称 / 版本 / 目录 / 启停状态 / 组件 / 能力声明 / 行数）与宿主当前注册的能力名。
用途：查 ID 冲突、找可参考的写法。

### `maibot_sdk_reference`

按主题返回**当前宿主**的开发契约，可选主题：

`overview`（结构 + 加载规则 + 生命周期）、`capabilities`（能力白名单）、`methods`（`ctx.*` 方法 → 能力映射）、`components`（装饰器契约）、`messages`（EventHandler 消息字典）、`config`（配置模型与段名映射）、`pitfalls`（坑清单）、`all`。

### `maibot_plugin_scaffold`

生成一套能通过宿主校验的三件套（`_manifest.json` / `plugin.py` / `config.toml`），默认 `enabled = false`。
支持指定目录：可先在插件目录之外写草稿，确认后再安装。

### `maibot_plugin_validate`

静态校验一个插件目录，返回 `error` / `warning` / `info` 清单：

- `_manifest.json`：必填字段、未知字段、ID 分段规则、严格三段式版本、http(s) URL、SDK/Host 版本区间、依赖类型（只接受 `plugin` / `python_package`）；
- `config.toml`：能否解析、是否有 `[plugin]` 段与 `enabled`、段名与配置类的对应关系；
- `plugin.py`：语法（AST）、`create_plugin()`、是否误写 `__init__`、`self.logger` 误用、消息字典误用、危险调用、复杂度；
- **能力交叉核对**：代码实际调用的能力 vs `capabilities` 声明（用了没声明 = error；声明了没用 = warning）；
- 组件契约：`@WorkflowStep` 已移除、`@Action` 已弃用、`@Command` 缺 `pattern`、EventHandler 拦截契约与 `is_command` 检查；
- 重复插件 ID（宿主发现重复会同时丢弃两个候选）。

### `maibot_plugin_install`

先校验，有 error 直接拒绝安装；通过后复制进 `<maibotRoot>/plugins/<dirName>`，并按参数设置 `[plugin].enabled`（默认保持禁用，交给使用者决定）。

### Skill：`maibot-plugin-writer`

给出完整工作流（查契约 → 看现状 → 生成骨架 → 写实现 → 校验到干净 → 交付）与硬性契约清单。DSH 在收到"给麦麦写插件 / 改插件 / 排查插件加载失败"类请求时会自动加载。

## 安装

```sh
# 1) 从 npm 或插件市场
dsh plugin --profile web add dsh-maibot-plugin-writer

# 2) 从仓库目录（开发/自用）
git clone https://github.com/Lgv-H/dsh-maibot-plugin-writer.git
dsh plugin --profile web add link:/path/to/dsh-maibot-plugin-writer

# 3) 无网络环境（仓库检出用户可用；等价于 2)，不依赖 pnpm 联网）
node scripts/deploy-local.mjs --profile web
```

安装/更新后**需要重启一次该 profile 的服务**。随包 skill 由文件监视器热加载，无需重启即可被新会话看到。

卸载：

```sh
dsh plugin --profile web remove dsh-maibot-plugin-writer
```

## 快速开始

装好并重启后，在 DSH 里直接提需求即可，例如：

> 给麦麦写一个插件：每天早上 8 点在指定群里发一句早安，文案可以在配置里改。

DSH 会按 skill 的流程走：

```
maibot_plugin_catalog            → 确认没有 ID 冲突、看看有没有可参考的插件
maibot_sdk_reference             → 取 components / messages / config / capabilities 契约
maibot_plugin_scaffold           → 生成 author.morning-greeting 三件套
（用文件工具补全 plugin.py 的业务逻辑与 config.toml 字段）
maibot_plugin_validate           → 反复校验到 0 error
maibot_plugin_install            → 复制进 plugins/，保持 enabled = false
```

最后它会把插件 ID、目录、用了哪些能力，以及"如何启用 / 如何验证"告诉你，由你决定是否开启。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖（profile 层优先级高于插件自带的 bundle 层）：

```yaml
- id: dsh-maibot-plugin-writer
  name: dsh-maibot-plugin-writer
  config:
    maibotRoot: 'C:\...\modules\MaiBot'   # MaiBot 源码根（含 src/plugin_runtime 与 plugins/）
    pythonPath: ''                        # 可选：AST 深检用解释器；默认从 MaiBot 同级 python-env/.venv 探测
    dshHome: ''                           # 可选：默认 $DSH_HOME 或 ~/.dsh
    syncSkill: true                       # 是否把随包 skill 投放到 <dshHome>/skills
```

`maibotRoot` 解析顺序（**显式优先，配错即报错**，不会静默换目录）：

1. 工具参数 `maibotRoot`
2. 插件配置 `maibotRoot`
3. 环境变量 `DSH_MAIBOT_ROOT` / `MAIBOT_ROOT`
4. 当前工作目录逐级向上探测
5. 常见安装位置自动发现：`%APPDATA%\MaiBotOneKeyDesktop\*\modules\MaiBot`（一键包）、`~/MaiBot`、`~/maibot`、`~/Documents/MaiBot`、`/opt/MaiBot` 等；命中多个时取最近修改的，并在来源说明里列出全部候选

Python 解释器解析顺序：插件配置 `pythonPath` → MaiBot 同级的 `python-env/`、`.venv/`、`.venv312/` → `PATH`。

## 权限与数据披露

本插件**不联网、不读取凭据、不执行被校验插件的代码**（只做静态解析）。

| 类别 | 具体行为 |
|---|---|
| 网络 | 无 |
| 读取 | `<maibotRoot>/src/plugin_runtime/**`（能力注册表）、`<maibotRoot>/plugins/**`（已有插件）、`<site-packages>/maibot_sdk/**`（方法表） |
| 写入 | `maibot_plugin_scaffold` 的目标目录（默认 `<maibotRoot>/plugins/<id>`）；`maibot_plugin_install` 的目标目录与 `[plugin].enabled`；`<dshHome>/skills/maibot-plugin-writer` |
| 子进程 | 校验时用本地 Python 跑 `lib/ast_probe.py`（只解析文件、输出 JSON） |
| 凭据 | 不涉及 |

更多细节见 [SECURITY.md](SECURITY.md)。

## 兼容性

| 组件 | 要求 | 实测环境 |
|---|---|---|
| DSH | 带 `ctx.tools` 的 web profile | 0.1.7-rc.2 桌面客户端 + web profile，`@deepseek-ai/dsh-tools` 0.1.2-rc.1 |
| Node.js | ≥ 20 | 22.20.0 |
| MaiBot | 1.x（宿主 `_manifest.json` v2 + `plugin_runtime`） | 一键包安装，`plugins/` 内 60+ 插件共存 |
| MaiBot Plugin SDK | 2.x | 2.8.2 |
| Python（可选） | 用于 AST 深检；缺失时降级为文本级检查并在结果中注明 | 一键包自带 `python-env`（3.12） |

平台：Windows 已实测；路径探测同时覆盖 macOS / Linux 的常见位置，但这两者未实测。

## 测试与验证

```sh
npm test              # 33 项单元测试（零依赖：不需要 npm install，也不需要 MaiBot）
npm run test:smoke    # 24 项冒烟测试（自动定位 MaiBot；找不到会全部标 SKIP 而不是假装通过）
npm run test:repo     # 在仓库目录里跑冒烟测试（用 test/hooks.mjs 解析 DSH 的包）
npm run pack:check    # 检查发布产物清单
```

最近一次全量结果：

| 检查 | 结果 |
|---|---|
| `npm test` | 33/33 通过 |
| 冒烟测试（真实宿主） | 24/24 通过，含"用真实 MaiBot 校验参考插件并抓出已知缺陷" |
| `npm pack --dry-run` | 18 个文件 / 47.7 kB（`lib/` + `skills/` + `cordis.patch.yml` + 中英 README / CHANGELOG / LICENSE） |
| 部署副本自检 | 33/33 单元 + 24/24 冒烟，MaiBot 根目录自动发现成功 |

CI（GitHub Actions）在 Node 20 与 22 上跑 `npm test` + `node --check` + `npm pack --dry-run`。

## 已知限制

- **只做静态校验**：不启动 MaiBot、不验证运行时行为；能力是否真被授权仍由宿主在运行时决定。
- **不判断业务逻辑**：它保证"符合宿主契约、能力声明一致、语法与结构正确"，不保证功能设计正确。
- **AST 深检依赖 Python**：找不到解释器时只做文本级检查，结果里会明确写出 `未做 AST 深检：<原因>`。
- **写 `plugins/` 会触发宿主重载**：写入 `.py` 会命中 MaiBot 的文件监视器并重启插件运行时，属预期现象。
- **不联网**：不会去拉最新 SDK 文档，一切以本机宿主为准——这也是它不会给出过期答案的原因。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 重启后仍看不到 `maibot_*` 工具 | 确认插件的 bundle 层已加入 profile（`--dump-config` 里能看到该条目）；确认服务真的重启过 |
| 调用工具报"无法确定 MaiBot 根目录" | 显式传 `maibotRoot`，或设置 `DSH_MAIBOT_ROOT`，或在插件配置里写死路径 |
| 结果里出现"未做 AST 深检" | 指定 `pythonPath`，或让 MaiBot 同级存在 `python-env/`、`.venv/` |
| 校验报"重复插件 ID" | 宿主遇到重复 ID 会同时丢弃两个候选，先改掉其中一个 ID 或删除旧目录 |
| 安装成功但插件不生效 | 生成的插件默认 `enabled = false`；改成 `true` 后宿主会自行重载 |
| 市场里安装 / 更新失败 | 本插件与网络无关；如果本机 pnpm 访问不到 registry，用 `scripts/deploy-local.mjs` 离线部署 |

## 开发

```sh
git clone https://github.com/Lgv-H/dsh-maibot-plugin-writer.git
cd dsh-maibot-plugin-writer
npm test
```

目录结构：

```
lib/
  index.js        cordis 入口：注册 5 个工具、投放 skill
  validate.js     校验规则引擎（对齐宿主 manifest_validator / event_dispatcher / authorization）
  host.js         宿主探测：能力注册表、SDK 方法表、插件扫描、ctx 成员
  reference.js    maibot_sdk_reference 的文本生成
  templates.js    脚手架模板
  install.js      安装（复制进 plugins/ + 设置 enabled）
  toml.js         插件 config.toml 读写子集
  python.js       AST 探针调用
  paths.js        MaiBot 根 / Python 解释器 / DSH home 解析
  skill.js        随包 skill 投放
  ast_probe.py    Python AST 探针（语法、导入、调用链、类结构、open 模式）
skills/maibot-plugin-writer/SKILL.md
scripts/deploy-local.mjs   离线本地部署（不依赖 pnpm 联网）
test/unit.mjs | test/smoke.mjs | test/hooks.mjs
```

改完代码后本地生效：

```sh
node scripts/deploy-local.mjs --profile web --force   # 同步到 profile 并重建链接
# 然后重启该 profile 的服务
```

> 注意：运行时副本必须位于 `<profile>/plugins/` 内。Node 按**真实路径**解析裸包名（`@deepseek-ai/dsh-tools`），把该目录做成指向别处的链接会导致插件加载失败。

## 发布

```sh
npm pack --dry-run          # 确认产物清单（files 白名单）
npm publish --access public

git push -u origin main
```

建议给仓库打 `dsh-plugin` 主题标签，便于生态检索。

## AI 编写声明

**这个仓库的全部内容由 AI 编写与维护**，包括 `lib/`、`test/`、`scripts/`、`skills/`、[SECURITY.md](SECURITY.md)、[CHANGELOG.md](CHANGELOG.md) 以及你正在读的这份 README。

- **谁写的**：DeepSeek Harness（DSH）的编码 agent，在人类用户的需求与评审驱动下完成。
- **依据什么写的**：不是凭记忆，而是逐条对照运行中的宿主实现——`src/plugin_runtime/runner/manifest_validator.py`（manifest 规则）、`capabilities/registry.py`（能力白名单）、`host/authorization.py`（授权模型）、`host/event_dispatcher.py` 与 `host/message_utils.py`（事件与消息字典），以及已安装的 `maibot_sdk`（组件装饰器、`ctx` 方法表）。
- **验证到什么程度**：33 项零依赖单元测试 + 24 项真实宿主冒烟测试全部通过；校验器的有效性用真实插件反向验证过（能抓出 `message.get("plain_text")` 误用、`{"blocked": True}` 缺 `intercept_message=True` 等已知缺陷）。命令与结果见上文[测试与验证](#测试与验证)。
- **人类需要做什么**：AI 写的代码仍然需要人类把关——评审实现意图、在自己环境里跑一次、确认权限面可接受，再决定发布与启用。工具产出同样如此：本插件生成 / 安装的麦麦插件默认保持 `enabled = false`，就是为了把"是否启用"留给人类。
- **已知的 AI 局限**：可能写出"能通过校验但设计不佳"的代码；可能对未实测平台（macOS / Linux）做出过于乐观的假设；文档与实现可能在某些细节上不同步——发现不一致请以代码与测试为准，并欢迎提 issue。

如果你不接受 AI 编写 / 维护的代码，请不要使用本插件。

## 免责声明

本插件按"现状"提供，不附带任何明示或暗示的担保。它会读写会话工作区之外的路径（MaiBot 的 `plugins/` 目录、`<dshHome>/skills`），并会启动本地 Python 子进程做静态解析。使用前请阅读 [SECURITY.md](SECURITY.md) 了解完整权限面；由本插件生成并被你启用的麦麦插件，其行为与风险由生成内容与你的启用决定。

## 许可证

[MIT](LICENSE) © 2026 Lgv-H
