/**
 * 宿主探测层：从运行中的 MaiBot 源码与已安装的 maibot_sdk 中提取「事实」，
 * 作为校验与参考的唯一数据源，避免把能力名/方法名硬编码进本插件后逐渐过期。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/** 宿主中无需在 manifest 声明即可调用的能力。 */
export const ALWAYS_ALLOWED_CAPABILITIES = ['api.replace_dynamic']

/** 组件装饰器 → 中文说明。 */
const COMPONENT_PATTERNS = [
  ['@Command', '命令'],
  ['@Tool', '工具'],
  ['@EventHandler', '事件监听'],
  ['@HookHandler', '钩子'],
  ['@MessageGateway', '消息网关'],
  ['@HomeCard', '主页卡片'],
  ['@WorkflowStep', '工作流步骤'],
  ['@LLMProvider', 'LLM 提供方'],
  ['@API', '插件 API'],
  ['@Action', '动作(已弃用)'],
]

/** 能力注册表缓存（按 mtime 失效）。 */
let capabilityCache = null

/**
 * 读取宿主能力注册表（唯一权威的白名单来源）。
 *
 * @param {string} maibotRoot MaiBot 源码根。
 * @returns {{ capabilities: string[], source: string, mtimeMs: number }} 能力名集合与来源。
 */
export function loadCapabilities(maibotRoot) {
  const registryPath = join(maibotRoot, 'src', 'plugin_runtime', 'capabilities', 'registry.py')
  const mtimeMs = statSync(registryPath).mtimeMs
  if (capabilityCache && capabilityCache.path === registryPath && capabilityCache.mtimeMs === mtimeMs) {
    return capabilityCache.value
  }

  const source = readFileSync(registryPath, 'utf8')
  const capabilities = new Set(ALWAYS_ALLOWED_CAPABILITIES)
  for (const match of source.matchAll(/_register\(\s*"([^"]+)"/g)) capabilities.add(match[1])

  const value = {
    capabilities: [...capabilities].sort(),
    source: registryPath,
    mtimeMs,
  }
  capabilityCache = { path: registryPath, mtimeMs, value }
  return value
}

/**
 * 读取 maibot_sdk 版本号。
 *
 * @param {string} pythonEnv site-packages 路径。
 * @returns {string} 版本号；读不到返回空串。
 */
export function loadSdkVersion(pythonEnv) {
  if (!pythonEnv) return ''
  const initPath = join(pythonEnv, 'maibot_sdk', '__init__.py')
  if (!existsSync(initPath)) return ''
  const match = /__version__\s*=\s*"([^"]+)"/.exec(readFileSync(initPath, 'utf8'))
  return match ? match[1] : ''
}

/**
 * 从 maibot_sdk.context 里提取 PluginContext 的成员名（能力代理之外的合法属性，如 logger）。
 *
 * @param {string} pythonEnv site-packages 路径。
 * @returns {Set<string>} 成员名集合。
 */
export function loadCtxMembers(pythonEnv) {
  const members = new Set(['logger', 'plugin_id', 'paths'])
  if (!pythonEnv) return members
  const contextPath = join(pythonEnv, 'maibot_sdk', 'context.py')
  if (!existsSync(contextPath)) return members

  const source = readFileSync(contextPath, 'utf8')
  for (const match of source.matchAll(/self\.([A-Za-z_]\w*)\s*[=:]/g)) members.add(match[1])
  for (const match of source.matchAll(/def\s+([A-Za-z_]\w*)\s*\(\s*self/g)) {
    if (!match[1].startsWith('_')) members.add(match[1])
  }
  return members
}

/**
 * 扫描 maibot_sdk.capabilities.*，建立 `ctx.<组>.<方法>` → 能力名 的映射。
 *
 * 例如 `ctx.send.text` → `send.text`、`ctx.render.html2png` → `render.html2png`。
 * 两种底层调用方式都识别：`call_capability("x.y", ...)` 与 payload 里的 `"capability": "x.y"`。
 *
 * @param {string} pythonEnv site-packages 路径。
 * @returns {{ methods: Map<string, string>, byGroup: Map<string, string[]>, sdkDir: string }} 方法映射。
 */
export function loadSdkMethods(pythonEnv) {
  const methods = new Map()
  const byGroup = new Map()
  const sdkDir = pythonEnv ? join(pythonEnv, 'maibot_sdk', 'capabilities') : ''
  if (!sdkDir || !existsSync(sdkDir)) return { methods, byGroup, sdkDir: '' }

  for (const entry of readdirSync(sdkDir).sort()) {
    if (!entry.endsWith('.py') || entry === '__init__.py') continue
    const group = basename(entry, '.py')
    const source = readFileSync(join(sdkDir, entry), 'utf8')
    const blocks = splitMethodBlocks(source)

    for (const [method, body] of blocks) {
      const capability = extractCapability(body)
      if (!capability) continue
      methods.set(`${group}.${method}`, capability)
      if (!byGroup.has(group)) byGroup.set(group, [])
      byGroup.get(group).push(method)
    }
  }

  for (const list of byGroup.values()) list.sort()
  return { methods, byGroup, sdkDir }
}

/**
 * 扫描 MaiBot 的 plugins/ 目录，收集已有插件信息（供参考与冲突检查）。
 *
 * @param {string} maibotRoot MaiBot 源码根。
 * @returns {Array<object>} 插件信息列表，按 id 排序。
 */
export function scanPlugins(maibotRoot) {
  const pluginsDir = join(maibotRoot, 'plugins')
  if (!existsSync(pluginsDir)) return []

  const found = []
  for (const entry of readdirSync(pluginsDir).sort()) {
    const dir = join(pluginsDir, entry)
    let isDirectory = false
    try {
      isDirectory = statSync(dir).isDirectory()
    } catch {
      continue
    }
    if (!isDirectory) continue

    const manifestPath = join(dir, '_manifest.json')
    if (!existsSync(manifestPath)) continue

    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }

    const pluginPath = join(dir, 'plugin.py')
    let lines = 0
    let components = []
    let enabled = null
    if (existsSync(pluginPath)) {
      const code = readFileSync(pluginPath, 'utf8')
      lines = code.split('\n').length
      components = COMPONENT_PATTERNS.filter(([pattern]) => code.includes(pattern)).map(([, label]) => label)
    }

    const configPath = join(dir, 'config.toml')
    if (existsSync(configPath)) {
      const match = /^\s*enabled\s*=\s*(true|false)/m.exec(readFileSync(configPath, 'utf8'))
      if (match) enabled = match[1] === 'true'
    }

    found.push({
      id: String(manifest.id ?? ''),
      name: String(manifest.name ?? ''),
      version: String(manifest.version ?? ''),
      description: String(manifest.description ?? ''),
      capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities.map(String) : [],
      dirName: entry,
      dir,
      lines,
      components,
      enabled,
    })
  }

  return found.sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * 按 `async def` 切分模块，得到「方法名 → 方法体」。
 *
 * @param {string} source 模块源码。
 * @returns {Map<string, string>} 方法块。
 */
function splitMethodBlocks(source) {
  const blocks = new Map()
  const matches = [...source.matchAll(/^[ \t]*(?:async[ \t]+)?def[ \t]+(\w+)[ \t]*\(/gm)]
  for (let index = 0; index < matches.length; index += 1) {
    const name = matches[index][1]
    const start = matches[index].index ?? 0
    const end = index + 1 < matches.length ? matches[index + 1].index ?? source.length : source.length
    blocks.set(name, source.slice(start, end))
  }
  return blocks
}

/**
 * 从方法体里提取它实际调用的能力名。
 *
 * @param {string} body 方法体源码。
 * @returns {string} 能力名；未识别返回空串。
 */
function extractCapability(body) {
  const direct = /call_capability\(\s*"([^"]+)"/.exec(body)
  if (direct) return direct[1]
  const payload = /"capability"\s*:\s*"([^"]+)"/.exec(body)
  if (payload) return payload[1]
  // render.py 之类先把能力名赋给局部变量，再放进 payload
  const assigned = /capability\s*=\s*"([^"]+)"/.exec(body)
  if (assigned) return assigned[1]
  return ''
}
