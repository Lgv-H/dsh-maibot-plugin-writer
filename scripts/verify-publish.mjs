#!/usr/bin/env node
/**
 * 发布核验：确认远端仓库/标签与本地 HEAD 是否一致。
 *
 * 分发渠道是 GitHub；只有当 package.json 未标记 `private: true` 时才顺带检查 npm。
 *
 * 用法：
 *   node scripts/verify-publish.mjs            # 打印核验结果（不因失败退出）
 *   node scripts/verify-publish.mjs --strict   # 有 ❌ 则退出码 1（可用于 CI 或发版门禁）
 *
 * 说明：
 * - 走 Node 自带的 fetch（OpenSSL），不依赖系统 TLS 栈，因此不受 Windows schannel 影响；
 * - GitHub 私有仓库会被匿名 API 记为 404，此时只能报告"未找到（或为私有）"；
 * - 只读：不发任何写请求、不需要 token。
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const strict = process.argv.includes('--strict')

/**
 * 从 repository.url 里解析 owner/repo。
 *
 * @param {string} url 仓库地址。
 * @returns {{ owner: string, repo: string }|null} 解析结果。
 */
function parseSlug(url) {
  const match = /github\.com[/:]([^/]+)\/([^/.#]+)/.exec(String(url ?? ''))
  return match ? { owner: match[1], repo: match[2] } : null
}

/**
 * 取一个 URL 的 JSON。
 *
 * @param {string} url 目标地址。
 * @returns {Promise<{ status: number|string, data: any, error?: string }>} 状态与数据。
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

/**
 * 读取本地 git HEAD。
 *
 * @returns {string} 提交 SHA；不可用时返回空串。
 */
function localHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' })
  if (result.status !== 0) return ''
  return String(result.stdout ?? '').trim()
}

const rows = []
const slug = parseSlug(manifest.repository?.url)
const head = localHead()

if (manifest.private === true) {
  rows.push(['npm', 'ℹ️ 已声明不发布 npm（package.json private: true）', '跳过 npm 与镜像检查'])
} else {
  const npm = await getJson(`https://registry.npmjs.org/${manifest.name}`)
  if (npm.status === 200) {
    const versions = Object.keys(npm.data.versions ?? {})
    rows.push(['npm', `✅ npm 已上线 ${manifest.name}`, `dist-tags=${JSON.stringify(npm.data['dist-tags'])}，共 ${versions.length} 个版本：${versions.join(', ')}`])
    rows.push(['npm README', '✅ 已带 AI 声明', npm.data.readme?.includes('由 AI 编写') ? '是' : '否（下次发版会带上）'])
  } else {
    rows.push(['npm', `❌ npm 未上线 ${manifest.name}`, `registry.npmjs.org 返回 ${npm.status}${npm.error ? `（${npm.error}）` : ''}`])
  }
  const mirror = await getJson(`https://registry.npmmirror.com/${manifest.name}`)
  rows.push(['npmmirror 镜像', mirror.status === 200 ? '✅ 已同步' : `ℹ️ 尚未同步（${mirror.status}）`, '镜像同步有延迟，非必需'])
}

if (!slug) {
  rows.push(['github', '⚠️ package.json 里没有可解析的 GitHub 仓库地址', '无法核验'])
} else {
  const repo = await getJson(`https://api.github.com/repos/${slug.owner}/${slug.repo}`)
  if (repo.status !== 200) {
    rows.push(['github', `❌ 未找到 ${slug.owner}/${slug.repo}`, `匿名 API 返回 ${repo.status}：仓库不存在，或为私有仓库`])
  } else {
    rows.push(['github', `✅ 仓库在线 ${slug.owner}/${slug.repo}`, `default_branch=${repo.data.default_branch}，pushed_at=${repo.data.pushed_at}，visibility=${repo.data.visibility}`])

    const branch = repo.data.default_branch || 'main'
    const commit = await getJson(`https://api.github.com/repos/${slug.owner}/${slug.repo}/commits/${branch}`)
    if (commit.status === 200 && head) {
      const remoteHead = String(commit.data.sha ?? '')
      rows.push([
        '本地 vs 远端',
        remoteHead === head ? '✅ 一致' : '❌ 不一致（远端落后或有分叉，先 git push）',
        `本地 ${head.slice(0, 7)} / 远端 ${remoteHead.slice(0, 7)}`,
      ])
    } else if (head) {
      rows.push(['本地 vs 远端', `⚠️ 无法比较（远端查询 ${commit.status}）`, `本地 ${head.slice(0, 7)}`])
    }

    const tags = await getJson(`https://api.github.com/repos/${slug.owner}/${slug.repo}/tags`)
    rows.push([
      'github tags',
      tags.status === 200 && tags.data.length > 0 ? '✅ 有标签' : 'ℹ️ 无标签',
      tags.status === 200 ? (tags.data.map((tag) => tag.name).join(', ') || '（空，建议 git push --tags）') : `查询失败 ${tags.status}`,
    ])
  }
}

const width = Math.max(...rows.map(([label]) => label.length))
console.log(`\n发布核验：${manifest.name}@${manifest.version}\n`)
for (const [label, status, detail] of rows) {
  console.log(`  ${label.padEnd(width)}  ${status}`)
  if (detail) console.log(`  ${' '.repeat(width)}  └ ${detail}`)
}
console.log('\n提示：本地与远端不一致时先 `git push origin main --tags`；')
console.log('      GitHub 未找到时先创建同名空仓库（不要勾选初始化 README），再 `git push -u origin main`。\n')

if (strict && rows.some(([, status]) => status.startsWith('❌'))) process.exitCode = 1
