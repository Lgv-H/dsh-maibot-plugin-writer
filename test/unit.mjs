/**
 * 单元测试：只依赖 Node 标准库与仓库自身代码，不需要 MaiBot、不需要 npm install。
 *
 * 运行：npm test  /  node test/unit.mjs
 *
 * 覆盖：TOML 读写、脚手架模板、校验器规则（用 stub 宿主）、安装流程、参考文本、
 * 路径解析、宿主探测解析器、随包 skill 投放。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadCapabilities, loadCtxMembers, loadSdkMethods } from '../lib/host.js'
import { installPlugin } from '../lib/install.js'
import { detectMaibotRoot, isMaibotRoot, resolveMaibotRoot, resolveUserPath } from '../lib/paths.js'
import { buildReference } from '../lib/reference.js'
import { syncBundledSkill } from '../lib/skill.js'
import { buildPluginFiles, PLUGIN_ID_PATTERN } from '../lib/templates.js'
import { getValue, listSections, parseToml, setPluginEnabled } from '../lib/toml.js'
import { validatePlugin } from '../lib/validate.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmpRoot = join(packageRoot, '.tmp-unit')

/** stub 宿主事实：单元测试不依赖真实 MaiBot。 */
const STUB_HOST = {
  capabilities: ['api.call', 'api.replace_dynamic', 'config.get', 'send.image', 'send.text'],
  source: '<stub registry.py>',
  sdkVersion: '0.0.0-stub',
  sdkMethods: new Map([
    ['api.call', 'api.call'],
    ['config.get', 'config.get'],
    ['send.image', 'send.image'],
    ['send.text', 'send.text'],
    ['frequency.get_current_talk_value', 'frequency.get_current_talk_value'],
  ]),
  byGroup: new Map([
    ['api', ['call']],
    ['config', ['get']],
    ['frequency', ['get_current_talk_value']],
    ['send', ['image', 'text']],
  ]),
  ctxMembers: new Set(['api', 'config', 'frequency', 'logger', 'paths', 'plugin_id', 'send']),
}

/** 单元测试不做 AST 深检。 */
const STUB_PYTHON = { path: '', source: '单元测试', reason: '单元测试只跑文本级规则' }

const results = []

/**
 * 断言条件成立。
 *
 * @param {boolean} condition 条件。
 * @param {string} message 失败信息。
 */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * 断言相等。
 *
 * @param {unknown} actual 实际值。
 * @param {unknown} expected 期望值。
 * @param {string} message 失败信息。
 */
function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

/**
 * 断言抛错（可校验错误信息片段）。
 *
 * @param {Function} fn 待执行函数。
 * @param {string} [pattern] 错误信息需包含的片段。
 * @param {string} [message] 未抛错时的失败信息。
 */
function assertThrows(fn, pattern = '', message = '期望抛错但没有') {
  try {
    fn()
  } catch (error) {
    if (pattern && !String(error.message).includes(pattern)) {
      throw new Error(`${message}：错误信息不含 "${pattern}"，实际为 "${error.message}"`)
    }
    return
  }
  throw new Error(message)
}

/**
 * 注册并执行一个用例。
 *
 * @param {string} title 用例名。
 * @param {Function} fn 用例体。
 */
function test(title, fn) {
  try {
    fn()
    results.push({ title, ok: true })
    console.log(`PASS  ${title}`)
  } catch (error) {
    results.push({ title, ok: false, error: error.message })
    console.log(`FAIL  ${title} — ${error.message}`)
  }
}

/**
 * 把三件套写到目录。
 *
 * @param {string} dir 目标目录。
 * @param {{ [name: string]: string }} files 文件内容。
 */
function writePlugin(dir, files) {
  mkdirSync(dir, { recursive: true })
  for (const [fileName, content] of Object.entries(files)) {
    writeFileSync(join(dir, fileName), content, 'utf8')
  }
}

/**
 * 生成一份合法插件文件，并按需替换片段。
 *
 * @param {{ [name: string]: [string, string] }} [mutations] 文件名 → [被替换文本, 新文本]。
 * @returns {{ [name: string]: string }} 三件套内容。
 */
function pluginFiles(mutations = {}) {
  const built = buildPluginFiles({ pluginId: 'tester.sample-plugin', name: '示例插件', description: '单元测试夹具' })
  const files = { ...built.files }
  for (const [fileName, [from, to]] of Object.entries(mutations)) {
    assert(files[fileName]?.includes(from), `夹具替换失败：${fileName} 中找不到 ${JSON.stringify(from)}`)
    files[fileName] = files[fileName].replace(from, to)
  }
  return files
}

/**
 * 用 stub 宿主校验一个夹具。
 *
 * @param {{ [name: string]: string }} files 三件套。
 * @param {object} [options] 额外选项。
 * @returns {object} 校验结果。
 */
function runValidate(files, options = {}) {
  const dir = join(tmpRoot, `case-${Math.random().toString(36).slice(2, 8)}`)
  writePlugin(dir, files)
  return validatePlugin({
    dir,
    host: options.host ?? STUB_HOST,
    python: STUB_PYTHON,
    installedPlugins: options.installedPlugins ?? [],
  })
}

/**
 * 收集校验结果里的规则码。
 *
 * @param {object} validation 校验结果。
 * @returns {Set<string>} 规则码集合。
 */
function codes(validation) {
  return new Set(validation.findings.map((item) => item.code))
}

rmSync(tmpRoot, { recursive: true, force: true })
mkdirSync(tmpRoot, { recursive: true })

// ── TOML ──────────────────────────────────────────────────────────────
test('toml: 解析段与值', () => {
  const parsed = parseToml('[plugin]\nenabled = false\nconfig_version = "0.1.0"\n\n[reply]\ntext = "你好"  # 注释\n')
  assertEqual(getValue(parsed, 'plugin', 'enabled'), false, 'enabled')
  assertEqual(getValue(parsed, 'plugin', 'config_version'), '0.1.0', 'config_version')
  assertEqual(getValue(parsed, 'reply', 'text'), '你好', 'reply.text')
  assertEqual(listSections(parsed).join(','), 'plugin,reply', '段列表')
})

test('toml: 重复键报错带行号', () => {
  assertThrows(() => parseToml('[plugin]\nenabled = false\nenabled = true\n'), '第 3 行', '重复键')
})

test('toml: 不支持的值报错', () => {
  assertThrows(() => parseToml('[plugin]\nenabled = maybe\n'), '不支持的取值', '非法值')
})

test('toml: 重复段会被记录', () => {
  const parsed = parseToml('[plugin]\nenabled = false\n[plugin]\n')
  assertEqual(parsed.duplicatedSections.join(','), 'plugin', '重复段')
})

test('toml: setPluginEnabled 改写既有键', () => {
  const next = setPluginEnabled('[plugin]\n# 注释保留\nenabled = false\n\n[reply]\ntext = "x"\n', true)
  assert(next.includes('enabled = true'), '应改成 true')
  assert(next.includes('# 注释保留'), '应保留注释')
  assert(next.includes('[reply]'), '应保留其它段')
})

test('toml: setPluginEnabled 在缺少段时补 [plugin]', () => {
  const next = setPluginEnabled('[reply]\ntext = "x"\n', false)
  assert(next.includes('[plugin]'), '应补段')
  assert(/\[plugin\]\s*\n\s*enabled = false/.test(next), '应写入 enabled')
})

// ── 脚手架 ────────────────────────────────────────────────────────────
test('templates: 生成内容满足宿主 manifest 约束', () => {
  const built = buildPluginFiles({ pluginId: 'tester.sample-plugin' })
  const manifest = JSON.parse(built.files['_manifest.json'])
  assertEqual(manifest.manifest_version, 2, 'manifest_version')
  assertEqual(manifest.id, 'tester.sample-plugin', 'id')
  assert(/^https?:\/\//.test(manifest.author.url), 'author.url 必须是 URL')
  assert(/^https?:\/\//.test(manifest.urls.repository), 'urls.repository 必须是 URL')
  assertEqual(manifest.dependencies.length, 0, 'dependencies')
  assertEqual(built.dirName, 'tester_sample-plugin', 'dirName')
  assert(built.files['config.toml'].includes('enabled = false'), '默认禁用')
  assert(built.files['plugin.py'].includes('def create_plugin()'), '必须有 create_plugin')
  assert(built.files['plugin.py'].includes('from __future__ import annotations'), '应有 future annotations')
})

test('templates: 作者段含连字符时推导正确', () => {
  const built = buildPluginFiles({ pluginId: 'lgv-h.private-message-tool' })
  const manifest = JSON.parse(built.files['_manifest.json'])
  assertEqual(built.dirName, 'lgv-h_private-message-tool', 'dirName')
  assertEqual(built.pluginClass, 'PrivateMessageTool', '类名应取点号后的完整名称')
  assertEqual(manifest.author.url, 'https://github.com/lgv-h', 'author.url 不应被连字符拆坏')
  assertEqual(manifest.urls.repository, 'https://github.com/lgv-h/private-message-tool', 'repository 同理')
  assert(built.files['plugin.py'].includes('class PrivateMessageTool(MaiBotPlugin)'), '类名应写进代码')
  assert(built.files['plugin.py'].includes('class PrivateMessageToolConfig(PluginConfigBase)'), '聚合配置类名同理')
})

test('templates: 非法 ID 直接报错', () => {
  assertThrows(() => buildPluginFiles({ pluginId: 'NoDot' }), '插件 ID 不合法', '缺分隔符')
  assertThrows(() => buildPluginFiles({ pluginId: 'a..b' }), '插件 ID 不合法', '连续分隔符')
  assert(PLUGIN_ID_PATTERN.test('a.b-c_d'), '合法 ID 应通过')
})

test('templates: 命令名会被规范化', () => {
  const built = buildPluginFiles({ pluginId: 'a.b', command: '/Hello World!' })
  assert(built.files['plugin.py'].includes('@Command("Hello-World"'), '应去掉斜杠与非法字符')
})

// ── 校验器 ────────────────────────────────────────────────────────────
test('validate: 合法插件 0 error', () => {
  const validation = runValidate(pluginFiles())
  assertEqual(validation.ok, true, `应通过，实际问题：${JSON.stringify(validation.findings)}`)
  assert(validation.meta.capabilitiesUsed.includes('send.text'), '应识别出 send.text')
})

test('validate: 识别 message.get("plain_text")', () => {
  const validation = runValidate(pluginFiles({
    'plugin.py': ['        del kwargs\n', '        del kwargs\n        _ = message.get("plain_text")\n'],
  }))
  assert(codes(validation).has('python.plain_text_key'), '应报 plain_text 键不存在')
})

test('validate: 识别 self.logger', () => {
  const validation = runValidate(pluginFiles({
    'plugin.py': ['self.ctx.logger.info', 'self.logger.info'],
  }))
  assert(codes(validation).has('python.self_logger'), '应报 self.logger')
})

test('validate: 识别 blocked 缺 intercept_message', () => {
  const onUnload = '    async def on_unload(self) -> None:\n        """插件卸载时释放资源。"""\n'
  const handlerBody = (decorator) => [
    onUnload,
    `${decorator}\n`
      + '    async def handle_guard(self, message: dict | None = None, **kwargs: object):\n'
      + '        del kwargs\n'
      + '        if not message or message.get("is_command"):\n'
      + '            return {"continue_processing": True}\n'
      + '        if not (message.get("processed_plain_text") or "").strip():\n'
      + '            return {"blocked": True}\n'
      + '        return {"continue_processing": True}\n'
      + '\n'
      + onUnload,
  ]

  const missing = runValidate(pluginFiles({
    'plugin.py': handlerBody('    @EventHandler("guard", description="空消息守卫", event_type=EventType.ON_MESSAGE)'),
  }))
  assert(codes(missing).has('component.event_blocked_without_intercept'), '应报拦截契约')

  const explicit = runValidate(pluginFiles({
    'plugin.py': handlerBody('    @EventHandler("guard", description="空消息守卫", event_type=EventType.ON_MESSAGE, intercept_message=True)'),
  }))
  assert(!codes(explicit).has('component.event_blocked_without_intercept'), '写了 intercept_message=True 不应报错')
})

test('validate: 能力用了没声明', () => {
  const validation = runValidate(pluginFiles({
    'plugin.py': ['    async def on_load(self) -> None:\n        """插件加载时初始化资源。"""\n',
      '    async def on_load(self) -> None:\n        """插件加载时初始化资源。"""\n'
        + '        await self.ctx.send.image("", "")\n'],
  }))
  assert(codes(validation).has('capability.used_undeclared'), '应报未声明能力')
})

test('validate: 能力声明了不存在', () => {
  const validation = runValidate(pluginFiles({
    '_manifest.json': ['"capabilities": [\n    "send.text"\n  ]', '"capabilities": [\n    "send.text",\n    "llm.generate"\n  ]'],
  }))
  assert(codes(validation).has('manifest.capability_unknown'), '应报未注册能力')
})

test('validate: 未知 manifest 字段', () => {
  const validation = runValidate(pluginFiles({
    '_manifest.json': ['  "i18n": {', '  "extra_field": 1,\n  "i18n": {'],
  }))
  assert(codes(validation).has('manifest.unknown_field'), '应报未知字段')
})

test('validate: repository 必须是 http(s) URL', () => {
  const validation = runValidate(pluginFiles({
    '_manifest.json': ['"repository": "https://github.com/tester/sample-plugin"', '"repository": "not-a-url"'],
  }))
  assert(codes(validation).has('manifest.repository'), '应报 URL 非法')
})

test('validate: 版本号必须三段式', () => {
  const validation = runValidate(pluginFiles({
    '_manifest.json': ['"version": "0.1.0"', '"version": "0.1"'],
  }))
  assert(codes(validation).has('manifest.version_invalid'), '应报版本号非法')
})

test('validate: 依赖类型只接受 plugin / python_package', () => {
  const validation = runValidate(pluginFiles({
    '_manifest.json': ['"dependencies": []', '"dependencies": [\n    {"type": "pip", "name": "requests", "version_spec": ">=2"}\n  ]'],
  }))
  assert(codes(validation).has('dependency.type'), '应报依赖类型非法')
})

test('validate: 缺 [plugin] 段报错（宿主会当成启用）', () => {
  const validation = runValidate(pluginFiles({
    'config.toml': ['[plugin]\n# 宿主只激活 enabled = true 的插件；新插件默认关闭，确认无误后再手动开启。\nenabled = false\nconfig_version = "0.1.0"\n\n',
      ''],
  }))
  assert(codes(validation).has('config.missing_plugin_section'), '应报缺 [plugin] 段')
})

test('validate: @WorkflowStep 已移除', () => {
  const validation = runValidate(pluginFiles({
    'plugin.py': ['    @Command(', '    @WorkflowStep("x")\n    @Command('],
  }))
  assert(codes(validation).has('component.workflow_step_removed'), '应报 WorkflowStep 已移除')
})

test('validate: 不存在的 ctx 方法', () => {
  const validation = runValidate(pluginFiles({
    'plugin.py': ['        del kwargs\n', '        del kwargs\n        await self.ctx.frequency.check(stream_id, 1, 1)\n'],
  }))
  assert(codes(validation).has('capability.method_unknown'), '应报方法不存在')
})

test('validate: 重复插件 ID', () => {
  const validation = runValidate(pluginFiles(), {
    installedPlugins: [{ id: 'tester.sample-plugin', dir: join(tmpRoot, 'elsewhere') }],
  })
  assert(codes(validation).has('plugin.duplicate_id'), '应报 ID 冲突')
})

test('validate: 缺文件时报错', () => {
  const dir = join(tmpRoot, 'missing-files')
  mkdirSync(dir, { recursive: true })
  const validation = validatePlugin({ dir, host: STUB_HOST, python: STUB_PYTHON })
  assertEqual(validation.ok, false, '缺文件应不通过')
  assert(codes(validation).has('files.missing_manifest'), '应报缺 manifest')
  assert(codes(validation).has('files.missing_plugin_py'), '应报缺 plugin.py')
  assert(codes(validation).has('files.missing_config'), '应报缺 config.toml')
})

// ── 安装 ──────────────────────────────────────────────────────────────
test('install: 复制进 plugins/ 且保持禁用', () => {
  const source = join(tmpRoot, 'install-src')
  writePlugin(source, pluginFiles())
  const root = join(tmpRoot, 'fake-maibot')
  mkdirSync(join(root, 'plugins'), { recursive: true })
  const validation = validatePlugin({ dir: source, host: STUB_HOST, python: STUB_PYTHON })

  const result = installPlugin({ sourceDir: source, maibotRoot: root, overwrite: false, enable: false, validation })
  assertEqual(result.installed, true, '应安装成功')
  assertEqual(result.dirName, 'tester_sample-plugin', '默认目录名')
  assertEqual(result.enabled, false, '应保持禁用')
  assert(readFileSync(join(result.target, 'config.toml'), 'utf8').includes('enabled = false'), 'config 应禁用')

  const again = installPlugin({ sourceDir: source, maibotRoot: root, overwrite: false, enable: false, validation })
  assertEqual(again.installed, false, '目标已存在应拒绝')
  assert(again.message.includes('overwrite'), '应提示 overwrite')

  const forced = installPlugin({ sourceDir: source, maibotRoot: root, overwrite: true, enable: true, validation })
  assertEqual(forced.installed, true, '覆盖应成功')
  assertEqual(forced.enabled, true, '应被启用')
})

test('install: 校验不通过时拒绝安装', () => {
  const source = join(tmpRoot, 'install-bad')
  writePlugin(source, pluginFiles())
  const root = join(tmpRoot, 'fake-maibot-2')
  mkdirSync(join(root, 'plugins'), { recursive: true })
  const validation = validatePlugin({ dir: source, host: STUB_HOST, python: STUB_PYTHON })
  validation.ok = false
  const result = installPlugin({ sourceDir: source, maibotRoot: root, validation })
  assertEqual(result.installed, false, '应拒绝')
  assert(!existsSync(join(root, 'plugins', 'tester_sample-plugin')), '不应产生目标目录')
})

test('install: 目录名不合法时报错', () => {
  const source = join(tmpRoot, 'install-bad-name')
  writePlugin(source, pluginFiles())
  const root = join(tmpRoot, 'fake-maibot-3')
  mkdirSync(join(root, 'plugins'), { recursive: true })
  const validation = validatePlugin({ dir: source, host: STUB_HOST, python: STUB_PYTHON })
  assertThrows(
    () => installPlugin({ sourceDir: source, maibotRoot: root, dirName: '..\\evil', validation }),
    '目标目录名不合法',
    '路径穿越应被拒',
  )
})

// ── 参考文本 ──────────────────────────────────────────────────────────
test('reference: 各主题都有内容', () => {
  const maibot = { root: 'C:\\fake\\MaiBot', source: '测试' }
  for (const topic of ['overview', 'capabilities', 'methods', 'components', 'messages', 'config', 'pitfalls', 'all']) {
    const text = buildReference(topic, STUB_HOST, maibot)
    assert(text.length > 100, `${topic} 内容过短`)
  }
  assert(buildReference('methods', STUB_HOST, maibot).includes('ctx.send.text'), 'methods 应含 ctx.send.text')
  assert(buildReference('capabilities', STUB_HOST, maibot).includes('send.text'), 'capabilities 应含 send.text')
  assert(buildReference('乱写', STUB_HOST, maibot).includes('宿主加载规则'), '未知主题应回落 overview')
})

// ── 路径 ──────────────────────────────────────────────────────────────
test('paths: 相对路径基于基准目录解析', () => {
  assertEqual(resolveUserPath('sub/dir', 'C:\\base'), resolve('C:\\base', 'sub', 'dir'), '相对路径')
  assertThrows(() => resolveUserPath('   '), '路径为空', '空路径应报错')
})

test('paths: 向上探测与显式报错', () => {
  const root = join(tmpRoot, 'detect', 'MaiBot')
  mkdirSync(join(root, 'src', 'plugin_runtime', 'capabilities'), { recursive: true })
  mkdirSync(join(root, 'plugins'), { recursive: true })
  writeFileSync(join(root, 'src', 'plugin_runtime', 'capabilities', 'registry.py'), '_register("send.text", x)\n', 'utf8')
  assertEqual(isMaibotRoot(root), true, '应识别为 MaiBot 根')
  assertEqual(detectMaibotRoot(join(root, 'src', 'plugin_runtime')), root, '应向上探测到根')
  assertThrows(() => resolveMaibotRoot({}, join(tmpRoot, '不存在')), '不是 MaiBot 源码根', '显式非法路径应报错')
})

// ── 宿主探测 ──────────────────────────────────────────────────────────
test('host: 解析能力注册表与 SDK 方法表', () => {
  const root = join(tmpRoot, 'host-root')
  mkdirSync(join(root, 'src', 'plugin_runtime', 'capabilities'), { recursive: true })
  mkdirSync(join(root, 'plugins'), { recursive: true })
  writeFileSync(
    join(root, 'src', 'plugin_runtime', 'capabilities', 'registry.py'),
    '_register("send.text", a)\n_register("emoji.get_random", b)\n',
    'utf8',
  )
  const capabilities = loadCapabilities(root)
  assertEqual(capabilities.capabilities.includes('send.text'), true, '应包含 send.text')
  assertEqual(capabilities.capabilities.includes('emoji.get_random'), true, '应包含 emoji.get_random')
  assertEqual(capabilities.capabilities.includes('api.replace_dynamic'), true, '应包含 always-allowed 能力')

  const pythonEnv = join(tmpRoot, 'site-packages')
  mkdirSync(join(pythonEnv, 'maibot_sdk', 'capabilities'), { recursive: true })
  writeFileSync(join(pythonEnv, 'maibot_sdk', '__init__.py'), '__version__ = "9.9.9"\n', 'utf8')
  writeFileSync(
    join(pythonEnv, 'maibot_sdk', 'capabilities', 'send.py'),
    'class Send:\n    async def text(self, text, stream_id):\n        return await self._ctx.call_capability(\n            "send.text",\n            text=text,\n        )\n',
    'utf8',
  )
  writeFileSync(
    join(pythonEnv, 'maibot_sdk', 'capabilities', 'render.py'),
    'class Render:\n    async def html2png(self, html):\n        capability = "render.html2png"\n        return await self._ctx.call_host_method("cap.call", payload={"capability": capability})\n',
    'utf8',
  )
  writeFileSync(
    join(pythonEnv, 'maibot_sdk', 'context.py'),
    'class Ctx:\n    def __init__(self):\n        self._logger = None\n\n    @property\n    def logger(self):\n        return self._logger\n',
    'utf8',
  )

  const methods = loadSdkMethods(pythonEnv)
  assertEqual(methods.methods.get('send.text'), 'send.text', 'call_capability 形式')
  assertEqual(methods.methods.get('render.html2png'), 'render.html2png', 'payload 变量形式')
  assertEqual(methods.byGroup.get('send').join(','), 'text', 'byGroup')
  assert(loadCtxMembers(pythonEnv).has('logger'), 'ctx 成员应含 logger')
})

// ── skill 投放 ────────────────────────────────────────────────────────
test('skill: 投放到 <dshHome>/skills 且可关闭', () => {
  const dshHome = join(tmpRoot, 'dsh-home')
  const synced = syncBundledSkill({ dshHome, syncSkill: true })
  assertEqual(synced.synced, true, '应投放成功')
  assert(existsSync(join(dshHome, 'skills', 'maibot-plugin-writer', 'SKILL.md')), 'SKILL.md 应存在')
  assert(existsSync(join(dshHome, 'skills', 'maibot-plugin-writer', '.bundled-by.json')), '应写版本标记')

  const skipped = syncBundledSkill({ dshHome, syncSkill: false })
  assertEqual(skipped.synced, false, '关闭时应跳过')
})

// ── 离线部署脚本 ──────────────────────────────────────────────────────
test('deploy-local: 装进 profile 并登记依赖/bundles/链接', () => {
  // 假 profile 必须放在包目录之外：cpSync 不允许把目录复制进自身子目录
  const profileDir = join(tmpdir(), `dsh-maibot-plugin-writer-unit-${process.pid}`, 'fake-profile')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(
    join(profileDir, 'package.json'),
    `${JSON.stringify({
      name: 'dsh-profile-test',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], patchReload: 'live' } },
    }, null, 2)}\n`,
    'utf8',
  )

  const script = join(packageRoot, 'scripts', 'deploy-local.mjs')
  const first = spawnSync(process.execPath, [script, '--profile-dir', profileDir], { encoding: 'utf8' })
  assertEqual(first.status, 0, `首次部署应成功：${first.stderr || first.stdout}`)

  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert(String(manifest.dependencies['dsh-maibot-plugin-writer']).startsWith('link:'), '应登记 link 依赖')
  assert(manifest.dsh.profile.bundles.includes('dsh-maibot-plugin-writer'), '应加入 bundles')
  assert(existsSync(join(profileDir, 'plugins', 'dsh-maibot-plugin-writer', 'lib', 'index.js')), '应复制包内容')
  assert(existsSync(join(profileDir, 'node_modules', 'dsh-maibot-plugin-writer')), '应建立 node_modules 链接')
  assert(!existsSync(join(profileDir, 'plugins', 'dsh-maibot-plugin-writer', '.tmp-unit')), '不应复制临时目录')

  const second = spawnSync(process.execPath, [script, '--profile-dir', profileDir], { encoding: 'utf8' })
  assertEqual(second.status === 0, false, '未加 --force 时重复部署应失败')

  const forced = spawnSync(process.execPath, [script, '--profile-dir', profileDir, '--force'], { encoding: 'utf8' })
  assertEqual(forced.status, 0, `--force 应可重复部署：${forced.stderr || forced.stdout}`)

  rmSync(dirname(profileDir), { recursive: true, force: true })
})

rmSync(tmpRoot, { recursive: true, force: true })

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 项通过`)
if (failed.length > 0) {
  console.log('失败用例：')
  for (const item of failed) console.log(`  - ${item.title}: ${item.error}`)
  process.exitCode = 1
}
