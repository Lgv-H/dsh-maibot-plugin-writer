/**
 * 冒烟测试：用真实的 MaiBot 宿主跑一遍全部工具，并复核 defineTool 的 schema 合法。
 *
 * 运行：
 *   node test/smoke.mjs                       # 自动解析 MaiBot 根目录
 *   node test/smoke.mjs "C:\path\to\MaiBot"   # 显式指定
 *   npm run test:repo                         # 在仓库目录里跑（用 test/hooks.mjs 解析 DSH 包）
 *
 * 只往本包内的 .tmp-smoke/ 与一个临时 fake 根目录写文件，不碰真实 plugins/ 目录。
 * 找不到 MaiBot 时不是静默通过：会打印原因并以 0 退出（真实宿主用例全部标记为 SKIP）。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineTool } from '@deepseek-ai/dsh-tools'

import { apply, buildToolOptions } from '../lib/index.js'
import { installPlugin } from '../lib/install.js'
import { resolveMaibotRoot } from '../lib/paths.js'

const testDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(testDir, '..')
const tmpRoot = join(packageRoot, '.tmp-smoke')

let maibot = null
try {
  maibot = resolveMaibotRoot({}, process.argv[2] ?? '')
} catch (error) {
  console.log(`未找到 MaiBot 根目录，跳过真实宿主用例：${error.message}`)
}

const maibotRoot = maibot?.root ?? ''
const results = []
const signal = new AbortController().signal

/**
 * 记录一条断言结果。
 *
 * @param {string} title 断言名。
 * @param {boolean} passed 是否通过。
 * @param {string} [detail] 附加说明。
 */
function check(title, passed, detail = '') {
  results.push({ title, passed, skipped: false })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${title}${detail ? ` — ${detail}` : ''}`)
}

/**
 * 记录一条跳过。
 *
 * @param {string} title 断言名。
 * @param {string} reason 跳过原因。
 */
function skip(title, reason) {
  results.push({ title, passed: true, skipped: true })
  console.log(`SKIP  ${title} — ${reason}`)
}

/**
 * 收集 apply() 注册的工具定义。
 *
 * @returns {Map<string, object>} 名称 → 定义。
 */
function collectTools() {
  const registered = new Map()
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: { register: (definition) => registered.set(definition.name, definition) },
  }
  apply(ctx, { maibotRoot, syncSkill: false })
  return registered
}

/**
 * 执行一个工具。
 *
 * @param {Map<string, object>} tools 工具定义。
 * @param {string} toolName 工具名。
 * @param {object} args 参数。
 * @returns {Promise<unknown>} 工具返回值。
 */
async function run(tools, toolName, args) {
  const definition = tools.get(toolName)
  if (!definition) throw new Error(`工具未注册：${toolName}`)
  return definition.execute(args, { signal })
}

/**
 * 打印 error 级校验结论。
 *
 * @param {object} validation 校验结果。
 */
function printErrors(validation) {
  for (const finding of validation.findings.filter((item) => item.severity === 'error')) {
    console.log(`    · [${finding.code}] ${finding.message.slice(0, 140)}`)
  }
}

/**
 * 造一个最小的合成 MaiBot 根目录，让脚手架/校验/安装在任何环境下都能跑。
 *
 * 只包含宿主识别所需的 registry.py 与 plugins/，没有 maibot_sdk，
 * 因此能力方法表为空（相关检查会被明确跳过，而不是伪造结论）。
 *
 * @returns {string} 合成根目录。
 */
function makeSyntheticRoot() {
  const root = join(packageRoot, '.tmp-smoke-host')
  mkdirSync(join(root, 'src', 'plugin_runtime', 'capabilities'), { recursive: true })
  mkdirSync(join(root, 'plugins'), { recursive: true })
  writeFileSync(
    join(root, 'src', 'plugin_runtime', 'capabilities', 'registry.py'),
    '_register("send.text", impl)\n_register("send.image", impl)\n_register("config.get", impl)\n',
    'utf8',
  )
  return root
}

async function main() {
  if (maibotRoot) console.log(`MaiBot 根目录：${maibotRoot}（${maibot.source}）\n`)
  else console.log('')

  const tools = collectTools()
  check('注册了 5 个工具', tools.size === 5, [...tools.keys()].join(', '))
  for (const options of buildToolOptions({ maibotRoot, syncSkill: false })) {
    try {
      defineTool(options)
      check(`schema 合法: ${options.name}`, true)
    } catch (error) {
      check(`schema 合法: ${options.name}`, false, error.message)
    }
  }

  const skillPath = join(packageRoot, 'skills', 'maibot-plugin-writer', 'SKILL.md')
  const skillText = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : ''
  check('skill frontmatter 完整', /^---[\s\S]*name: maibot-plugin-writer[\s\S]*description: [\s\S]*---/.test(skillText))

  // ── 真实宿主相关 ──
  if (maibotRoot) {
    const catalog = await run(tools, 'maibot_plugin_catalog', {})
    check('catalog 返回已安装插件', String(catalog).includes('已安装插件'))
    check('catalog 含宿主能力统计', String(catalog).includes('宿主能力：'))

    check('reference/overview', String(await run(tools, 'maibot_sdk_reference', { topic: 'overview' })).includes('宿主加载规则'))
    const methods = String(await run(tools, 'maibot_sdk_reference', { topic: 'methods' }))
    check('reference/methods 含 ctx.send.text', methods.includes('ctx.send.text'))
    check('reference/methods 含 ctx.render.html2png', methods.includes('ctx.render.html2png'))
    check('reference/capabilities 含 database.*', String(await run(tools, 'maibot_sdk_reference', { topic: 'capabilities' })).includes('database.'))
    check('reference/pitfalls 提到 plain_text 坑', String(await run(tools, 'maibot_sdk_reference', { topic: 'pitfalls' })).includes('plain_text'))

    const referencePluginDir = join(maibotRoot, 'plugins', 'deepseek-v4-pro_self-writing-plugin')
    if (existsSync(referencePluginDir)) {
      const referenceValidation = await run(tools, 'maibot_plugin_validate', { dir: referencePluginDir })
      const referenceCodes = new Set(referenceValidation.findings.map((item) => item.code))
      check('识别参考插件的 plain_text 误用', referenceCodes.has('python.plain_text_key'))
      check('识别参考插件 blocked 缺 intercept_message', referenceCodes.has('component.event_blocked_without_intercept'))
      check('识别参考插件未用的能力声明', referenceCodes.has('capability.declared_unused'))
      console.log(`    参考插件：errors=${referenceValidation.errors} warnings=${referenceValidation.warnings}`)
      printErrors(referenceValidation)
    } else {
      skip('校验参考插件', '参考插件目录不存在')
    }
  } else {
    for (const title of [
      'catalog 返回已安装插件', 'catalog 含宿主能力统计', 'reference/overview', 'reference/methods 含 ctx.send.text',
      'reference/methods 含 ctx.render.html2png', 'reference/capabilities 含 database.*', 'reference/pitfalls 提到 plain_text 坑',
      '识别参考插件的 plain_text 误用', '识别参考插件 blocked 缺 intercept_message', '识别参考插件未用的能力声明',
    ]) skip(title, '未找到 MaiBot 根目录')
  }

  // ── 不需要真实宿主：脚手架 + 校验 + 安装（用真实或合成根目录） ──
  rmSync(tmpRoot, { recursive: true, force: true })
  mkdirSync(tmpRoot, { recursive: true })
  const smokeHostRoot = maibotRoot || makeSyntheticRoot()
  if (!maibotRoot) console.log(`\n使用合成宿主根目录跑脚手架/校验/安装：${smokeHostRoot}\n`)
  const draftDir = join(tmpRoot, 'dsh-smoke-plugin')

  const scaffold = await run(tools, 'maibot_plugin_scaffold', {
    pluginId: 'dsh.smoke-plugin',
    name: '冒烟测试插件',
    description: '由冒烟测试生成，用于验证脚手架与校验闭环',
    dir: draftDir,
    maibotRoot: smokeHostRoot,
  })
  check(
    'scaffold 生成三件套',
    ['_manifest.json', 'plugin.py', 'config.toml'].every((file) => existsSync(join(draftDir, file))),
    scaffold.dir,
  )
  check('scaffold 默认禁用', scaffold.enabled === false)

  const draftValidation = await run(tools, 'maibot_plugin_validate', { dir: draftDir, maibotRoot: smokeHostRoot })
  check('脚手架产物校验 0 error', draftValidation.ok === true, `errors=${draftValidation.errors} warnings=${draftValidation.warnings}`)
  check('能力交叉核对通过', draftValidation.capabilitiesUsed.includes('send.text'), draftValidation.capabilitiesUsed.join(', '))
  if (!draftValidation.ok) printErrors(draftValidation)

  // installPlugin 用假的 MaiBot 根目录跑，避免污染真实 plugins/
  const fakeRoot = join(tmpRoot, 'fake-maibot')
  mkdirSync(join(fakeRoot, 'plugins'), { recursive: true })
  const installResult = installPlugin({
    sourceDir: draftDir,
    maibotRoot: fakeRoot,
    overwrite: false,
    enable: false,
    validation: { ok: true, findings: [], meta: { pluginId: 'dsh.smoke-plugin' } },
  })
  const installedConfig = existsSync(join(installResult.target, 'config.toml'))
    ? readFileSync(join(installResult.target, 'config.toml'), 'utf8')
    : ''
  check('install 复制进 plugins/ 下', installResult.installed && existsSync(join(installResult.target, 'plugin.py')), installResult.target)
  check('install 保持 enabled = false', /^\s*enabled\s*=\s*false/m.test(installedConfig))

  const overwriteRefusal = installPlugin({
    sourceDir: draftDir,
    maibotRoot: fakeRoot,
    overwrite: false,
    enable: false,
    validation: { ok: true, findings: [], meta: { pluginId: 'dsh.smoke-plugin' } },
  })
  check('install 目标存在时拒绝覆盖', overwriteRefusal.installed === false)

  rmSync(tmpRoot, { recursive: true, force: true })

  const failed = results.filter((item) => !item.passed)
  const skipped = results.filter((item) => item.skipped)
  console.log(`\n${results.length - failed.length - skipped.length}/${results.length - skipped.length} 项通过${skipped.length ? `，${skipped.length} 项跳过` : ''}`)
  if (failed.length > 0) process.exitCode = 1
}

await main().catch((error) => {
  console.error('冒烟测试异常：', error)
  process.exitCode = 1
})
