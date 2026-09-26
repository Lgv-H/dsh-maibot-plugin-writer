# Changelog

本文件记录用户可见的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

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
