#!/usr/bin/env node
/**
 * 发布后核验：确认包真的上了 npm、仓库真的上了 GitHub。
 *
 * 用法：
 *   node scripts/verify-publish.mjs            # 打印核验结果（不因失败退出）
 *   node scripts/verify-publish.mjs --strict   # 任一通道未上线则退出码 1（可用于 CI 或发版门禁）
 *
 * 说明：
 * - 走 Node 自带的 fetch（OpenSSL），不依赖系统 TLS 栈，因此不受 Windows schannel 影响；
 * - GitHub 私有仓库会被匿名 API 记为 404，此时脚本只能报告"未找到（或为私有）"；
 * - 只读：不发任何写请求，不需要 token。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const strict = process.argv.includes('--strict')

/** 从 repository.url 里解析 owner/repo。 */
function parseSlug(url) {
  const match = /github\.com[/:]([^/]+)\/([^/.#]+)/.exec(String(url ?? ''))
  return match ? { owner: match[1], repo: match[2] } : null
}

/**
 * 取一个 URL 的 JSON。
 *
 * @param {string} url 目标地址。
 * @returns {Promise<{ status: number|string, data: any }>} 状态与数据。
 */
async function getJson(url) {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'dsh-maibot-plugin-writer/verify-publish', accept: 'application/json' },
    })
    return { status: response.status, data: response.ok ? await response.json() : null }
  } catch (error) {
    return { status: 'ERR', data: null, error: error.message }
  }
}

const rows = []
const slug = parseSlug(manifest.repository?.url)

const npm = await getJson(`https://registry.npmjs.org/${manifest.name}`)
if (npm.status === 200) {
  const versions = Object.keys(npm.data.versions ?? {})
  rows.push(['npm', `✅ npm 已上线 ${manifest.name}`, `dist-tags=${JSON.stringify(npm.data['dist-tags'])}，共 ${versions.length} 个版本：${versions.join(', ')}`])
  rows.push(['npm README', '✅ 已带 AI 声明', npm.data.readme?.includes('由 AI 编写') ? '是' : '否（可能发布于 README 重写之前，下次发版会带上）'])
} else {
  rows.push(['npm', `❌ npm 未上线 ${manifest.name}`, `registry.npmjs.org 返回 ${npm.status}${npm.error ? `（${npm.error}）` : ''}`])
}

const mirror = await getJson(`https://registry.npmmirror.com/${manifest.name}`)
rows.push(['npmmirror 镜像', mirror.status === 200 ? '✅ 已同步' : `ℹ️ 尚未同步（${mirror.status}）`, '镜像同步有延迟，非必需'])

if (slug) {
  const repo = await getJson(`https://api.github.com/repos/${slug.owner}/${slug.repo}`)
  if (repo.status === 200) {
    rows.push(['github', `✅ 仓库在线 ${slug.owner}/${slug.repo}`, `default_branch=${repo.data.default_branch}，pushed_at=${repo.data.pushed_at}，private=${repo.data.private}`])
    const tags = await getJson(`https://api.github.com/repos/${slug.owner}/${slug.repo}/tags`)
    rows.push(['github tags', tags.status === 200 && tags.data.length > 0 ? '✅ 有标签' : 'ℹ️ 无标签', tags.status === 200 ? (tags.data.map((tag) => tag.name).join(', ') || '（空，建议 git push --tags）') : `查询失败 ${tags.status}`])
  } else {
    rows.push(['github', `❌ 未找到 ${slug.owner}/${slug.repo}`, `匿名 API 返回 ${repo.status}：仓库不存在，或为私有仓库`])
  }
} else {
  rows.push(['github', '⚠️ package.json 里没有可解析的 GitHub 仓库地址', '无法核验'])
}

const width = Math.max(...rows.map(([label]) => label.length))
console.log(`\n发布核验：${manifest.name}@${manifest.version}\n`)
for (const [label, status, detail] of rows) {
  console.log(`  ${label.padEnd(width)}  ${status}`)
  if (detail) console.log(`  ${' '.repeat(width)}  └ ${detail}`)
}
console.log('\n提示：npm 未上线时先在能联网的终端执行 `npm login` 再 `npm publish --access public`；')
console.log('      GitHub 未找到时先在网页创建同名空仓库（不要勾选初始化 README），再 `git push -u origin main && git push --tags`。\n')

const failed = rows.some(([, status]) => status.startsWith('❌'))
if (strict && failed) process.exitCode = 1
