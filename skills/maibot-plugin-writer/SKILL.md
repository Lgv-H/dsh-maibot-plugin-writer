---
name: maibot-plugin-writer
description: 给麦麦（MaiBot）写插件、改插件、排查插件加载问题时用。先用 maibot_sdk_reference 拿到当前宿主的真实 SDK 契约，再用 maibot_plugin_validate 把代码校验到 0 error 才交付。
whenToUse: 用户要求"给麦麦/麦麦bot/MaiBot 写一个插件""帮我把这个功能做成插件""改一下某个 MaiBot 插件""插件加载失败/不生效，帮我看看"，或需要在 MaiBot 仓库里新增 plugins/<id>/ 三件套时。
---

# 麦麦（MaiBot）插件写作

DSH 已经能读写文件和跑命令，本 skill 提供的是**麦麦插件的真实契约**与**校验闭环**，
因为 MaiBot 的 SDK、manifest 规则、事件语义都比较细，凭记忆写十有八九会踩坑。

## 何时用

- 要新建一个 MaiBot 插件（`plugins/<目录>/_manifest.json` + `plugin.py` + `config.toml`）；
- 要修改/修复已有 MaiBot 插件的功能或加载失败；
- 要确认某个 `ctx.xxx` 调用、能力声明、EventHandler 写法在当前宿主版本里是否成立。

## 工作流（按顺序，不要跳）

1. **定位宿主**：确认 MaiBot 源码根目录（含 `src/plugin_runtime/` 与 `plugins/`）。
   工具默认从插件配置 / `DSH_MAIBOT_ROOT` / 当前工作目录向上探测；找不到时在调用里显式传 `maibotRoot`。

2. **读契约**（必做，别凭记忆）：
   - `maibot_sdk_reference(topic="overview")`：结构、加载规则、生命周期；
   - `maibot_sdk_reference(topic="components")`：装饰器与返回值契约；
   - `maibot_sdk_reference(topic="messages")`：EventHandler 收到的消息字典键；
   - `maibot_sdk_reference(topic="config")`：配置类与 `config.toml` 段名映射；
   - `maibot_sdk_reference(topic="capabilities")` / `topic="methods"`：能力白名单与 `ctx.*` 方法表；
   - `maibot_sdk_reference(topic="pitfalls")`：已知坑清单。

3. **看现状**：`maibot_plugin_catalog` —— 避免插件 ID 冲突、参考已有插件的组件用法。

4. **生成骨架**：`maibot_plugin_scaffold(pluginId="author.plugin-name", name=..., description=...)`。
   想先在插件目录外写草稿时传 `dir`；确认好再 `maibot_plugin_install` 装进 `plugins/`。

5. **写实现**：用 `write`/`edit` 工具改 `plugin.py`（必要时加子模块与 `config.toml` 字段）。
   保持 `[plugin].enabled = false`，让用户自己开启。

6. **校验到干净**：`maibot_plugin_validate(dir=...)`，逐条修 error，warning 也要看。
   `maibot_plugin_install` 内部会再校验一次，有 error 会拒绝安装。
   能跑 Python 时校验器会用 AST 深检（语法、导入、调用链、类结构）；报告里会写明用的是哪个解释器。

7. **交付**：告诉用户插件目录、插件 ID、能力声明，以及启用方式（改 `[plugin].enabled = true` 或 WebUI 里启用）。
   **不要**替用户启用，也不要重启 MaiBot——宿主的文件监视器会自己重载插件运行时。

## 硬性契约（写代码时必须遵守）

- 三件套齐备：`_manifest.json`、`plugin.py`、`config.toml`；`plugin.py` 必须有模块级 `create_plugin()`。
- `_manifest.json` 是额外字段禁止（extra=forbid）的强类型模型：
  `manifest_version: 2`；`version` 严格 `x.y.z`；`id` 形如 `author.plugin-name`；
  `author.url` 与 `urls.repository` 必须是 http(s) URL；`capabilities` 只能是宿主注册过的能力名；
  依赖的 `type` 只能是 `plugin`（带 `id`）或 `python_package`（带 `name`），都要 `version_spec`。
- `config.toml` 必须有 `[plugin]` 段且写明 `enabled`：**没有 `[plugin]` 段宿主会视为已启用**。
- 能力要"用多少声明多少"：代码里 `ctx.<组>.<方法>` 对应的能力必须出现在 `capabilities` 里，否则运行时被授权层拒绝。
- 插件类不要定义 `__init__`，初始化放 `on_load()`；日志用 `self.ctx.logger`。
- `@EventHandler` 想拦截消息必须 `intercept_message=True`；ON_MESSAGE 只有 `message` 参数，
  文本取 `message["processed_plain_text"]`，聊天流取 `message["session_id"]`，命令消息先看 `message["is_command"]`。
- 只能用 `maibot_sdk`，禁止 `from src...`；`@Action` 已弃用，`@WorkflowStep` 在 SDK 2.0 已移除。
- 插件目录必须是 `plugins/` 的直接子目录（宿主只扫一层）。

## 完成判据

- `maibot_plugin_validate` 返回 `ok: true`（0 error）；
- 插件目录在 `plugins/` 下、`enabled = false`、能力声明与代码一致；
- 交付说明里写清楚：插件 ID、目录、用了哪些能力、用户如何启用、如何验证效果。
