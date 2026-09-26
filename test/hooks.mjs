/**
 * 仓库内测试用的模块解析钩子：把 DSH 的裸包名映射到已安装的 profile 里。
 *
 * 用途：在**仓库目录**里直接跑冒烟测试（仓库本身没有 node_modules）。
 * 正式运行时不需要它——插件被装进 profile（或 profile/plugins 下的链接）后，
 * Node 会沿目录向上自然解析到 profile 的 node_modules。
 *
 * 位置来源：$DSH_PROFILE_NODE_MODULES，否则 $DSH_HOME/profiles/node_modules。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** DSH home。 */
const dshHome = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')

/** 存放 @deepseek-ai/* 的 node_modules。 */
const nodeModules = String(process.env.DSH_PROFILE_NODE_MODULES ?? '').trim()
  || join(dshHome, 'profiles', 'node_modules')

/** 裸包名 → 实际入口文件。 */
const ENTRY_POINTS = {
  '@deepseek-ai/dsh-tools': 'lib/index.js',
  '@deepseek-ai/schemastery': 'lib/index.mjs',
}

const MAPPINGS = new Map(
  Object.entries(ENTRY_POINTS).map(([packageName, entry]) => [
    packageName,
    pathToFileURL(join(nodeModules, ...packageName.split('/'), ...entry.split('/'))).href,
  ]),
)

/**
 * Node 解析钩子：命中映射表时直接返回真实 URL。
 *
 * @param {string} specifier 请求的模块名。
 * @param {object} context 解析上下文。
 * @param {Function} nextResolve 默认解析器。
 * @returns {Promise<object>} 解析结果。
 */
export async function resolve(specifier, context, nextResolve) {
  const target = MAPPINGS.get(specifier)
  if (!target) return nextResolve(specifier, context)
  if (!existsSync(new URL(target))) {
    throw new Error(
      `${specifier} 未在 ${nodeModules} 找到；请设置 DSH_PROFILE_NODE_MODULES 指向 DSH 的 node_modules（当前值：${nodeModules}）`,
    )
  }
  return { url: target, shortCircuit: true }
}
