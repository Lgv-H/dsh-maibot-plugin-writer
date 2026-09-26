/**
 * 路径解析：MaiBot 源码根、Python 解释器、SDK site-packages、DSH home。
 *
 * 解析顺序遵循「显式优先、失败即报错」：任何一处显式配置指向无效目录都直接抛错，
 * 而不是悄悄退回下一档，避免把「配错了」表现成「换了个目录」。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 判定“这是 MaiBot 源码根”的两个标记。 */
export const REGISTRY_RELATIVE = join('src', 'plugin_runtime', 'capabilities', 'registry.py')

/** 本插件的包根目录（lib/ 的上一级）。 */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 向上探测的层数上限。 */
const DETECT_DEPTH = 8

/** Python 解释器候选位置（相对 MaiBot 根目录）。 */
const PYTHON_RELATIVE_CANDIDATES = [
  join('..', 'python-env', 'python.exe'),
  join('..', '..', 'python-env', 'python.exe'),
  join('.venv', 'Scripts', 'python.exe'),
  join('..', '.venv', 'Scripts', 'python.exe'),
  join('..', '.venv312', 'Scripts', 'python.exe'),
  join('.venv', 'bin', 'python3'),
  join('..', '.venv', 'bin', 'python3'),
]

/**
 * 判断目录是否是 MaiBot 源码根。
 *
 * @param {string} dir 待判定目录。
 * @returns {boolean} 同时存在能力注册表与 plugins/ 时为 true。
 */
export function isMaibotRoot(dir) {
  if (!dir) return false
  return existsSync(join(dir, REGISTRY_RELATIVE)) && existsSync(join(dir, 'plugins'))
}

/**
 * 解析 DSH home（Skills 根目录的父目录）。
 *
 * @param {{ dshHome?: string }} config 插件配置。
 * @returns {string} DSH home 绝对路径。
 */
export function resolveDshHome(config) {
  const configured = String(config?.dshHome ?? '').trim()
  if (configured) return resolve(expandHome(configured))
  const fromEnv = String(process.env.DSH_HOME ?? '').trim()
  if (fromEnv) return resolve(expandHome(fromEnv))
  return join(homedir(), '.dsh')
}

/**
 * 展开 `~` 并把相对路径落到基准目录上。
 *
 * @param {string} raw 原始路径。
 * @param {string} [base] 相对路径基准，默认 process.cwd()。
 * @returns {string} 绝对路径。
 */
export function resolveUserPath(raw, base) {
  const expanded = expandHome(String(raw ?? '').trim())
  if (!expanded) throw new Error('路径为空')
  if (isAbsolute(expanded)) return resolve(expanded)
  return resolve(base ?? process.cwd(), expanded)
}

/**
 * 从起始目录逐级向上查找 MaiBot 根。
 *
 * @param {string} startDir 起始目录。
 * @returns {string} 命中的 MaiBot 根；未命中返回空串。
 */
export function detectMaibotRoot(startDir) {
  let dir = resolve(startDir)
  for (let depth = 0; depth < DETECT_DEPTH; depth += 1) {
    if (isMaibotRoot(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return ''
}

/**
 * 列举常见安装位置的候选 MaiBot 根目录。
 *
 * 覆盖：Windows 一键包（%APPDATA%\MaiBotOneKeyDesktop\<hash>\modules\MaiBot）、
 * 用户主目录下的 MaiBot/maibot、macOS/Linux 的常见路径。
 *
 * @returns {string[]} 候选目录（可能不存在）。
 */
export function knownMaibotCandidates() {
  const candidates = []
  const appData = String(process.env.APPDATA ?? '').trim()

  if (appData) {
    const oneKeyRoot = join(appData, 'MaiBotOneKeyDesktop')
    if (existsSync(oneKeyRoot)) {
      for (const entry of readdirSync(oneKeyRoot)) {
        candidates.push(join(oneKeyRoot, entry, 'modules', 'MaiBot'))
        candidates.push(join(oneKeyRoot, entry, 'MaiBot'))
      }
    }
  }

  const home = homedir()
  candidates.push(join(home, 'MaiBot'))
  candidates.push(join(home, 'maibot'))
  candidates.push(join(home, 'Documents', 'MaiBot'))
  candidates.push(join(home, 'source', 'MaiBot'))
  candidates.push(join('/', 'opt', 'MaiBot'))
  candidates.push(join('/', 'srv', 'MaiBot'))

  return candidates
}

/**
 * 从常见安装位置自动发现 MaiBot 根（存在多个时取最近修改的那个）。
 *
 * @returns {{ root: string, candidates: string[] }} 命中结果与全部有效候选。
 */
export function discoverMaibotRoot() {
  const valid = knownMaibotCandidates().filter((candidate) => isMaibotRoot(candidate))
  if (valid.length === 0) return { root: '', candidates: [] }

  const sorted = valid
    .map((root) => {
      let mtimeMs = 0
      try {
        mtimeMs = statSync(join(root, REGISTRY_RELATIVE)).mtimeMs
      } catch {
        mtimeMs = 0
      }
      return { root, mtimeMs }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)

  return { root: sorted[0].root, candidates: valid }
}

/**
 * 解析 MaiBot 根目录：工具参数 → 插件配置 → 环境变量 → 工作目录向上探测 → 自动发现。
 *
 * @param {{ maibotRoot?: string }} config 插件配置。
 * @param {string} [explicit] 工具参数传入的根目录。
 * @returns {{ root: string, source: string }} 根目录与来源说明。
 */
export function resolveMaibotRoot(config, explicit) {
  const candidates = [
    [explicit, '工具参数 maibotRoot'],
    [config?.maibotRoot, '插件配置 maibotRoot'],
    [process.env.DSH_MAIBOT_ROOT, '环境变量 DSH_MAIBOT_ROOT'],
    [process.env.MAIBOT_ROOT, '环境变量 MAIBOT_ROOT'],
  ]

  for (const [raw, source] of candidates) {
    const value = String(raw ?? '').trim()
    if (!value) continue
    const dir = resolveUserPath(value)
    if (!isMaibotRoot(dir)) {
      throw new Error(
        `${source} 指向的目录不是 MaiBot 源码根（需要同时存在 ${REGISTRY_RELATIVE} 与 plugins/）：${dir}`,
      )
    }
    return { root: dir, source }
  }

  const detected = detectMaibotRoot(process.cwd())
  if (detected) return { root: detected, source: `从 ${process.cwd()} 向上探测` }

  const discovered = discoverMaibotRoot()
  if (discovered.root) {
    const extra = discovered.candidates.length > 1
      ? `（发现多个候选，已选最近修改的；全部候选：${discovered.candidates.join(' | ')}）`
      : ''
    return { root: discovered.root, source: `自动发现${extra}` }
  }

  throw new Error(
    '无法确定 MaiBot 根目录：请在工具参数里传 maibotRoot，或在插件配置中设置 maibotRoot，'
      + '或设置环境变量 DSH_MAIBOT_ROOT。',
  )
}

/**
 * 解析 Python 解释器：插件配置 → MaiBot 同级 python-env/venv → PATH。
 *
 * @param {{ pythonPath?: string }} config 插件配置。
 * @param {string} maibotRoot MaiBot 根目录。
 * @returns {{ path: string, source: string, reason: string }} 解释器路径；未找到时 path 为空串并给出原因。
 */
export function resolvePython(config, maibotRoot) {
  const configured = String(config?.pythonPath ?? '').trim()
  if (configured) {
    const path = resolveUserPath(configured)
    if (!existsSync(path)) throw new Error(`插件配置 pythonPath 指向的解释器不存在：${path}`)
    return { path, source: '插件配置 pythonPath', reason: '' }
  }

  for (const relative of PYTHON_RELATIVE_CANDIDATES) {
    const path = resolve(maibotRoot, relative)
    if (existsSync(path)) return { path, source: `MaiBot 同级 ${relative}`, reason: '' }
  }

  const onPath = whichOnPath(process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'])
  if (onPath) return { path: onPath, source: 'PATH', reason: '' }

  return {
    path: '',
    source: '未找到',
    reason: 'PATH、MaiBot 同级 python-env/ 与 .venv 中都没有可用的 Python 解释器',
  }
}

/**
 * 定位包含 maibot_sdk 的 site-packages。
 *
 * @param {string} maibotRoot MaiBot 根目录。
 * @param {string} pythonPath Python 解释器路径。
 * @returns {string} site-packages 绝对路径；未找到返回空串。
 */
export function resolvePythonEnv(maibotRoot, pythonPath) {
  const candidates = []
  if (pythonPath) {
    const prefix = dirname(dirname(pythonPath))
    candidates.push(join(prefix, 'Lib', 'site-packages'))
  }
  candidates.push(join(maibotRoot, '..', 'python-env', 'Lib', 'site-packages'))
  candidates.push(join(maibotRoot, '..', '..', 'python-env', 'Lib', 'site-packages'))
  candidates.push(join(maibotRoot, '.venv', 'Lib', 'site-packages'))
  candidates.push(join(maibotRoot, '..', '.venv', 'Lib', 'site-packages'))
  candidates.push(join(maibotRoot, '..', '.venv312', 'Lib', 'site-packages'))

  for (const candidate of candidates) {
    const resolved = resolve(candidate)
    if (existsSync(join(resolved, 'maibot_sdk'))) return resolved
  }
  return ''
}

/**
 * 在 PATH 中查找第一个存在的可执行文件。
 *
 * @param {string[]} names 候选文件名。
 * @returns {string} 命中路径；未命中返回空串。
 */
function whichOnPath(names) {
  const entries = String(process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const entry of entries) {
    for (const name of names) {
      const candidate = join(entry, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return ''
}

/**
 * 展开路径开头的 `~`。
 *
 * @param {string} value 原始路径。
 * @returns {string} 展开后的路径。
 */
function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}
