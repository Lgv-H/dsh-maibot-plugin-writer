# 安全说明

## 这个插件会做什么

DSH 插件运行在 Harness 主进程里，本插件的权限面如下：

| 行为 | 位置 | 触发方式 |
|---|---|---|
| 读 MaiBot 源码（能力注册表、插件目录、`_manifest.json`、`plugin.py`） | `<maibotRoot>/src/plugin_runtime/**`、`<maibotRoot>/plugins/**` | 工具调用 |
| 读已安装的 `maibot_sdk` | `<python-env>/Lib/site-packages/maibot_sdk/**` | 工具调用 |
| 写插件三件套 | `maibot_plugin_scaffold` 的目标目录（默认 `<maibotRoot>/plugins/<id>`） | 显式调用 |
| 复制插件进插件目录、改 `[plugin].enabled` | `<maibotRoot>/plugins/<dirName>` | 显式调用 `maibot_plugin_install` |
| 投放随包 skill | `<dshHome>/skills/maibot-plugin-writer` | 插件加载时（可用 `syncSkill: false` 关闭） |
| 起子进程跑 AST 探针 | 本地 Python 解释器 + `lib/ast_probe.py` | 校验时（只为解析代码，不执行插件代码） |

不联网、不读凭据、不执行被校验插件的代码——`maibot_plugin_validate` 只做静态解析与文本规则判定。
`maibot_plugin_install` 默认保持 `enabled = false`，是否真正启用由用户决定。

## 已知边界

- 静态校验不能替代代码审查：它能保证「符合宿主契约、能力声明一致、语法与结构正确」，不能判断业务逻辑是否安全或正确。
- 被生成的插件一旦被启用，会以 MaiBot 插件身份在插件运行时里执行，其风险由生成内容决定；请在私有/测试聊天流里先观察。
- 本插件会写会话工作区之外的路径（`<maibotRoot>/plugins`、`<dshHome>/skills`），这是其功能本身所需。

## 报告问题

请通过仓库的 Issues 反馈：<https://github.com/Lgv-H/dsh-maibot-plugin-writer/issues>。
涉及权限面变更的改动会在 CHANGELOG 中显式标注。
