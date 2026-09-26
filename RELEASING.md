# 发版流程（维护者）

本插件**只通过 GitHub 分发，不发布到 npm**（`package.json` 里 `private: true` 会阻止 `npm publish`）。
面向使用者的获取/更新说明在 [README.md](README.md) 的「版本与更新」章节，本文件只写维护者做的事。

## 1. 发版前检查

```sh
npm test              # 33 项零依赖单元测试
npm run test:smoke    # 24 项真实宿主冒烟测试（找不到 MaiBot 会标 SKIP 而不是假装通过）
npm pack --dry-run    # 需要 tarball 分发时，确认产物清单
```

## 2. 更新版本号与变更日志

- 改 `package.json` 的 `version`（严格三段式 `x.y.z`）；
- 在 [CHANGELOG.md](CHANGELOG.md) 把 `## [未发布]` 改成 `## [x.y.z] - YYYY-MM-DD`，并新开一个空的 `## [未发布]`。

> ⚠️ **不要用 PowerShell 的 `Get-Content` / `Set-Content` 往返中文 JSON**：Windows PowerShell 5.1 会按系统编码（GBK）解码无 BOM 的 UTF-8 文件，导致中文变成乱码并写回。
> 请用编辑器直接改，或 `node -e` / 带 `-Encoding UTF8` 且显式读写 UTF-8 的方式（本仓库曾因此把 `description` 写成乱码，见 CHANGELOG 的修复记录）。

## 3. 提交、打标签、推送

```sh
git add -A
git commit -m "release: vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main --tags
```

标签一旦推送就不要移动或删除，否则使用者 `git checkout vX.Y.Z` 拿到的内容会与 Release 说明不符。发错了就发下一个补丁版本。

## 4. 发布核验

```sh
npm run verify            # 或 node scripts/verify-publish.mjs
npm run verify -- --strict   # 有 ❌ 时退出码 1，可作发版门禁
```

它会检查：远端仓库可见性与默认分支、`本地 HEAD` 与远端是否一致（抓"忘记 push"）、标签列表；`private: true` 时自动跳过 npm 检查。

## 5. 建 GitHub Release

Releases → Draft a new release → 选择刚推的标签 → 标题用 `vX.Y.Z`，正文直接粘贴 [CHANGELOG.md](CHANGELOG.md) 里该版本的段落。

## 6. 仓库元数据（首次发布或定位变化时）

- **Description**：一句话说明插件做什么 + 声明由 AI 编写；
- **Topics**：`dsh-plugin`、`deepseek-harness`、`maibot`、`maimai`、`cordis`、`plugin-generator`、`ai-generated` —— 插件市场按此检索 GitHub 生态。

## 7. tarball 分发（可选）

`private: true` 只禁止发布，不影响打包：

```sh
npm pack        # 产出 dsh-maibot-plugin-writer-X.Y.Z.tgz
```

使用者可对它执行 `dsh plugin --profile web add file:<tgz 绝对路径>`。

## 8. 使用者侧生效路径

使用者更新后需要重启 profile 的服务才会加载新代码；仓库检出用户用 `node scripts/deploy-local.mjs --profile web --force` 同步。
发布后如果你在本机验证，记得同样跑一次这个同步命令，否则本机跑的仍是旧副本。
