/**
 * 安装：把一个已校验的插件目录复制进 MaiBot 的 plugins/ 下，并按需设置启用开关。
 *
 * 先校验再落盘，有 error 一律不安装——避免把半成品塞进插件目录让宿主反复重启。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { setPluginEnabled } from './toml.js'

/** 复制时跳过的目录名。 */
const SKIP_NAMES = new Set(['__pycache__', '.git', '.venv', 'node_modules'])
/** 复制时跳过的文件后缀。 */
const SKIP_SUFFIXES = ['.pyc', '.pyo', '.log']

/**
 * 安装插件。
 *
 * @param {object} options 安装参数。
 * @param {string} options.sourceDir 源插件目录（含三件套）。
 * @param {string} options.maibotRoot MaiBot 根目录。
 * @param {string} [options.dirName] 目标目录名，默认用插件 ID 把点号换成下划线。
 * @param {boolean} [options.overwrite] 目标存在时是否覆盖。
 * @param {boolean} [options.enable] 是否把 [plugin].enabled 写成 true，默认 false。
 * @param {object} options.validation 校验结果（validatePlugin 的返回值）。
 * @returns {{ installed: boolean, target: string, dirName: string, enabled: boolean, message: string, findings: Array<object> }} 安装结果。
 */
export function installPlugin(options) {
  const { sourceDir, maibotRoot, validation } = options
  const findings = validation.findings ?? []

  if (!validation.ok) {
    return {
      installed: false,
      target: '',
      dirName: '',
      enabled: false,
      message: '校验未通过，未安装；请先修复全部 error 级问题',
      findings,
    }
  }

  const pluginId = String(validation.meta?.pluginId ?? validation.pluginId ?? '')
  const dirName = String(options.dirName ?? '').trim() || pluginId.replace(/\./g, '_')
  if (!dirName) {
    throw new Error('无法确定目标目录名：校验结果里没有插件 ID，请显式传 dirName')
  }
  if (dirName.includes('/') || dirName.includes('\\') || dirName === '.' || dirName === '..') {
    throw new Error(`目标目录名不合法：${dirName}`)
  }

  const target = resolve(maibotRoot, 'plugins', dirName)
  const source = resolve(sourceDir)
  if (source === target) {
    return {
      installed: false,
      target,
      dirName,
      enabled: false,
      message: '源目录与目标目录相同，无需安装（就地修改的插件直接看宿主热重载即可）',
      findings,
    }
  }
  if (!existsSync(join(source, '_manifest.json')) || !existsSync(join(source, 'plugin.py'))) {
    return {
      installed: false,
      target,
      dirName,
      enabled: false,
      message: `源目录不像插件目录（缺少 _manifest.json 或 plugin.py）：${source}`,
      findings,
    }
  }

  const exists = existsSync(target)
  if (exists && !options.overwrite) {
    return {
      installed: false,
      target,
      dirName,
      enabled: false,
      message: `目标目录已存在：${target}；如需覆盖请传 overwrite: true`,
      findings,
    }
  }
  if (exists) rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })

  cpSync(source, target, {
    recursive: true,
    filter: (src) => {
      const name = basename(src)
      if (SKIP_NAMES.has(name)) return false
      return !SKIP_SUFFIXES.some((suffix) => name.endsWith(suffix))
    },
  })

  const configPath = join(target, 'config.toml')
  let enabled = false
  if (existsSync(configPath)) {
    const current = readFileSync(configPath, 'utf8')
    const next = setPluginEnabled(current, Boolean(options.enable))
    if (next !== current) writeFileSync(configPath, next, 'utf8')
    enabled = /^\s*enabled\s*=\s*true/m.test(next)
  }

  return {
    installed: true,
    target,
    dirName,
    enabled,
    message: enabled
      ? '已安装并启用：宿主的文件监视器会在插件目录变更后重载插件运行时'
      : '已安装但保持禁用：需要用户把 config.toml 的 [plugin].enabled 改成 true 后重载插件',
    findings,
  }
}

/**
 * 判断路径是否位于 MaiBot 的 plugins/ 目录内。
 *
 * @param {string} path 待判断路径。
 * @param {string} maibotRoot MaiBot 根目录。
 * @returns {boolean} 位于 plugins/ 内返回 true。
 */
export function isInsidePlugins(path, maibotRoot) {
  const pluginsRoot = resolve(maibotRoot, 'plugins')
  const target = resolve(path)
  return target === pluginsRoot || target.startsWith(`${pluginsRoot}\\`) || target.startsWith(`${pluginsRoot}/`)
}

/**
 * 统计目录内的文件数与字节数。
 *
 * @param {string} dir 目录。
 * @returns {{ files: number, bytes: number }} 统计结果。
 */
export function summarizeDir(dir) {
  let files = 0
  let bytes = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = summarizeDir(child)
      files += nested.files
      bytes += nested.bytes
      continue
    }
    files += 1
    bytes += statSync(child).size
  }
  return { files, bytes }
}
