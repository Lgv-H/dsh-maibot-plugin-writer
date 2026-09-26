#!/usr/bin/env node
/**
 * 离线本地部署：把本插件包装进指定的 DSH profile。
 *
 * 等价于 `dsh plugin --profile <profile> add link:<本包目录>`，但不依赖 pnpm 联网——
 * 它只做那一步实际产生的三件事：
 *   1. 把包复制到 <profileDir>/plugins/<包名>
 *   2. 在 <profileDir>/package.json 里登记 link 依赖，并把包名加进 dsh.profile.bundles
 *   3. 在 <profileDir>/node_modules 下建链接（Windows 用 junction，免管理员）
 *
 * 用法：
 *   node scripts/deploy-local.mjs                                  # 默认部署到 $DSH_HOME/profiles/web
 *   node scripts/deploy-local.mjs --profile web --force
 *   node scripts/deploy-local.mjs --profile-dir "D:\x\my-profile"  # 指定任意 profile 目录
 *   node scripts/deploy-local.mjs --root "C:\...\modules\MaiBot"    # 顺带打印 maibotRoot 覆盖片段
 *
 * 部署后需要重启对应 profile 的服务才会加载新插件。
 */

import {
  cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 复制时跳过的目录名。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.github', '.tmp-smoke', '.tmp-unit', '.tmp-smoke-host'])

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv 进程参数。
 * @returns {{ profile: string, profileDir: string, root: string, force: boolean }} 解析结果。
 */
function parseArgs(argv) {
  const options = { profile: 'web', profileDir: '', root: '', force: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') options.profile = String(argv[++index] ?? '').trim() || 'web'
    else if (arg === '--profile-dir') options.profileDir = String(argv[++index] ?? '').trim()
    else if (arg === '--root') options.root = String(argv[++index] ?? '').trim()
    else if (arg === '--force') options.force = true
    else if (arg === '--help' || arg === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').trim())
      process.exit(0)
    } else {
      throw new Error(`未知参数：${arg}（可用 --profile --profile-dir --root --force --help）`)
    }
  }
  return options
}

/**
 * 用对象重写 profile 的 package.json（UTF-8 无 BOM）。
 *
 * @param {string} path package.json 路径。
 * @param {object} data 完整清单对象。
 */
function writeProfileManifest(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8' })
}

/**
 * 建立 node_modules 链接（Windows 用 junction，其它平台用目录符号链接）。
 *
 * @param {string} linkPath 链接路径。
 * @param {string} targetPath 目标目录。
 */
function linkPackage(linkPath, targetPath) {
  if (existsSync(linkPath)) rmSync(linkPath, { recursive: true, force: true })
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

const options = parseArgs(process.argv.slice(2))
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const packageName = packageJson.name

const dshHome = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
const profileDir = options.profileDir
  ? resolve(options.profileDir)
  : join(dshHome, 'profiles', options.profile)

const profileManifestPath = join(profileDir, 'package.json')
if (!existsSync(profileManifestPath)) {
  throw new Error(`不是已初始化的 profile 目录（缺少 package.json）：${profileDir}`)
}

const targetDir = join(profileDir, 'plugins', packageName)
if (existsSync(targetDir) && !options.force) {
  throw new Error(`目标已存在：${targetDir}；确认要覆盖再传 --force`)
}

// 1) 复制包内容
cpSync(packageRoot, targetDir, {
  recursive: true,
  filter: (source) => !SKIP_DIRS.has(basename(source)),
})

// 2) 登记依赖与 bundle 层
const manifest = JSON.parse(readFileSync(profileManifestPath, 'utf8'))
manifest.dependencies = manifest.dependencies ?? {}
manifest.dependencies[packageName] = `link:${targetDir.replace(/\\/g, '/')}`
manifest.dsh = manifest.dsh ?? {}
manifest.dsh.profile = manifest.dsh.profile ?? {}
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles ?? []
if (!manifest.dsh.profile.bundles.includes(packageName)) manifest.dsh.profile.bundles.push(packageName)
writeProfileManifest(profileManifestPath, manifest)

// 3) 建 node_modules 链接
const linkPath = join(profileDir, 'node_modules', packageName)
linkPackage(linkPath, targetDir)

console.log(`已部署 ${packageName} v${packageJson.version}`)
console.log(`  包目录   : ${targetDir}`)
console.log(`  profile  : ${profileDir}`)
console.log(`  依赖登记 : ${manifest.dependencies[packageName]}`)
console.log(`  bundle 层: ${manifest.dsh.profile.bundles.filter((name) => name === packageName).length > 0 ? '已加入 dsh.profile.bundles' : '未加入'}`)
console.log(`  链接     : ${linkPath}`)
if (options.root) {
  console.log('\n如要在这台机器上固定 MaiBot 路径，把下面片段加进 profile 的 cordis.patch.yml：')
  console.log(`- id: ${packageName}`)
  console.log(`  name: ${packageName}`)
  console.log('  config:')
  console.log(`    maibotRoot: '${options.root.replace(/\\/g, '\\\\')}'`)
}
console.log('\n下一步：重启该 profile 的 DSH 服务（Web 服务或桌面客户端的 Web 服务）以加载新插件。')
