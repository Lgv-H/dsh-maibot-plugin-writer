/**
 * dsh-maibot-plugin-writer：让 DSH 自己写麦麦（MaiBot）插件的工具插件。
 *
 * 注册 5 个模型可见工具：
 *   maibot_plugin_catalog    看现有插件与宿主能力
 *   maibot_sdk_reference     取当前宿主版本的插件开发契约
 *   maibot_plugin_scaffold   生成合规三件套骨架
 *   maibot_plugin_validate   静态校验（manifest/config/plugin.py + 能力交叉核对 + AST 深检）
 *   maibot_plugin_install    校验通过后复制进 plugins/ 并设置启用开关
 *
 * 加载时还会把自己携带的 skill（maibot-plugin-writer）投放到 DSH 的 skills 目录。
 */

import { existsSync } from 'node:fs'

import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { loadCapabilities, loadCtxMembers, loadSdkMethods, loadSdkVersion, scanPlugins } from './host.js'
import { installPlugin, summarizeDir } from './install.js'
import { resolveMaibotRoot, resolvePython, resolvePythonEnv, resolveUserPath } from './paths.js'
import { buildReference, REFERENCE_TOPICS } from './reference.js'
import { SKILL_NAME, syncBundledSkill } from './skill.js'
import { scaffoldPlugin } from './templates.js'
import { validatePlugin } from './validate.js'

/** cordis 插件名。 */
export const name = 'dsh-maibot-plugin-writer'

/** 依赖的工具注册表服务。 */
export const inject = ['tools']

/** 插件配置。 */
export const Config = z.object({
  maibotRoot: z.string().default('').description('MaiBot 源码根目录（含 src/plugin_runtime 与 plugins/）'),
  pythonPath: z.string().default('').description('可选：用于 AST 深检的 Python 解释器路径'),
  dshHome: z.string().default('').description('可选：DSH home，默认取 $DSH_HOME 或 ~/.dsh'),
  syncSkill: z.boolean().default(true).description('是否把随包 skill 投放到 <dshHome>/skills'),
})

/**
 * 注册全部工具并投放 skill。
 *
 * @param {object} ctx cordis 上下文。
 * @param {object} config 插件配置。
 */
export function apply(ctx, config) {
  const settings = config ?? {}

  const skillResult = syncBundledSkill(settings)
  if (skillResult.synced) ctx.logger.info(`[${name}] ${skillResult.message}`)
  else ctx.logger.warn(`[${name}] ${skillResult.message}`)

  for (const options of buildToolOptions(settings)) ctx.tools.register(defineTool(options))

  ctx.logger.info(`[${name}] 已注册 5 个工具（skill: ${SKILL_NAME}）`)
}

/**
 * 构造全部工具的 defineTool 参数（与注册用的是同一份，便于测试直接复核 schema）。
 *
 * @param {object} settings 插件配置。
 * @returns {Array<object>} defineTool 参数列表。
 */
export function buildToolOptions(settings) {
  return [
    catalogTool(settings),
    referenceTool(settings),
    scaffoldTool(settings),
    validateTool(settings),
    installTool(settings),
  ]
}

/**
 * 组装宿主事实（能力表、SDK 方法表、已安装插件）。
 *
 * @param {object} settings 插件配置。
 * @param {string} [explicitRoot] 工具参数里的 maibotRoot。
 * @returns {{ maibot: object, python: object, host: object, pythonEnv: string, installedPlugins: Array<object> }} 上下文。
 */
function buildHost(settings, explicitRoot) {
  const maibot = resolveMaibotRoot(settings, explicitRoot)
  const capabilities = loadCapabilities(maibot.root)
  const python = resolvePython(settings, maibot.root)
  const pythonEnv = resolvePythonEnv(maibot.root, python.path)
  const sdkMethods = loadSdkMethods(pythonEnv)

  return {
    maibot,
    python,
    pythonEnv,
    installedPlugins: scanPlugins(maibot.root),
    host: {
      capabilities: capabilities.capabilities,
      source: capabilities.source,
      sdkMethods: sdkMethods.methods,
      byGroup: sdkMethods.byGroup,
      ctxMembers: loadCtxMembers(pythonEnv),
      sdkVersion: loadSdkVersion(pythonEnv),
      pythonEnv,
    },
  }
}

/**
 * 校验结果的渲染文本。
 *
 * @param {{ findings: Array<object> }} validation 校验结果。
 * @returns {string} 文本。
 */
function renderFindings(validation) {
  const label = { error: '错误', warning: '警告', info: '信息' }
  const lines = []
  for (const severity of ['error', 'warning', 'info']) {
    const items = validation.findings.filter((item) => item.severity === severity)
    if (items.length === 0) continue
    lines.push(`【${label[severity]}】${items.length} 条`)
    for (const item of items) lines.push(`  - [${item.code}] ${item.message}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/**
 * 工具：maibot_plugin_catalog
 *
 * @param {object} settings 插件配置。
 * @returns {object} defineTool 参数。
 */
function catalogTool(settings) {
  return {
    name: 'maibot_plugin_catalog',
    description:
      '列出 MaiBot 已安装的插件（ID/名称/版本/目录/启停/组件/能力）与宿主当前注册的能力名。'
      + '写新插件前先看这里，避免 ID 冲突、复用已有能力名。',
    parameters: {
      maibotRoot: { type: 'string', description: 'MaiBot 源码根目录；省略时用插件配置/自动探测' },
      filter: { type: 'string', description: '只显示 ID/名称/描述中包含该子串的插件' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args) {
      const context = buildHost(settings, args.maibotRoot)
      const filter = String(args.filter ?? '').trim().toLowerCase()
      const plugins = context.installedPlugins.filter((plugin) => {
        if (!filter) return true
        return [plugin.id, plugin.name, plugin.description].some((field) => field.toLowerCase().includes(filter))
      })

      const lines = [
        `MaiBot 根目录：${context.maibot.root}（${context.maibot.source}）`,
        `宿主能力：${context.host.capabilities.length} 项；maibot_sdk：${context.host.sdkVersion || '未知'}`,
        `已安装插件：${plugins.length} 个${filter ? `（按 "${filter}" 过滤）` : ''}`,
        '',
      ]

      for (const plugin of plugins) {
        const state = plugin.enabled === null ? '未声明' : plugin.enabled ? '已启用' : '已禁用'
        lines.push(`- [${plugin.id}] ${plugin.name} v${plugin.version} — ${state}，目录 ${plugin.dirName}，${plugin.lines} 行`)
        if (plugin.components.length) lines.push(`    组件：${plugin.components.join('/')}`)
        if (plugin.capabilities.length) lines.push(`    能力：${plugin.capabilities.join(', ')}`)
        if (plugin.description) lines.push(`    描述：${plugin.description.slice(0, 100)}`)
      }

      if (plugins.length === 0) lines.push('（没有匹配的插件）')
      lines.push('', `能力白名单来源：${context.host.source}`)
      return Promise.resolve(lines.join('\n'))
    },
  }
}

/**
 * 工具：maibot_sdk_reference
 *
 * @param {object} settings 插件配置。
 * @returns {object} defineTool 参数。
 */
function referenceTool(settings) {
  return {
    name: 'maibot_sdk_reference',
    description:
      '返回当前 MaiBot 宿主版本的插件开发契约：插件结构、加载规则、生命周期、能力白名单、'
      + 'ctx 方法表、组件装饰器契约、EventHandler 消息字典、配置模型、常见坑。'
      + '写插件前先读，不要凭记忆写 SDK 调用。',
    parameters: {
      topic: {
        type: 'string',
        enum: [...REFERENCE_TOPICS],
        description: 'overview（默认）| capabilities | methods | components | messages | config | pitfalls | all',
      },
      maibotRoot: { type: 'string', description: 'MaiBot 源码根目录；省略时用插件配置/自动探测' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute(args) {
      const context = buildHost(settings, args.maibotRoot)
      return Promise.resolve(buildReference(String(args.topic ?? 'overview'), context.host, context.maibot))
    },
  }
}

/**
 * 工具：maibot_plugin_scaffold
 *
 * @param {object} settings 插件配置。
 * @returns {object} defineTool 参数。
 */
function scaffoldTool(settings) {
  return {
    name: 'maibot_plugin_scaffold',
    description:
      '生成一套通过宿主 manifest 校验的 MaiBot 插件骨架（_manifest.json / plugin.py / config.toml，默认 enabled = false）。'
      + '再用 write/edit 工具往 plugin.py 里补业务逻辑，最后用 maibot_plugin_validate 校验。',
    parameters: {
      pluginId: { type: 'string', required: true, description: '插件 ID，形如 author.plugin-name（必须含一个点或横线）' },
      name: { type: 'string', description: '插件展示名，默认由 ID 推导' },
      description: { type: 'string', description: '插件描述' },
      author: { type: 'string', description: '作者名，默认取 ID 的第一段' },
      command: { type: 'string', description: '示例命令名（不含斜杠），默认 hello' },
      dir: { type: 'string', description: '目标目录；省略时落到 <maibotRoot>/plugins/<id 点号换下划线>' },
      enable: { type: 'boolean', description: '是否直接写成 enabled = true（默认 false，保持关闭更安全）' },
      overwrite: { type: 'boolean', description: '目标目录已存在时是否覆盖（默认 false）' },
      maibotRoot: { type: 'string', description: 'MaiBot 源码根目录；省略时用插件配置/自动探测' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dir: { type: 'string', required: true },
          pluginId: { type: 'string', required: true },
          pluginClass: { type: 'string', required: true },
          files: { type: 'array', required: true, items: { type: 'string' } },
          enabled: { type: 'boolean', required: true },
          next: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已生成插件骨架：${value.dir}\n文件：${value.files.join(', ')}\n状态：${value.enabled ? '已启用' : '禁用中（enabled = false）'}\n${value.next}`,
      }],
    },
    execute(args) {
      const context = buildHost(settings, args.maibotRoot)
      const result = scaffoldPlugin({
        pluginId: args.pluginId,
        name: args.name,
        description: args.description,
        author: args.author,
        command: args.command,
        dir: args.dir,
        enable: args.enable === true,
        overwrite: args.overwrite === true,
        maibotRoot: context.maibot.root,
      })

      return Promise.resolve({
        dir: result.dir,
        pluginId: result.pluginId,
        pluginClass: result.pluginClass,
        files: result.files,
        enabled: result.enabled,
        next: `下一步：用 write/edit 工具补全 ${result.dir} 下的 plugin.py 业务逻辑，然后调用 maibot_plugin_validate（dir 传该目录）；`
          + '确认 0 error 后让用户在 config.toml 里把 [plugin].enabled 改成 true（宿主会自行重载）。',
      })
    },
  }
}

/**
 * 工具：maibot_plugin_validate
 *
 * @param {object} settings 插件配置。
 * @returns {object} defineTool 参数。
 */
function validateTool(settings) {
  return {
    name: 'maibot_plugin_validate',
    description:
      '静态校验一个 MaiBot 插件目录：manifest 严格规则、config.toml 与配置类对应关系、plugin.py 语法与 SDK 契约、'
      + '能力声明与代码调用交叉核对、组件装饰器契约、重复插件 ID。返回 error/warning/info 清单。',
    parameters: {
      dir: { type: 'string', required: true, description: '插件目录（绝对路径，或相对当前工作目录）' },
      maibotRoot: { type: 'string', description: 'MaiBot 源码根目录；省略时用插件配置/自动探测' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          dir: { type: 'string', required: true },
          pluginId: { type: 'string', required: true },
          errors: { type: 'integer', required: true },
          warnings: { type: 'integer', required: true },
          capabilitiesUsed: { type: 'array', required: true, items: { type: 'string' } },
          findings: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                severity: { type: 'string', required: true, enum: ['error', 'warning', 'info'] },
                code: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.ok ? '✅ 校验通过' : '❌ 校验未通过'}：${value.errors} error / ${value.warnings} warning\n`
          + `插件 ID：${value.pluginId || '(未解析)'}\n`
          + `代码实际使用能力：${value.capabilitiesUsed.length ? value.capabilitiesUsed.join(', ') : '无'}\n\n`
          + renderFindings(value),
      }],
    },
    execute(args) {
      const context = buildHost(settings, args.maibotRoot)
      const dir = resolveUserPath(args.dir)
      const validation = validatePlugin({
        dir,
        host: context.host,
        python: context.python,
        installedPlugins: context.installedPlugins,
      })
      return Promise.resolve({
        ok: validation.ok,
        dir,
        pluginId: validation.meta.pluginId,
        errors: validation.meta.errors,
        warnings: validation.meta.warnings,
        capabilitiesUsed: validation.meta.capabilitiesUsed,
        findings: validation.findings,
      })
    },
  }
}

/**
 * 工具：maibot_plugin_install
 *
 * @param {object} settings 插件配置。
 * @returns {object} defineTool 参数。
 */
function installTool(settings) {
  return {
    name: 'maibot_plugin_install',
    description:
      '把已写好的插件目录复制进 <maibotRoot>/plugins/ 下（先校验，有 error 则拒绝安装），'
      + '并按 enable 参数设置 [plugin].enabled。默认保持禁用，交给用户显式启用。',
    parameters: {
      sourceDir: { type: 'string', required: true, description: '源插件目录（含三件套）' },
      dirName: { type: 'string', description: '目标目录名，默认把插件 ID 的点号换成下划线' },
      overwrite: { type: 'boolean', description: '目标目录已存在时是否覆盖（默认 false）' },
      enable: { type: 'boolean', description: '是否安装后直接启用（默认 false）' },
      maibotRoot: { type: 'string', description: 'MaiBot 源码根目录；省略时用插件配置/自动探测' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          installed: { type: 'boolean', required: true },
          target: { type: 'string', required: true },
          dirName: { type: 'string', required: true },
          enabled: { type: 'boolean', required: true },
          files: { type: 'integer', required: true },
          bytes: { type: 'integer', required: true },
          message: { type: 'string', required: true },
          errors: { type: 'integer', required: true },
          warnings: { type: 'integer', required: true },
          findings: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                severity: { type: 'string', required: true, enum: ['error', 'warning', 'info'] },
                code: { type: 'string', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.installed ? '✅ 已安装' : '⚠️ 未安装'}：${value.target || '(无目标)'}\n`
          + `${value.message}\n`
          + (value.installed ? `文件 ${value.files} 个 / ${value.bytes} 字节，enabled = ${value.enabled}\n` : '')
          + (value.errors || value.warnings ? `\n校验：${value.errors} error / ${value.warnings} warning\n` : '')
          + (value.findings.length ? renderFindings(value) : ''),
      }],
    },
    execute(args) {
      const context = buildHost(settings, args.maibotRoot)
      const sourceDir = resolveUserPath(args.sourceDir)
      const validation = validatePlugin({
        dir: sourceDir,
        host: context.host,
        python: context.python,
        installedPlugins: context.installedPlugins,
      })
      const result = installPlugin({
        sourceDir,
        maibotRoot: context.maibot.root,
        dirName: args.dirName,
        overwrite: args.overwrite === true,
        enable: args.enable === true,
        validation,
      })

      const stats = result.installed && existsSync(result.target)
        ? summarizeDir(result.target)
        : { files: 0, bytes: 0 }

      return Promise.resolve({
        installed: result.installed,
        target: result.target,
        dirName: result.dirName,
        enabled: result.enabled,
        files: stats.files,
        bytes: stats.bytes,
        message: result.message,
        errors: validation.meta.errors,
        warnings: validation.meta.warnings,
        findings: result.findings,
      })
    },
  }
}
