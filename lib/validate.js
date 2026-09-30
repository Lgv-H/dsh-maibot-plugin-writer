/**
 * MaiBot 插件静态校验器。
 *
 * 规则全部对齐运行中的宿主，而不是凭印象：
 *   - manifest：`src/plugin_runtime/runner/manifest_validator.py`（严格三段式版本、
 *     http(s) URL 必填、id 分段规则、extra=forbid、依赖类型只能是 plugin / python_package）
 *   - 能力：`src/plugin_runtime/capabilities/registry.py`（宿主授权层按 manifest 发放令牌，
 *     未声明的能力一定调用失败）
 *   - 组件：`maibot_sdk/components.py`（EventHandler 默认 intercept_message=False，
 *     只有 True 的返回值会被采纳）
 *   - 消息字典：`src/plugin_runtime/host/message_utils.py`（键是 processed_plain_text / session_id，
 *     没有 plain_text）
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { isInsidePlugins } from './install.js'
import { runAstProbe } from './python.js'
import { getValue, listSections, parseToml } from './toml.js'

/** 与宿主一致的插件 ID 规则。 */
const PLUGIN_ID_PATTERN = /^[A-Za-z0-9_]+(?:[.-][A-Za-z0-9_]+)+$/
/** 宿主的 URL 规则：http(s):// 后至少一个字符。 */
const HTTP_URL_PATTERN = /^https?:\/\/.+$/
/** 宿主的版本规则：严格三段式。 */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/

/** manifest 允许的顶层键（宿主 extra="forbid"，多一个都会加载失败）。 */
const KNOWN_MANIFEST_KEYS = new Set([
  'manifest_version', 'version', 'name', 'description', 'author', 'license', 'urls',
  'host_application', 'sdk', 'dependencies', 'llm_providers', 'capabilities', 'i18n',
  'id', 'plugin_type', 'type', 'display', 'changelog',
])

/** 依赖声明支持的类型（宿主 Literal）。 */
const DEPENDENCY_TYPES = new Set(['plugin', 'python_package'])

/** 导入即报错的模块。 */
const IMPORTS_ERROR = new Set([
  'subprocess', 'socket', 'ctypes', 'pickle', 'marshal', 'multiprocessing', 'ftplib', 'smtplib', 'telnetlib',
])
/** 导入需人工确认的模块。 */
const IMPORTS_WARNING = new Set(['os', 'sys', 'shutil', 'importlib', 'http', 'urllib', 'requests', 'httpx', 'aiohttp'])

/** 直接调用即报错的内建函数。 */
const CALLS_ERROR = new Set(['eval', 'exec', 'compile', '__import__'])

/** 组件装饰器（用于扫描与契约检查）。 */
const COMPONENT_NAMES = new Set([
  'Command', 'Tool', 'EventHandler', 'HookHandler', 'MessageGateway', 'HomeCard',
  'LLMProvider', 'API', 'Action', 'WorkflowStep',
])

/** 复杂度的宽松阈值（只提示，不阻断）。 */
const SOFT_LIMITS = { lines: 1200, functions: 40, imports: 25 }

/**
 * 校验一个 MaiBot 插件目录。
 *
 * @param {object} options 校验参数。
 * @param {string} options.dir 插件目录绝对路径。
 * @param {{ capabilities: string[], sdkMethods: Map<string, string>, byGroup: Map<string, string[]>, ctxMembers: Set<string>, sdkVersion: string, source: string }} options.host 宿主事实。
 * @param {{ path: string, source: string, reason: string }} options.python Python 解释器信息。
 * @param {Array<object>} [options.installedPlugins] 已安装插件列表（用于重复 ID 检查）。
 * @returns {{ ok: boolean, findings: Array<object>, meta: object }} 校验结果。
 */
export function validatePlugin(options) {
  const { dir, host, python, installedPlugins = [] } = options
  const findings = []
  const push = (severity, code, message) => findings.push({ severity, code, message })

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`插件目录不存在或不是目录：${dir}`)
  }

  const manifestPath = join(dir, '_manifest.json')
  const pluginPyPath = join(dir, 'plugin.py')
  const configPath = join(dir, 'config.toml')

  if (!existsSync(manifestPath)) push('error', 'files.missing_manifest', '缺少 _manifest.json')
  if (!existsSync(pluginPyPath)) push('error', 'files.missing_plugin_py', '缺少 plugin.py')
  if (!existsSync(configPath)) {
    push(
      'error',
      'files.missing_config',
      '缺少 config.toml：宿主在缺少 [plugin] 段时会把它当成启用状态并直接加载，'
        + '必须显式提供 config.toml 且写入 enabled = false。',
    )
  }

  const manifest = existsSync(manifestPath) ? validateManifest(readFileSync(manifestPath, 'utf8'), host, push) : null
  const pluginSource = existsSync(pluginPyPath) ? readFileSync(pluginPyPath, 'utf8') : ''
  const astProbe = existsSync(pluginPyPath)
    ? runAstProbe(python, pluginPyPath)
    : { available: false, data: null, reason: 'plugin.py 不存在', pythonPath: python?.path ?? '' }

  if (!astProbe.available) {
    push('info', 'ast.unavailable', `未做 AST 深检：${astProbe.reason}`)
  } else if (astProbe.data.syntaxError) {
    push('error', 'python.syntax_error', `plugin.py 语法错误：${astProbe.data.syntaxError}`)
  }

  const ast = astProbe.available ? astProbe.data : null
  if (pluginSource) {
    validatePluginSource(pluginSource, ast, host, push)
    if (existsSync(configPath)) {
      validateConfig(readFileSync(configPath, 'utf8'), pluginSource, ast, push)
    }
  }

  const usedCapabilities = pluginSource ? collectUsedCapabilities(pluginSource, ast, host, push) : new Set()
  if (manifest) crossCheckCapabilities(manifest, usedCapabilities, host, push)
  if (manifest) checkDuplicatePluginId(manifest, dir, installedPlugins, push, host.maibotRoot)

  if (python?.path) {
    push('info', 'env.python', `AST 深检使用解释器：${python.path}（来源：${python.source}）`)
  }
  push('info', 'env.host', `能力白名单来源：${host.source}；SDK 版本：${host.sdkVersion || '未知'}`)

  const errors = findings.filter((item) => item.severity === 'error').length
  const warnings = findings.filter((item) => item.severity === 'warning').length

  return {
    ok: errors === 0,
    findings,
    meta: {
      dir,
      pluginId: manifest?.id ?? '',
      sdkVersion: host.sdkVersion,
      capabilitiesDeclared: Array.isArray(manifest?.capabilities) ? manifest.capabilities : [],
      capabilitiesUsed: [...usedCapabilities].sort(),
      errors,
      warnings,
    },
  }
}

/**
 * manifest 校验。
 *
 * @param {string} text manifest 文本。
 * @param {object} host 宿主事实。
 * @param {Function} push 记录器。
 * @returns {object|null} 解析后的 manifest；无法解析时返回 null。
 */
function validateManifest(text, host, push) {
  let manifest
  try {
    manifest = JSON.parse(text)
  } catch (error) {
    push('error', 'manifest.json_invalid', `_manifest.json 不是合法 JSON：${error.message}`)
    return null
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    push('error', 'manifest.not_object', '_manifest.json 顶层必须是对象')
    return null
  }

  const required = ['manifest_version', 'id', 'version', 'name', 'description', 'author', 'license', 'urls', 'host_application', 'sdk', 'capabilities', 'i18n']
  for (const field of required) {
    if (!(field in manifest)) push('error', 'manifest.missing_field', `缺少必填字段 ${field}`)
  }

  for (const key of Object.keys(manifest)) {
    if (!KNOWN_MANIFEST_KEYS.has(key)) {
      push('error', 'manifest.unknown_field', `manifest 含未知字段 ${key}：宿主 extra="forbid"，会直接判定 manifest 非法`)
    }
  }

  if (manifest.manifest_version !== 2) {
    push('error', 'manifest.version_literal', `manifest_version 必须为数字 2，当前为 ${JSON.stringify(manifest.manifest_version)}`)
  }

  if (typeof manifest.id !== 'string' || !PLUGIN_ID_PATTERN.test(manifest.id)) {
    push('error', 'manifest.id_invalid', `id 不合法：${JSON.stringify(manifest.id)}；规则 ^[A-Za-z0-9_]+([.-][A-Za-z0-9_]+)+$，例如 author.plugin-name`)
  }
  if (typeof manifest.version !== 'string' || !SEMVER_PATTERN.test(manifest.version)) {
    push('error', 'manifest.version_invalid', `version 必须是严格三段式语义版本（如 1.0.0），当前为 ${JSON.stringify(manifest.version)}`)
  }
  for (const field of ['name', 'description', 'license']) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim()) {
      push('error', 'manifest.empty_string', `${field} 不能为空`)
    }
  }

  const author = manifest.author
  if (author && typeof author === 'object' && !Array.isArray(author)) {
    if (typeof author.name !== 'string' || !author.name.trim()) push('error', 'manifest.author_name', 'author.name 不能为空')
    if (typeof author.url !== 'string' || !HTTP_URL_PATTERN.test(author.url)) {
      push('error', 'manifest.author_url', `author.url 必须是 http(s) 开头的非空 URL，当前为 ${JSON.stringify(author.url)}`)
    }
  } else if (author !== undefined) {
    push('error', 'manifest.author_type', 'author 必须是对象 {name, url}')
  }

  const urls = manifest.urls
  if (urls && typeof urls === 'object' && !Array.isArray(urls)) {
    if (typeof urls.repository !== 'string' || !HTTP_URL_PATTERN.test(urls.repository)) {
      push('error', 'manifest.repository', `urls.repository 必须是 http(s) 开头的非空 URL，当前为 ${JSON.stringify(urls.repository)}`)
    }
    for (const field of ['homepage', 'documentation', 'issues']) {
      const value = urls[field]
      if (value === undefined || value === null) continue
      if (typeof value !== 'string' || !HTTP_URL_PATTERN.test(value)) {
        push('error', 'manifest.optional_url', `urls.${field} 若提供则必须是 http(s) URL，当前为 ${JSON.stringify(value)}`)
      }
    }
  } else if (urls !== undefined) {
    push('error', 'manifest.urls_type', 'urls 必须是对象 {repository, homepage?, documentation?, issues?}')
  }

  for (const field of ['host_application', 'sdk']) {
    const range = manifest[field]
    if (range === undefined) continue
    if (typeof range !== 'object' || range === null || Array.isArray(range)) {
      push('error', 'manifest.range_type', `${field} 必须是对象 {min_version, max_version}`)
      continue
    }
    for (const bound of ['min_version', 'max_version']) {
      if (typeof range[bound] !== 'string' || !SEMVER_PATTERN.test(range[bound])) {
        push('error', 'manifest.range_version', `${field}.${bound} 必须是严格三段式版本号，当前为 ${JSON.stringify(range[bound])}`)
      }
    }
    if (typeof range.min_version === 'string' && typeof range.max_version === 'string'
      && SEMVER_PATTERN.test(range.min_version) && SEMVER_PATTERN.test(range.max_version)
      && compareSemver(range.min_version, range.max_version) > 0) {
      push('error', 'manifest.range_order', `${field} 的 min_version 大于 max_version`)
    }
  }
  if (manifest.sdk && typeof manifest.sdk === 'object') {
    const max = manifest.sdk.max_version
    if (typeof max === 'string' && host.sdkVersion && SEMVER_PATTERN.test(max) && compareSemver(max, host.sdkVersion) < 0) {
      push('error', 'manifest.sdk_range', `sdk.max_version=${max} 小于当前 SDK ${host.sdkVersion}，宿主会判定运行时不兼容`)
    }
  }

  if (!Array.isArray(manifest.capabilities)) {
    push('error', 'manifest.capabilities_type', 'capabilities 必须是数组')
  } else {
    const live = new Set(host.capabilities)
    for (const capability of manifest.capabilities) {
      if (typeof capability !== 'string' || !capability.trim()) {
        push('error', 'manifest.capability_empty', 'capabilities 中存在空能力名')
        continue
      }
      if (!live.has(capability)) {
        push(
          'error',
          'manifest.capability_unknown',
          `能力 ${capability} 在宿主 registry.py 中未注册：manifest 校验不会拦它，但运行时调用会以「未注册的能力」失败。`
            + `可用能力见 maibot_sdk_reference(topic=capabilities)`,
        )
      }
    }
  }

  if (manifest.i18n !== undefined) {
    const i18n = manifest.i18n
    if (typeof i18n !== 'object' || i18n === null || Array.isArray(i18n)) {
      push('error', 'manifest.i18n_type', 'i18n 必须是对象 {default_locale, supported_locales?}')
    } else {
      if (typeof i18n.default_locale !== 'string' || !i18n.default_locale.trim()) {
        push('error', 'manifest.i18n_default', 'i18n.default_locale 不能为空')
      }
      const locales = i18n.supported_locales
      if (locales !== undefined) {
        if (!Array.isArray(locales)) push('error', 'manifest.i18n_locales_type', 'i18n.supported_locales 必须是数组')
        else if (locales.length > 0 && !locales.includes(i18n.default_locale)) {
          push('error', 'manifest.i18n_locale_membership', 'i18n.default_locale 必须包含在 supported_locales 中')
        }
      }
    }
  }

  if (manifest.dependencies !== undefined) {
    if (!Array.isArray(manifest.dependencies)) {
      push('error', 'manifest.dependencies_type', 'dependencies 必须是数组')
    } else {
      for (const [index, dependency] of manifest.dependencies.entries()) {
        const where = `dependencies[${index}]`
        if (typeof dependency !== 'object' || dependency === null || Array.isArray(dependency)) {
          push('error', 'dependency.not_object', `${where} 必须是对象`)
          continue
        }
        const type = dependency.type
        if (!DEPENDENCY_TYPES.has(type)) {
          push(
            'error',
            'dependency.type',
            `${where}.type=${JSON.stringify(type)} 不被宿主接受：只支持 "plugin"（依赖插件，需 id + version_spec）`
              + ' 与 "python_package"（依赖 pip 包，需 name + version_spec）',
          )
          continue
        }
        if (typeof dependency.version_spec !== 'string' || !dependency.version_spec.trim()) {
          push('error', 'dependency.version_spec', `${where}.version_spec 不能为空，例如 ">=1.0.0"`)
        }
        if (type === 'plugin' && (typeof dependency.id !== 'string' || !PLUGIN_ID_PATTERN.test(dependency.id))) {
          push('error', 'dependency.plugin_id', `${where}.id 必须是合法插件 ID`)
        }
        if (type === 'python_package' && (typeof dependency.name !== 'string' || !dependency.name.trim())) {
          push('error', 'dependency.package_name', `${where}.name 不能为空`)
        }
      }
    }
  }

  return manifest
}

/**
 * config.toml 校验。
 *
 * @param {string} text config.toml 内容。
 * @param {string} source plugin.py 源码。
 * @param {object|null} ast AST 探针结果。
 * @param {Function} push 记录器。
 */
function validateConfig(text, source, ast, push) {
  let parsed
  try {
    parsed = parseToml(text)
  } catch (error) {
    push('error', 'config.parse', `config.toml 解析失败：${error.message}`)
    return
  }

  for (const name of parsed.duplicatedSections) {
    push('warning', 'config.duplicate_section', `config.toml 重复定义了段 [${name}]`)
  }

  const sections = listSections(parsed)
  if (!sections.includes('plugin')) {
    push('error', 'config.missing_plugin_section', '缺少 [plugin] 段：宿主会把没有 plugin 段的插件当成启用状态')
    return
  }

  const enabled = getValue(parsed, 'plugin', 'enabled')
  if (enabled === undefined) {
    push('error', 'config.missing_enabled', '[plugin] 段缺少 enabled：宿主默认视为启用')
  } else if (typeof enabled !== 'boolean') {
    push('error', 'config.enabled_type', `[plugin].enabled 必须是布尔值，当前为 ${JSON.stringify(enabled)}`)
  } else if (enabled === true) {
    push('warning', 'config.enabled_true', '[plugin].enabled = true：新插件建议先 false，确认行为无误后再由用户开启')
  }

  for (const section of sections) {
    if (section !== 'plugin' && !/^[a-z][a-z0-9_]*$/.test(section)) {
      push('warning', 'config.section_naming', `段名 [${section}] 不是 snake_case，配置类名映射容易对不上`)
    }
  }

  // config.toml → plugin.py：每个功能段都应有对应的配置字段/配置类
  for (const section of sections) {
    if (section === 'plugin') continue
    const fieldPattern = new RegExp(`^\\s*${section}\\s*:\\s*\\w+Config`, 'm')
    const classPattern = new RegExp(`class\\s+${pascal(section)}Config\\b`)
    if (!fieldPattern.test(source) && !classPattern.test(source)) {
      push(
        'warning',
        'config.orphan_section',
        `config.toml 的 [${section}] 段在 plugin.py 中找不到对应配置字段或配置类（字段名应与段名一致）`,
      )
    }
  }

  // plugin.py → config.toml：带 __ui_label__ 的配置类都应有一个段
  if (ast) {
    const aggregate = ast.configModel || ''
    for (const cls of ast.classes) {
      if (!cls.hasUiLabel) continue
      if (cls.name === aggregate) continue
      if (cls.name.endsWith('Config') === false) continue
      if (cls.name === 'PluginSectionConfig') continue
      const expected = snake(cls.name.replace(/Config$/, ''))
      const fieldPattern = new RegExp(`^\\s*${expected}\\s*:\\s*\\w+Config`, 'm')
      if (!sections.includes(expected) && !fieldPattern.test(source)) {
        push(
          'warning',
          'config.missing_section',
          `配置类 ${cls.name} 期望对应 [${expected}] 段（或聚合配置里名为 ${expected} 的字段），但 config.toml 中没有`,
        )
      }
    }
  }
}

/**
 * plugin.py 校验（文本规则 + AST 规则）。
 *
 * @param {string} source 源码。
 * @param {object|null} ast AST 探针结果。
 * @param {object} host 宿主事实。
 * @param {Function} push 记录器。
 */
function validatePluginSource(source, ast, host, push) {
  if (/\bself\.logger\b/.test(source)) {
    push('error', 'python.self_logger', '使用了 self.logger：SDK 只提供 self.ctx.logger')
  }

  if (/\bmessage\s*(?:\.get\(\s*|\[\s*)["']plain_text["']/.test(source)) {
    push(
      'error',
      'python.plain_text_key',
      'EventHandler 收到的消息字典没有 plain_text 键：请改用 message["processed_plain_text"]，'
        + '聊天流 ID 用 message["session_id"]（宿主不会给 ON_MESSAGE 传 stream_id 参数）',
    )
  }

  if (/\bmessage\s*(?:\.get\(\s*|\[\s*)["']raw_message["']/.test(source)) {
    push('warning', 'python.raw_message_key', 'raw_message 是消息段列表（dict 列表），不能当纯文本使用')
  }

  if (/\bgetattr\s*\(|\bsetattr\s*\(/.test(source)) {
    push('info', 'python.getattr', '使用了 getattr/setattr：SDK 对象属性可直接访问，动态访问会掩盖拼写错误')
  }

  for (const component of scanComponents(source)) {
    if (component.name === 'WorkflowStep') {
      push('error', 'component.workflow_step_removed', `第 ${component.line} 行 @WorkflowStep：SDK 2.0 已移除，请改用 @HookHandler`)
    }
    if (component.name === 'Action') {
      push('warning', 'component.action_deprecated', `第 ${component.line} 行 @Action 已弃用，请改用 @Tool`)
    }
    if (component.name === 'EventHandler') {
      const blocks = /["']blocked["']/.test(component.body)
      const intercepts = /intercept_message\s*=\s*True/.test(component.args)
      if (blocks && !intercepts) {
        push(
          'error',
          'component.event_blocked_without_intercept',
          `第 ${component.line} 行 EventHandler ${component.method} 返回 {"blocked": True} 但没有 intercept_message=True：`
            + '宿主只采纳 intercept_message=True 的返回值，非拦截型是 fire-and-forget，返回值会被丢弃',
        )
      }
      if (!/\bis_command\b/.test(component.body)) {
        push(
          'warning',
          'component.event_missing_is_command',
          `第 ${component.line} 行 EventHandler ${component.method} 没有检查 message["is_command"]，可能处理命令消息`,
        )
      }
    }
    if (component.name === 'Command' && !/pattern\s*=/.test(component.args)) {
      push('warning', 'component.command_pattern', `第 ${component.line} 行 @Command ${component.method} 没有 pattern，命令不会匹配任何输入`)
    }
    if (component.name === 'Command') {
      for (const reserved of collectCommandLiterals(component)) {
        const reservedBy = host.reservedCommands?.get(reserved)
        if (!reservedBy) continue
        push(
          'warning',
          'component.reserved_command',
          `第 ${component.line} 行 @Command ${component.method} 使用了宿主保留命令 ${reserved}（${reservedBy}）：`
            + `用户发 ${reserved} 时会先被内置命令匹配（可能直接被权限门拦下），建议换个命令名`,
        )
      }
    }
  }

  if (ast) {
    if (!ast.hasCreatePlugin) push('error', 'python.missing_create_plugin', '缺少模块级 create_plugin() 函数：宿主靠它实例化插件')
    if (ast.initDefs > 0) {
      push('warning', 'python.init_defined', `定义了 ${ast.initDefs} 个 __init__：插件类不要定义 __init__，初始化逻辑放 on_load()`)
    }
    if (!ast.hasFutureAnnotations) push('info', 'python.future_annotations', '建议加 from __future__ import annotations')

    const pluginClasses = ast.classes.filter((cls) => cls.bases.some((base) => base.includes('MaiBotPlugin')))
    if (pluginClasses.length === 0) push('error', 'python.no_plugin_class', '没有继承 MaiBotPlugin 的插件类')
    if (!ast.configModel) push('warning', 'python.no_config_model', '插件类缺少 config_model 声明，用户无法在 WebUI 里改配置')

    for (const module of [...ast.imports, ...ast.fromImports]) {
      const top = String(module || '').split('.')[0]
      if (top === 'src') {
        push('error', 'python.import_src', `导入了主程序模块 ${module}：插件只能通过 maibot_sdk 获取能力`)
      } else if (IMPORTS_ERROR.has(top)) {
        push('error', 'python.import_dangerous', `导入了高风险模块 ${module}，请确认确有必要`)
      } else if (IMPORTS_WARNING.has(top)) {
        push('warning', 'python.import_sensitive', `导入了 ${module}：注意沙箱/权限影响，能用 ctx 能力就不要自己发请求或读写文件`)
      }
      if (String(module).startsWith('maibot_sdk.compat')) {
        push('warning', 'python.import_compat', `${module} 是旧插件兼容层，新插件请直接用 maibot_sdk`)
      }
    }

    for (const call of ast.calls) {
      if (CALLS_ERROR.has(call.name)) {
        push('error', 'python.call_dynamic', `第 ${call.line} 行调用了 ${call.name}()，动态执行代码无法审计`)
      }
      if (call.name === 'open' && (call.mode === '<dynamic>' || /[wax+]/.test(call.mode || ''))) {
        push('warning', 'python.open_write', `第 ${call.line} 行以写入/动态模式打开文件（mode=${call.mode || '默认'}）：优先用 ctx 能力或插件 data 目录`)
      }
    }

    if (ast.lines > SOFT_LIMITS.lines) {
      push('warning', 'python.too_many_lines', `plugin.py ${ast.lines} 行，超过建议上限 ${SOFT_LIMITS.lines} 行，建议拆分模块`)
    }
    if (ast.functionCount > SOFT_LIMITS.functions) {
      push('warning', 'python.too_many_functions', `函数数 ${ast.functionCount} 超过建议上限 ${SOFT_LIMITS.functions}`)
    }
    if (ast.importCount > SOFT_LIMITS.imports) {
      push('warning', 'python.too_many_imports', `导入数 ${ast.importCount} 超过建议上限 ${SOFT_LIMITS.imports}`)
    }
  }
}

/**
 * 收集代码里实际调用的能力，并顺带校验 ctx 方法与能力组。
 *
 * @param {string} source 源码。
 * @param {object|null} ast AST 探针结果。
 * @param {object} host 宿主事实。
 * @param {Function} push 记录器。
 * @returns {Set<string>} 实际使用的能力集合。
 */
function collectUsedCapabilities(source, ast, host, push) {
  const used = new Set()
  const seen = new Set()

  const register = (group, method, line) => {
    const key = `${group}.${method}`
    if (seen.has(key)) return
    seen.add(key)

    const methods = host.byGroup.get(group)
    if (!methods) {
      if (!host.ctxMembers.has(group)) {
        push('warning', 'capability.unknown_group', `第 ${line} 行 ctx.${group} 既不是 SDK 能力组也不是已知上下文成员，检查拼写`)
      }
      return
    }
    if (!methods.includes(method)) {
      push(
        'error',
        'capability.method_unknown',
        `第 ${line} 行 ctx.${group}.${method}() 在当前 SDK 中不存在；可用方法：${methods.join(', ')}`,
      )
      return
    }
    used.add(host.sdkMethods.get(key))
  }

  if (ast) {
    for (const call of ast.calls) {
      const normalized = call.chain.replace(/^self\./, '')
      if (!normalized.startsWith('ctx.')) continue
      const parts = normalized.split('.')
      if (parts.length < 3) continue
      register(parts[1], parts[2], call.line)
    }
    return used
  }

  let line = 1
  for (const rawLine of source.split('\n')) {
    for (const match of rawLine.matchAll(/(?:self\.)?ctx\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/g)) {
      register(match[1], match[2], line)
    }
    line += 1
  }
  return used
}

/**
 * 能力声明与实际使用交叉核对。
 *
 * @param {object} manifest manifest 对象。
 * @param {Set<string>} used 实际使用的能力。
 * @param {object} host 宿主事实。
 * @param {Function} push 记录器。
 */
function crossCheckCapabilities(manifest, used, host, push) {
  const declared = new Set(Array.isArray(manifest.capabilities) ? manifest.capabilities : [])

  for (const capability of declared) {
    if (!host.sdkMethods.size) continue
    if (!used.has(capability)) {
      push('warning', 'capability.declared_unused', `manifest 声明了 ${capability} 但 plugin.py 中没有对应调用`)
    }
  }
  for (const capability of used) {
    if (!capability) continue
    if (!declared.has(capability)) {
      push(
        'error',
        'capability.used_undeclared',
        `代码使用了 ${capability} 但没有在 manifest.capabilities 中声明：宿主授权层会拒绝该调用`,
      )
    }
  }
}

/**
 * 重复插件 ID 检查。
 *
 * 只有「当前目录也在 plugins/ 下」才是真正的加载期冲突（宿主发现重复 ID 会同时丢弃两个候选）；
 * 草稿/暂存目录（plugins/ 之外）只提示，否则「暂存 → 覆盖安装」这条正常流程会被判死。
 *
 * @param {object} manifest manifest 对象。
 * @param {string} dir 当前目录。
 * @param {Array<object>} installedPlugins 已安装插件。
 * @param {Function} push 记录器。
 * @param {string} maibotRoot MaiBot 根目录，用于判断当前目录是否位于 plugins/ 下。
 */
function checkDuplicatePluginId(manifest, dir, installedPlugins, push, maibotRoot) {
  if (!manifest.id || !maibotRoot) return

  const validatedInsidePlugins = isInsidePlugins(dir, maibotRoot)
  for (const plugin of installedPlugins) {
    if (plugin.id !== manifest.id) continue
    if (plugin.dir.toLowerCase() === dir.toLowerCase()) continue

    if (validatedInsidePlugins) {
      push(
        'error',
        'plugin.duplicate_id',
        `插件 ID ${manifest.id} 已被 ${plugin.dir} 使用：两处都在 plugins/ 下，`
          + '宿主发现重复 ID 会同时丢弃两个候选，必须先解决冲突',
      )
      continue
    }

    if (sameCodeFiles(dir, plugin.dir)) {
      push(
        'info',
        'plugin.duplicate_id_staging',
        `与已安装目录 ${plugin.dir} 的核心文件一致：应是同一插件的暂存副本，`
          + '可用 maibot_plugin_install（overwrite: true）覆盖安装',
      )
    } else {
      push(
        'info',
        'plugin.duplicate_id_staged_update',
        `宿主里已有同 ID 插件 ${plugin.dir}：当前目录在 plugins/ 之外（草稿/暂存），`
          + '安装时需要用 overwrite 覆盖它',
      )
    }
  }
}

/**
 * 比较两个插件目录的核心代码文件是否一致。
 *
 * 只比 `_manifest.json` 与 `plugin.py`：`config.toml` 属于部署本地状态（enabled、白名单等），
 * 草稿与已装副本不一致是正常的。
 *
 * @param {string} left 目录 A。
 * @param {string} right 目录 B。
 * @returns {boolean} 两个核心文件都一致时返回 true。
 */
function sameCodeFiles(left, right) {
  for (const name of ['_manifest.json', 'plugin.py']) {
    const leftPath = join(left, name)
    const rightPath = join(right, name)
    if (!existsSync(leftPath) || !existsSync(rightPath)) return false
    try {
      if (readFileSync(leftPath, 'utf8') !== readFileSync(rightPath, 'utf8')) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * 收集一个 @Command 组件可能匹配的命令字面量：声明名与 pattern 里的 `^/xxx`。
 *
 * @param {{ args: string }} component 组件扫描结果。
 * @returns {Set<string>} 形如 `/pm` 的命令字面量集合。
 */
function collectCommandLiterals(component) {
  const literals = new Set()
  const declared = /^\s*["']([^"']+)["']/.exec(component.args)
  if (declared?.[1]) literals.add(`/${declared[1]}`)
  for (const match of component.args.matchAll(/\^(\/[A-Za-z][\w-]*)/g)) literals.add(match[1])
  return literals
}

/**
 * 扫描源码里的组件装饰器，返回参数与函数体。
 *
 * @param {string} source 源码。
 * @returns {Array<{ name: string, args: string, method: string, line: number, body: string }>} 组件列表。
 */
function scanComponents(source) {
  const lines = source.split('\n')
  const components = []

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([ \t]*)@([A-Za-z_]\w*)\s*\(/.exec(lines[index])
    if (!match || !COMPONENT_NAMES.has(match[2])) continue

    let args = ''
    let depth = 0
    let started = false
    let cursor = index
    for (; cursor < lines.length; cursor += 1) {
      const text = cursor === index
        ? lines[cursor].slice(lines[cursor].indexOf('(') + 1)
        : lines[cursor]
      args += `${text}\n`
      for (const char of lines[cursor]) {
        if (char === '(') {
          depth += 1
          started = true
        } else if (char === ')') {
          depth -= 1
        }
      }
      if (started && depth <= 0) break
    }

    let defLine = -1
    for (let probe = cursor + 1; probe < Math.min(lines.length, cursor + 5); probe += 1) {
      if (/^[ \t]*(?:async[ \t]+)?def[ \t]+\w+/.test(lines[probe])) {
        defLine = probe
        break
      }
      if (lines[probe].trim() && !/^[ \t]*(?:#|@)/.test(lines[probe])) break
    }
    if (defLine === -1) continue

    const method = /^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)/.exec(lines[defLine])[1]
    const indent = (lines[defLine].match(/^[ \t]*/) ?? [''])[0].length
    let end = lines.length
    for (let probe = defLine + 1; probe < lines.length; probe += 1) {
      const line = lines[probe]
      if (!line.trim()) continue
      const lineIndent = (line.match(/^[ \t]*/) ?? [''])[0].length
      if (lineIndent <= indent && /^[ \t]*(?:async[ \t]+def |def |class |@)/.test(line)) {
        end = probe
        break
      }
    }

    components.push({
      name: match[2],
      args,
      method,
      line: index + 1,
      body: lines.slice(defLine, end).join('\n'),
    })
    index = cursor
  }

  return components
}

/**
 * PascalCase 转 snake_case。
 *
 * @param {string} text 输入。
 * @returns {string} snake_case 结果。
 */
function snake(text) {
  return String(text)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
}

/**
 * PascalCase 转换。
 *
 * @param {string} text 输入。
 * @returns {string} PascalCase 结果。
 */
function pascal(text) {
  const words = String(text ?? '').split(/[^A-Za-z0-9]+/).filter(Boolean)
  return words.map((word) => word[0].toUpperCase() + word.slice(1)).join('')
}

/**
 * 比较两个三段式版本号。
 *
 * @param {string} left 左值。
 * @param {string} right 右值。
 * @returns {number} 左大于右返回正数。
 */
function compareSemver(left, right) {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10))
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10))
  for (let index = 0; index < 3; index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
