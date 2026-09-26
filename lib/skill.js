/**
 * 随包 Skill 投放：把插件自带的 SKILL.md 同步到 DSH 的 skills 根目录。
 *
 * Skills 由 dsh-skill-filesystem 监视，写入后无需重启即可被新会话看到；
 * 这里只管理自己命名空间下的目录，不碰用户的其它 skill。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PACKAGE_ROOT, resolveDshHome } from './paths.js'

/** 随包 skill 名称（kebab-case，必须与目录名一致）。 */
export const SKILL_NAME = 'maibot-plugin-writer'

/**
 * 把随包 skill 复制到 `<dshHome>/skills/<SKILL_NAME>`。
 *
 * @param {{ dshHome?: string, syncSkill?: boolean }} config 插件配置。
 * @returns {{ synced: boolean, target: string, version: string, message: string }} 同步结果。
 */
export function syncBundledSkill(config) {
  const version = readPackageVersion()
  if (config?.syncSkill === false) {
    return { synced: false, target: '', version, message: '插件配置 syncSkill = false，跳过 skill 投放' }
  }

  const source = join(PACKAGE_ROOT, 'skills', SKILL_NAME)
  if (!existsSync(source)) {
    return { synced: false, target: '', version, message: `随包 skill 目录缺失：${source}` }
  }

  const target = join(resolveDshHome(config), 'skills', SKILL_NAME)
  mkdirSync(target, { recursive: true })
  cpSync(source, target, { recursive: true })

  writeFileSync(
    join(target, '.bundled-by.json'),
    `${JSON.stringify({ plugin: 'dsh-maibot-plugin-writer', version, syncedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )

  return { synced: true, target, version, message: `已投放 skill ${SKILL_NAME} v${version} → ${target}` }
}

/**
 * 读取本插件版本号。
 *
 * @returns {string} 版本号；读取失败返回 '0.0.0'。
 */
function readPackageVersion() {
  try {
    const packageJson = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'))
    return String(packageJson.version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
}
