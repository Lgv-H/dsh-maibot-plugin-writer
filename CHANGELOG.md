# Changelog

本文件记录用户可见的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 变更

- 分发渠道确定为 GitHub 单渠道：README（中英）的安装章节移除 npm 安装方式，改为「git clone + link 安装 / 离线脚本 / 市场 GitHub 来源」
- `package.json` 增加 `private: true`，阻止误发 npm（需要正式发包时删掉该字段即可）

### 修复

- 修复 `package.json` 的 `description` 被写成乱码：此前用 PowerShell 重写该文件时按系统编码解码导致，现已恢复为正确的中文描述并统一 2 空格 JSON 格式

### 工具

- 新增 scripts/verify-publish.mjs：核验远端仓库/标签与本地 HEAD 是否一致（`--strict` 可作发版门禁）
- `verify-publish.mjs` 在 `private: true` 时跳过 npm 检查，只核验 GitHub 渠道
- 新增 `npm run verify` 入口

### 文档

- README 的「发布」章节改写为面向使用者的「版本与更新」（当前版本、Releases / CHANGELOG 入口、更新步骤、固定版本），维护者发版流程拆到新增的 [RELEASING.md](RELEASING.md)
- README 重写为 DSH 插件通用结构（这是什么 / 核心能力 / 安装 / 快速开始 / 配置 / 权限与数据披露 / 兼容性 / 测试与验证 / 已知限制 / 故障排查 / 开发 / 版本与更新），并新增「AI 编写声明」
- 新增英文镜像 README.en.md，package.json 发布白名单同步加入
- 故障排查表补充「更新到最新版」一条

## [0.1.0] - 2026-09-26

### 新增

- DSH 插件：向 agent 注册 5 个麦麦（MaiBot）插件开发工具
  - `maibot_plugin_catalog`：列出现有插件与宿主能力目录
  - `maibot_sdk_reference`：按主题返回当前宿主的插件开发契约（overview / capabilities / methods / components / messages / config / pitfalls / all）
  - `maibot_plugin_scaffold`：生成通过宿主 manifest 校验的插件三件套
  - `maibot_plugin_validate`：静态校验 manifest / config / plugin.py，能力声明与代码调用交叉核对
  - `maibot_plugin_install`：校验通过后复制进 `plugins/` 并设置启用开关
- 随包 skill `maibot-plugin-writer`：加载时投放到 `<dshHome>/skills`，给出工作流与硬性契约
- 事实化数据源：能力白名单读宿主 `registry.py`，`ctx.*` 方法表扫 `maibot_sdk/capabilities/*.py`，
  manifest 规则对齐宿主 `manifest_validator.py`，事件契约对齐 `event_dispatcher.py` / `message_utils.py`
- Python AST 深检（可选）：语法、导入、调用链、类结构、`open()` 模式
- MaiBot 根目录多级解析：工具参数 → 插件配置 → 环境变量 → 工作目录向上探测 → 常见安装位置自动发现
- 离线可用的本地部署脚本 `scripts/deploy-local.mjs`（不依赖 pnpm 联网）
- 单元测试（不依赖 MaiBot）与真实宿主冒烟测试
