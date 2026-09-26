/**
 * SDK 参考文本：把「宿主当前真实存在的约定」写给模型看。
 *
 * 与 Maibot 官方文档/SDK 注释一致的静态部分在此硬编码，
 * 能力清单与方法表则实时来自宿主 registry.py 与 maibot_sdk，
 * 所以换 MaiBot 版本后不会给出过期答案。
 */

/** 支持的主题。 */
export const REFERENCE_TOPICS = ['overview', 'capabilities', 'methods', 'components', 'messages', 'config', 'pitfalls', 'all']

/**
 * 生成参考文本。
 *
 * @param {string} topic 主题。
 * @param {object} host 宿主事实（capabilities/sdkMethods/byGroup/sdkVersion/source/ctxMembers）。
 * @param {{ root: string, source: string }} maibot 宿主根目录信息。
 * @returns {string} Markdown 文本。
 */
export function buildReference(topic, host, maibot) {
  const normalized = REFERENCE_TOPICS.includes(topic) ? topic : 'overview'
  if (normalized === 'all') {
    return [
      sectionOverview(host, maibot),
      sectionCapabilities(host),
      sectionMethods(host),
      sectionComponents(),
      sectionMessages(),
      sectionConfig(),
      sectionPitfalls(),
    ].join('\n\n---\n\n')
  }

  switch (normalized) {
    case 'capabilities': return sectionCapabilities(host)
    case 'methods': return sectionMethods(host)
    case 'components': return sectionComponents()
    case 'messages': return sectionMessages()
    case 'config': return sectionConfig()
    case 'pitfalls': return sectionPitfalls()
    default: return sectionOverview(host, maibot)
  }
}

/**
 * 主题：总览与加载规则。
 *
 * @param {object} host 宿主事实。
 * @param {{ root: string, source: string }} maibot 宿主根目录信息。
 * @returns {string} 文本。
 */
function sectionOverview(host, maibot) {
  return `# MaiBot 插件总览（由 dsh-maibot-plugin-writer 生成）

MaiBot 根目录：${maibot.root}（来源：${maibot.source}）
maibot_sdk 版本：${host.sdkVersion || '未知'}

## 三件套

\`\`\`
plugins/<插件目录>/
├── _manifest.json   # 强类型校验，extra="forbid"，多一个字段都会被拒
├── plugin.py        # 必须模块级定义 create_plugin()
└── config.toml      # 必须有 [plugin] 段与 enabled；缺了会被当成"已启用"
\`\`\`

## 宿主加载规则（照做，否则插件不会被加载）

1. 插件目录必须是 \`plugins/\` 的**直接子目录**，宿主只扫一层。
2. 插件 ID 取自 \`_manifest.json\` 的 \`id\`，与目录名无关；ID 重复时宿主会**同时丢弃**两个候选。
3. 只有 \`config.toml\` 里 \`[plugin].enabled = true\` 才会被激活；没有 \`[plugin]\` 段视为启用。
4. \`manifest.capabilities\` 是宿主授权层的白名单：**没声明的能力调用一定失败**，声明了不存在的能力则 manifest 校验失败。
5. 插件目录里任何 \`.py\` 文件变更都会触发宿主重启插件运行时；改完插件不必手动重启 MaiBot，但要等它重载完。
6. 插件只能通过 \`maibot_sdk\` 访问主程序，禁止 \`import src.*\`。

## 生命周期

\`\`\`python
class MyPlugin(MaiBotPlugin):
    config_model = MyPluginConfig          # 必填，WebUI 靠它渲染配置

    async def on_load(self) -> None: ...    # 不要写 __init__，初始化放这里
    async def on_unload(self) -> None: ...  # 取消任务/关连接
    async def on_config_update(self, scope: str, config_data: dict[str, object], version: str) -> None: ...

def create_plugin() -> MyPlugin:            # 宿主实例化入口
    return MyPlugin()
\`\`\`

## 推荐工作流

1. \`maibot_plugin_catalog\` 看现有插件与命名冲突；
2. \`maibot_sdk_reference topic=components|messages|config\` 拿到契约细节；
3. \`maibot_plugin_scaffold\` 生成骨架（或直接把代码写进 \`plugins/<目录>/\`）；
4. \`maibot_plugin_validate\` 反复校验到 0 error；
5. 交给用户启用：把 \`[plugin].enabled\` 改成 \`true\`（宿主会自行重载）。`
}

/**
 * 主题：能力白名单。
 *
 * @param {object} host 宿主事实。
 * @returns {string} 文本。
 */
function sectionCapabilities(host) {
  const byPrefix = new Map()
  for (const capability of host.capabilities) {
    const prefix = capability.split('.')[0]
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, [])
    byPrefix.get(prefix).push(capability)
  }

  // 列出完整能力名（不是去掉前缀的短名），避免模型写出 "text" 这种无法声明的名字
  const lines = [...byPrefix.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([prefix, list]) => `- **${prefix}.** ${list.join(', ')}`)

  return `# 宿主能力白名单（共 ${host.capabilities.length} 项）

来源：${host.source}

${lines.join('\n')}

> \`manifest.capabilities\` 只能写这里的名字；写了列表外的名字，宿主的 manifest 校验直接失败。
> 代码里用了但没声明，运行时会被授权层拒绝（\`未获授权能力\`）。`
}

/**
 * 主题：ctx 方法 → 能力映射。
 *
 * @param {object} host 宿主事实。
 * @returns {string} 文本。
 */
function sectionMethods(host) {
  if (!host.sdkMethods.size) {
    return '# ctx 方法表\n\n未定位到 maibot_sdk 的 capabilities 目录，无法生成方法表；请在插件配置里指定 pythonPath 或检查 MaiBot 安装。'
  }

  const lines = []
  for (const [group, methods] of [...host.byGroup.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const rendered = methods.map((method) => `\`ctx.${group}.${method}\``).join('、')
    const capabilities = [...new Set(methods.map((method) => host.sdkMethods.get(`${group}.${method}`)))].join(', ')
    lines.push(`- ${rendered}\n  - 能力声明：${capabilities}`)
  }

  return `# ctx 能力代理方法表（来自已安装的 maibot_sdk ${host.sdkVersion || ''}）

${lines.join('\n')}

> 表外的方法名（例如 \`ctx.frequency.check\`、\`ctx.person.get\`、\`ctx.render.render\`）在当前 SDK 中不存在，
> 调用会直接 AttributeError 或被授权层拒绝。`
}

/**
 * 主题：组件契约。
 *
 * @returns {string} 文本。
 */
function sectionComponents() {
  return `# 组件（装饰器）契约

| 装饰器 | 必填参数 | 说明 |
|---|---|---|
| \`@Command(name, description="", pattern="", aliases=None)\` | name + pattern | \`pattern\` 是正则；空 pattern 不会匹配任何输入 |
| \`@Tool(name, description="", parameters=None)\` | name | 供 LLM 调用；返回 \`{"name": ..., "content": ...}\` |
| \`@EventHandler(name, description="", event_type=EventType.ON_MESSAGE, intercept_message=False, weight=0)\` | name | 见下方两条硬规则 |
| \`@HookHandler(hook, *, name="", mode=..., order=..., error_policy=...)\` | hook | 命名 Hook |
| \`@MessageGateway(route_type, *, platform="", protocol="", account_id="", scope="")\` | route_type | send/receive/duplex |
| \`@HomeCard(name, title, content="")\` | name + title | WebUI 首页卡片 |
| \`@API(name, description="", version="1", public=False)\` | name | 暴露给其它插件的 API |
| \`@LLMProvider(client_type, *, name="", version="1.0.0")\` | client_type | 自定义 LLM 提供方 |

> \`@Action\` 是旧装饰器别名，新插件不要用；\`@WorkflowStep\` 在 SDK 2.0 已移除（直接抛错），要改用 \`@HookHandler\`。

## EventHandler 两条硬规则

1. \`intercept_message\` 默认 False = fire-and-forget，宿主**不会**读取它的返回值。
   要拦截消息（返回 \`{"blocked": True}\`）必须写 \`intercept_message=True\`。
2. ON_MESSAGE 事件的参数只有 \`event_type\` 与 \`message\`：
   - **拿不到 \`stream_id\`**：要从 \`message["session_id"]\` 取；
   - 文本用 \`message["processed_plain_text"]\`（\`plain_text\` 键不存在，\`raw_message\` 是消息段列表）；
   - 需要放行命令消息时先判断 \`message["is_command"]\`。

\`\`\`python
@EventHandler("guard", description="拦截空消息", event_type=EventType.ON_MESSAGE, intercept_message=True)
async def handle_guard(self, message: dict | None = None, **kwargs: object):
    del kwargs
    if not message or message.get("is_command"):
        return {"continue_processing": True}
    if not (message.get("processed_plain_text") or "").strip():
        return {"blocked": True}
    return {"continue_processing": True}
\`\`\``
}

/**
 * 主题：消息字典。
 *
 * @returns {string} 文本。
 */
function sectionMessages() {
  return `# EventHandler 收到的 message 字典

| 键 | 类型 | 说明 |
|---|---|---|
| \`message_id\` / \`timestamp\` / \`platform\` | str | 基础信息 |
| \`message_info.user_info\` | dict | \`user_id\` / \`user_nickname\` / \`user_cardname\` |
| \`message_info.group_info\` | dict 或 None | \`group_id\` / \`group_name\`，私聊为 None |
| \`processed_plain_text\` | str 或 None | **纯文本正文用这个** |
| \`raw_message\` | list[dict] | 消息段列表（\`{"type": "text", "data": ...}\`），不是字符串 |
| \`is_command\` / \`is_at\` / \`is_mentioned\` / \`is_picture\` / \`is_emoji\` / \`is_notify\` | bool | 标志位 |
| \`session_id\` | str | 聊天流 ID（发消息时当 stream_id 用） |
| \`reply_to\` | str 或 None | 引用消息 ID |

官方示例里的 \`message.get("plain_text")\` 在这个宿主版本里取不到值，属于过期写法。`
}

/**
 * 主题：配置模型。
 *
 * @returns {string} 文本。
 */
function sectionConfig() {
  return `# 配置模型与 config.toml

\`\`\`python
class PluginSectionConfig(PluginConfigBase):
    __ui_label__ = "插件"        # 每个子配置类都要有 label/icon/order
    __ui_icon__ = "package"
    __ui_order__ = 0
    enabled: bool = Field(default=False, description="是否启用插件")
    config_version: str = Field(default="0.1.0", description="配置版本")

class GreetingConfig(PluginConfigBase):
    __ui_label__ = "问候"
    __ui_icon__ = "message-circle"
    __ui_order__ = 1
    reply: str = Field(default="你好！", description="回复内容")

class MyPluginConfig(PluginConfigBase):     # 顶层聚合类，供 config_model 引用
    plugin: PluginSectionConfig = Field(default_factory=PluginSectionConfig)
    greeting: GreetingConfig = Field(default_factory=GreetingConfig)
\`\`\`

对应 config.toml：

\`\`\`toml
[plugin]
enabled = false
config_version = "0.1.0"

[greeting]
reply = "你好！"
\`\`\`

规则：
- 段名 = 聚合类里的**字段名**（\`greeting\` → \`[greeting]\`）；\`plugin\` 段固定叫 \`[plugin]\`；
- \`config.toml\` 里的键要和字段名一致，值类型要和类型注解一致；
- 所有 Field 都写 \`description\`（简体中文），WebUI 直接展示；
- 宿主热重载会重写 \`config.toml\`，不要在文件里放需要保留的自定义注释；
- 用户改配置后宿主调用 \`on_config_update(scope, config_data, version)\`。`
}

/**
 * 主题：易错点清单。
 *
 * @returns {string} 文本。
 */
function sectionPitfalls() {
  return `# 常见坑（都踩过）

1. \`message.get("plain_text")\` → 键不存在；用 \`processed_plain_text\`。
2. EventHandler 想拦截却没写 \`intercept_message=True\` → 返回值被丢弃，消息照常继续处理。
3. 用了 \`ctx.frequency.check\` / \`ctx.person.get\` / \`ctx.render.render\` 之类**不存在**的方法 → AttributeError；以 \`ctx 能力代理方法表\` 为准。
4. 代码用了某能力但 manifest 没声明 → 运行时 \`未获授权能力\`；反过来声明了没用到的能力会留下多余权限。
5. \`_manifest.json\` 多写字段（宿主 extra="forbid"）、id 不符合分段规则、\`author.url\`/\`urls.repository\` 不是 http(s) URL、版本号不是 \`x.y.z\` → 直接加载失败。
6. \`dependencies\` 的 \`type\` 只能是 \`plugin\` 或 \`python_package\`（不是 pip/adapter），并且都要带 \`version_spec\`。
7. 插件类写了 \`__init__\` → 宿主初始化流程会绕过它；把初始化放 \`on_load()\`。
8. 用 \`self.logger\` → 不存在；用 \`self.ctx.logger\`。
9. \`from src.xxx import ...\` → 明确禁止，只能用 \`maibot_sdk\`。
10. 后台任务/定时器要在 \`on_unload()\` 里取消，否则热重载会泄漏。
11. 生成/新写的插件请保持 \`enabled = false\`，让用户显式启用。
12. 目录写在 \`plugins/\` 之外宿主扫不到；只扫一层，别嵌套成 \`plugins/generated/<id>\`。`
}
