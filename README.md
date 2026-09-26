# dsh-maibot-plugin-writer

> Let DSH (DeepSeek Harness) write MaiBot plugins by itself — with the host's real contract and a validation gate.
> 让 **DSH 自己写麦麦（MaiBot）插件**：读当前宿主的真实契约 → 生成骨架 → 校验到 0 error → 安装。

[![ci](https://github.com/Lgv-H/dsh-maibot-plugin-writer/actions/workflows/ci.yml/badge.svg)](https://github.com/Lgv-H/dsh-maibot-plugin-writer/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

本插件给 DSH 的 agent 装上 5 个工具和 1 个 skill，把「麦麦插件开发」从"凭记忆写 SDK"变成一条可校验的流水线。

## 为什么需要它

MaiBot 的插件契约细节多、版本内演进快，凭记忆写经常踩：

- `_manifest.json` 是 `extra="forbid"` 的强类型模型：多一个字段、版本号不是 `x.y.z`、`author.url` 不是 http(s) URL 都会直接加载失败；
- 能力（capabilities）是宿主授权层的白名单：代码用了但没声明 → 运行时被拒；声明了宿主没注册的名字 → manifest 校验失败；
- SDK 接口会变（例如 `ctx.frequency.check` / `ctx.person.get` / `ctx.render.render` 在当前 SDK 里并不存在）；
- `@EventHandler` 默认 `intercept_message=False`，返回值会被丢弃；ON_MESSAGE 事件拿不到 `stream_id`，消息字典里也没有 `plain_text` 键；
- 插件目录必须正好在 `plugins/` 下一层，且只有 `[plugin].enabled = true` 才会被加载。

`maibot_plugin_validate` 把上述规则全部静态检查一遍，并在能拿到 Python 时用 AST 深检语法/导入/调用链/类结构，把问题暴露在交付之前。

## 安装

```sh
# 从 npm（或插件市场）
dsh plugin --profile web add dsh-maibot-plugin-writer

# 从本仓库目录（开发用）
dsh plugin --profile web add link:/path/to/dsh-maibot-plugin-writer

# 无网络环境（仓库检出用户可用；等价于上面的 link 安装，不依赖 pnpm 联网）
node scripts/deploy-local.mjs --profile web
```

安装/更新后需要重启一次该 profile 的服务。随包 skill 由文件监视器热加载，无需重启即可被新会话看到。

卸载：

```sh
dsh plugin --profile web remove dsh-maibot-plugin-writer
```

## 工具

| 工具 | 作用 |
|---|---|
| `maibot_plugin_catalog` | 列出 `plugins/` 下已有插件（ID/名称/版本/目录/启停/组件/能力）与宿主能力目录，用于查冲突、找参考 |
| `maibot_sdk_reference` | 返回当前宿主的开发契约：`overview` / `capabilities` / `methods` / `components` / `messages` / `config` / `pitfalls` / `all` |
| `maibot_plugin_scaffold` | 生成通过宿主 manifest 校验的三件套骨架（默认 `enabled = false`） |
| `maibot_plugin_validate` | 静态校验：manifest 严格规则、config 与配置类对应、plugin.py 契约、能力交叉核对、组件装饰器契约、重复插件 ID |
| `maibot_plugin_install` | 校验通过后复制进 `<maibotRoot>/plugins/<dirName>`，按需设置 `enabled`（默认保持禁用） |

配套 skill `maibot-plugin-writer`：给出完整工作流与硬性契约，DSH 在收到"给麦麦写插件"类请求时会自动加载。

## 配置

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml（profile 层优先级高于插件自带的 bundle 层）
- id: dsh-maibot-plugin-writer
  name: dsh-maibot-plugin-writer
  config:
    maibotRoot: 'C:\...\modules\MaiBot'   # MaiBot 源码根（含 src/plugin_runtime 与 plugins/）
    pythonPath: ''                        # 可选：AST 深检用解释器；默认从 MaiBot 同级 python-env/.venv 探测
    dshHome: ''                           # 可选：默认 $DSH_HOME 或 ~/.dsh
    syncSkill: true                       # 是否把随包 skill 投放到 <dshHome>/skills
```

`maibotRoot` 解析顺序（**显式优先，配错即报错**，不会静默换目录）：

1. 工具参数 `maibotRoot`
2. 插件配置 `maibotRoot`
3. 环境变量 `DSH_MAIBOT_ROOT` / `MAIBOT_ROOT`
4. 当前工作目录逐级向上探测
5. 常见安装位置自动发现：`%APPDATA%\MaiBotOneKeyDesktop\*\modules\MaiBot`（一键包）、`~/MaiBot`、`~/maibot` 等（多个候选时取最近修改的，并在来源说明里列出全部候选）

## 数据来源（为什么它不会过期）

| 事实 | 来源 |
|---|---|
| 能力白名单 | 实时读 `<maibotRoot>/src/plugin_runtime/capabilities/registry.py` |
| `ctx.*` 方法表 | 实时扫 `<site-packages>/maibot_sdk/capabilities/*.py` 的 `call_capability(...)` |
| manifest 规则 | 对齐 `<maibotRoot>/src/plugin_runtime/runner/manifest_validator.py` |
| 事件契约 | 对齐 `maibot_sdk/components.py`、`src/plugin_runtime/host/event_dispatcher.py`、`host/message_utils.py` |
| 授权模型 | 对齐 `src/plugin_runtime/host/authorization.py`（未声明的能力一定失败） |
| Python 深检 | `lib/ast_probe.py` 输出 JSON（语法、导入、调用链、类结构、`open()` 模式） |

## 权限面

本插件不联网、不读凭据、不执行被校验的插件代码（只做静态解析）。它会写入会话工作区之外的路径：

- `<maibotRoot>/plugins/<dirName>`：`maibot_plugin_scaffold` 与 `maibot_plugin_install` 的落点；
- `<dshHome>/skills/maibot-plugin-writer`：随包 skill（可用 `syncSkill: false` 关闭）；
- 起一个本地 Python 子进程跑 AST 探针。

细节见 [SECURITY.md](SECURITY.md)。

## 开发

```sh
npm test              # 单元测试（零依赖、不需要 MaiBot、不需要 install）
npm run test:smoke    # 冒烟测试（自动找 MaiBot；找不到会全部标 SKIP 而不是假装通过）
npm run test:repo     # 在仓库目录里跑冒烟测试（用 test/hooks.mjs 解析 DSH 的包）
npm run pack:check    # 检查发布产物清单
```

目录结构：

```
lib/
  index.js        cordis 入口：注册 5 个工具、投放 skill
  validate.js     校验规则引擎
  host.js         宿主探测（能力注册表 / SDK 方法表 / 插件扫描 / ctx 成员）
  toml.js         插件 config.toml 的读写子集
  templates.js    脚手架模板
  install.js      安装（复制进 plugins/ + 设置 enabled）
  reference.js    SDK 参考文本
  python.js       AST 探针调用
  paths.js        MaiBot 根 / Python / DSH home 解析
  skill.js        随包 skill 投放
  ast_probe.py    Python AST 探针
skills/maibot-plugin-writer/SKILL.md
scripts/deploy-local.mjs   离线本地部署（不依赖 pnpm 联网）
test/unit.mjs | test/smoke.mjs | test/hooks.mjs
```

## 发布

```sh
npm pack --dry-run          # 确认产物清单（files 白名单：lib/ skills/ cordis.patch.yml README/CHANGELOG/LICENSE）
npm publish --access public
```

GitHub 首次推送：

```sh
git init -b main
git add -A
git commit -m "feat: DSH 插件 —— 让 DSH 自己写麦麦插件"
git remote add origin git@github.com:Lgv-H/dsh-maibot-plugin-writer.git
git push -u origin main
```

发布为 DSH 插件市场可发现的包时，建议给仓库打 `dsh-plugin` 主题标签。

## 已知限制

- AST 深检需要可用的 Python 解释器；找不到时结果里会明确写出 `未做 AST 深检：<原因>`，只做文本级检查。
- 只做静态校验，不启动 MaiBot 验证运行时行为；能力是否真被授权仍由宿主在运行时决定。
- 校验器保证「符合宿主契约、能力声明一致、语法与结构正确」，不判断业务逻辑是否正确。
- 写入 `plugins/` 下的 `.py` 会触发 MaiBot 宿主的插件重载（宿主文件监视器行为），这是预期现象。

## 许可证

[MIT](LICENSE)
