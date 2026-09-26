/**
 * Python 探针调用：把 plugin.py 交给 ast_probe.py 做语法与结构深检。
 *
 * 解释器缺失或探针失败都会返回 available=false + 原因，由调用方决定如何呈现，
 * 不做静默降级。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { PACKAGE_ROOT } from './paths.js'

/**
 * 运行 AST 探针。
 *
 * @param {{ path: string, source: string, reason: string }} python Python 解释器信息。
 * @param {string} pluginPyPath 目标 plugin.py 绝对路径。
 * @returns {{ available: boolean, data: object|null, reason: string, pythonPath: string }} 探针结果。
 */
export function runAstProbe(python, pluginPyPath) {
  if (!python?.path) {
    return { available: false, data: null, reason: python?.reason || '未配置 Python 解释器', pythonPath: '' }
  }
  const probePath = join(PACKAGE_ROOT, 'lib', 'ast_probe.py')
  if (!existsSync(probePath)) {
    return { available: false, data: null, reason: `探针脚本缺失：${probePath}`, pythonPath: python.path }
  }

  const result = spawnSync(python.path, [probePath, pluginPyPath], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })

  if (result.error) {
    return {
      available: false,
      data: null,
      reason: `无法启动 Python（${python.path}）：${result.error.message}`,
      pythonPath: python.path,
    }
  }
  if (result.status !== 0) {
    return {
      available: false,
      data: null,
      reason: `探针退出码 ${result.status}：${String(result.stderr || '').trim().slice(0, 400)}`,
      pythonPath: python.path,
    }
  }

  const stdout = String(result.stdout || '').trim()
  try {
    return { available: true, data: JSON.parse(stdout), reason: '', pythonPath: python.path }
  } catch (error) {
    return {
      available: false,
      data: null,
      reason: `探针输出不是合法 JSON：${error.message}；原始输出前 200 字：${stdout.slice(0, 200)}`,
      pythonPath: python.path,
    }
  }
}
