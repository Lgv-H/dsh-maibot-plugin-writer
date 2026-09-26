/**
 * 脚手架：生成符合当前宿主 manifest 校验规则的插件三件套。
 *
 * 生成内容的每条规则都对齐 MaiBot 的 `src/plugin_runtime/runner/manifest_validator.py`
 * 与 `maibot_sdk` 实际契约（严格三段式版本、http(s) URL 必填、id 分段规则、
 * 配置段名 = 类名去 Config 转 snake_case、宿主只激活 [plugin].enabled = true 的插件）。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveUserPath } from './paths.js'

/** 与宿主一致的插件 ID 规则。 */
export const PLUGIN_ID_PATTERN = /^[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)+$/

/**
 * 生成插件三件套内容（纯函数，便于测试与预览）。
 *
 * @param {object} options 生成参数。
 * @param {string} options.pluginId 插件 ID（author.name）。
 * @param {string} [options.name] 展示名。
 * @param {string} [options.description] 描述。
 * @param {string} [options.author] 作者名。
 * @param {string} [options.authorUrl] 作者主页（必须是 http(s) URL）。
 * @param {string} [options.repositoryUrl] 仓库地址（必须是 http(s) URL）。
 * @param {string} [options.command] 示例命令名（不含斜杠）。
 * @param {string} [options.version] 版本号。
 * @returns {{ files: Record<string, string>, dirName: string, pluginClass: string, featureSection: string }} 生成结果。
 */
export function buildPluginFiles(options) {
  const pluginId = String(options.pluginId ?? '').trim()
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new Error(
      `插件 ID 不合法：${pluginId || '(空)'}；宿主要求形如 author.plugin-name，`
        + '分段只含字母/数字/下划线，用点号或横线分隔，例如 dsh.hello-world',
    )
  }

  const [authorPart, ...rest] = pluginId.split(/[.-]/)
  const namePart = rest.join('-')
  const pluginClass = pascal(`${pluginId.split(/[.-]/).slice(-1)[0]}`)
  const featureSection = 'reply'
  const command = normalizeCommand(options.command) || 'hello'
  const version = String(options.version ?? '0.1.0').trim() || '0.1.0'
  const displayName = String(options.name ?? '').trim() || pluginClass
  const description = String(options.description ?? '').trim() || `${displayName}（由 DSH 生成）`
  const authorName = String(options.author ?? '').trim() || authorPart
  const authorUrl = String(options.authorUrl ?? '').trim() || `https://github.com/${authorPart}`
  const repositoryUrl = String(options.repositoryUrl ?? '').trim()
    || `https://github.com/${authorPart}/${namePart || 'maibot-plugin'}`

  const manifest = {
    manifest_version: 2,
    id: pluginId,
    version,
    name: displayName,
    description,
    author: { name: authorName, url: authorUrl },
    license: 'MIT',
    urls: {
      repository: repositoryUrl,
      homepage: repositoryUrl,
      documentation: repositoryUrl,
      issues: `${repositoryUrl}/issues`,
    },
    host_application: { min_version: '1.0.0', max_version: '1.99.99' },
    sdk: { min_version: '2.0.0', max_version: '2.99.99' },
    dependencies: [],
    capabilities: ['send.text'],
    i18n: { default_locale: 'zh-CN', supported_locales: ['zh-CN'] },
  }

  const pluginPy = `"""${description}

由 DSH（DeepSeek Harness）插件 dsh-maibot-plugin-writer 生成。
"""

from __future__ import annotations

from typing import Any

from maibot_sdk import Command, Field, MaiBotPlugin, PluginConfigBase


class PluginSectionConfig(PluginConfigBase):
    """[plugin] 段：插件总开关与配置版本。"""

    __ui_label__ = "插件"
    __ui_icon__ = "package"
    __ui_order__ = 0

    enabled: bool = Field(default=False, description="是否启用插件")
    config_version: str = Field(default="${version}", description="配置版本")


class ${pascal(featureSection)}Config(PluginConfigBase):
    """[${featureSection}] 段：业务配置。"""

    __ui_label__ = "功能"
    __ui_icon__ = "message-circle"
    __ui_order__ = 1

    reply: str = Field(default="你好！", description="命令回复内容")


class ${pluginClass}Config(PluginConfigBase):
    """顶层配置：聚合所有子配置段。"""

    plugin: PluginSectionConfig = Field(default_factory=PluginSectionConfig)
    ${featureSection}: ${pascal(featureSection)}Config = Field(default_factory=${pascal(featureSection)}Config)


class ${pluginClass}(MaiBotPlugin):
    """插件主体。"""

    config_model = ${pluginClass}Config

    async def on_load(self) -> None:
        """插件加载时初始化资源。"""
        self.ctx.logger.info("${pluginId} 已加载")

    async def on_unload(self) -> None:
        """插件卸载时释放资源。"""

    async def on_config_update(self, scope: str, config_data: dict[str, object], version: str) -> None:
        """配置热重载回调。"""
        del scope, config_data, version

    @Command("${command}", description="回复一条配置好的文本", pattern=r"^/${command}$")
    async def handle_${command.replace(/-/g, '_')}(self, stream_id: str = "", **kwargs: Any):
        """处理 /${command} 命令。"""
        del kwargs

        if not self.config.plugin.enabled:
            return False, "插件未启用，请在 config.toml 中将 plugin.enabled 设为 true", True

        await self.ctx.send.text(self.config.${featureSection}.reply, stream_id)
        return True, "已回复", True


def create_plugin() -> ${pluginClass}:
    """宿主加载入口。"""
    return ${pluginClass}()
`

  const configToml = `[plugin]
# 宿主只激活 enabled = true 的插件；新插件默认关闭，确认无误后再手动开启。
enabled = false
config_version = "${version}"

[${featureSection}]
reply = "你好！"
`

  return {
    files: {
      '_manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
      'plugin.py': pluginPy,
      'config.toml': configToml,
    },
    dirName: pluginId.replace(/\./g, '_'),
    pluginClass,
    featureSection,
  }
}

/**
 * 把脚手架写到磁盘。
 *
 * @param {object} options 生成参数 + 落盘参数。
 * @param {string} options.maibotRoot MaiBot 根目录。
 * @param {string} [options.dir] 目标目录；省略时落到 <maibotRoot>/plugins/<dirName>。
 * @param {boolean} [options.enable] 是否直接写成 enabled = true（默认 false）。
 * @param {boolean} [options.overwrite] 目标已存在时是否覆盖。
 * @returns {{ dir: string, dirName: string, pluginId: string, pluginClass: string, files: string[], enabled: boolean }} 落盘结果。
 */
export function scaffoldPlugin(options) {
  const built = buildPluginFiles(options)
  const dir = options.dir
    ? resolveUserPath(options.dir)
    : join(options.maibotRoot, 'plugins', built.dirName)

  if (existsSync(dir) && !options.overwrite) {
    throw new Error(`目标目录已存在：${dir}；如需覆盖请传 overwrite: true`)
  }

  const files = { ...built.files }
  if (options.enable) {
    files['config.toml'] = files['config.toml'].replace('enabled = false', 'enabled = true')
  }

  mkdirSync(dir, { recursive: true })
  for (const [fileName, content] of Object.entries(files)) {
    writeFileSync(join(dir, fileName), content, 'utf8')
  }

  return {
    dir,
    dirName: built.dirName,
    pluginId: String(options.pluginId),
    pluginClass: built.pluginClass,
    files: Object.keys(files),
    enabled: Boolean(options.enable),
  }
}

/**
 * 把 `hello-world` 这类文本规范成可做命令名的形式。
 *
 * 去掉开头的斜杠、把非法字符折叠成一个 `-`、去掉首尾多余的 `-`；
 * 结果为空时由调用方回落到默认命令名。
 *
 * @param {string} raw 原始命令名。
 * @returns {string} 规范化命令名；为空时返回空串。
 */
function normalizeCommand(raw) {
  const value = String(raw ?? '').trim().replace(/^\//, '')
  if (!value) return ''
  return value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
}

/**
 * 转为 PascalCase。
 *
 * @param {string} text 原始文本。
 * @returns {string} PascalCase 结果。
 */
function pascal(text) {
  const words = String(text ?? '').split(/[^A-Za-z0-9]+/).filter(Boolean)
  if (words.length === 0) return 'My'
  return words.map((word) => word[0].toUpperCase() + word.slice(1)).join('')
}
