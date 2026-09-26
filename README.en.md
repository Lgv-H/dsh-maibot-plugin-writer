# dsh-maibot-plugin-writer

> 🤖 **This entire repository — code, tests and docs — is AI-written and AI-maintained** by a DeepSeek Harness agent. See [AI authorship](#ai-authorship).

[![ci](https://github.com/Lgv-H/dsh-maibot-plugin-writer/actions/workflows/ci.yml/badge.svg)](https://github.com/Lgv-H/dsh-maibot-plugin-writer/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)
[![AI written](https://img.shields.io/badge/AI--written-DeepSeek_Harness-black.svg)](#ai-authorship)

English | [中文](README.md)

Let **DSH (DeepSeek Harness) write MaiBot plugins by itself**: read the host's real contract → scaffold → validate to zero errors → install.

Once installed, you can say "write me a MaiBot plugin that posts a good-morning message every day at 8am" and DSH will look up the host's actual SDK contract, generate the three-file plugin, validate it until clean, and hand it over for you to enable — instead of guessing the API from memory.

---

## What it is

A DSH plugin (cordis bundle) that registers 5 MaiBot plugin-authoring tools for the agent and ships 1 skill:

| Layer | Content |
|---|---|
| **Tools** | `maibot_plugin_catalog`, `maibot_sdk_reference`, `maibot_plugin_scaffold`, `maibot_plugin_validate`, `maibot_plugin_install` |
| **Skill** | `maibot-plugin-writer` (dropped into `<dshHome>/skills` on load, hot-reloaded) |
| **Source of truth** | Capability whitelist and `ctx.*` method table are read live from the running MaiBot source tree and the installed `maibot_sdk` |

## Why you need it

MaiBot's plugin contract is detailed and moves within versions. Writing from memory produces hard failures (plugin won't load, or throws at runtime):

| Real host constraint | Typical result when written from memory |
|---|---|
| `_manifest.json` is a strict model with `extra="forbid"` | One extra field, `0.1` instead of `0.1.0`, or a non-http(s) `author.url` → manifest rejected |
| `capabilities` is an authorization whitelist checked per call | Used but undeclared → `未获授权能力`; declared but not registered → invalid manifest |
| SDK surface changes between versions | `ctx.frequency.check`, `ctx.person.get`, `ctx.render.render` **do not exist** in the current SDK |
| `@EventHandler` defaults to `intercept_message=False` | Returning `{"blocked": True}` is discarded; the message keeps flowing |
| ON_MESSAGE receives only `message` | `stream_id` / `plain_text` are empty; the correct keys are `message["session_id"]` and `message["processed_plain_text"]` |
| Only plugins with `[plugin].enabled = true` are activated | "I wrote a plugin and nothing happens"; a missing `[plugin]` section counts as enabled |

`maibot_plugin_validate` statically checks all of the above, and — when a Python interpreter is available — additionally parses the AST for syntax, imports, call chains and class structure.

## Tools

- **`maibot_plugin_catalog`** — lists installed plugins (id / name / version / directory / enabled state / components / capabilities / lines) plus the host's registered capability names. Use it to avoid id collisions and find reference implementations.
- **`maibot_sdk_reference`** — returns the *current host's* contract by topic: `overview`, `capabilities`, `methods`, `components`, `messages`, `config`, `pitfalls`, `all`.
- **`maibot_plugin_scaffold`** — generates the three files (`_manifest.json` / `plugin.py` / `config.toml`) in a host-valid form, `enabled = false` by default. Accepts a target directory, so you can draft outside the plugin tree first.
- **`maibot_plugin_validate`** — static validation returning `error` / `warning` / `info`: manifest strictness, `config.toml` ↔ config-class mapping, `plugin.py` AST and SDK contracts, **capability cross-check (used vs declared)**, component contracts, duplicate plugin ids.
- **`maibot_plugin_install`** — validates first and refuses on errors; then copies into `<maibotRoot>/plugins/<dirName>` and sets `[plugin].enabled` (disabled by default; enabling stays a human decision).

**Skill `maibot-plugin-writer`** — carries the full workflow (read contract → check inventory → scaffold → implement → validate to clean → hand over) plus the hard contract checklist. DSH loads it automatically for "write / modify / debug a MaiBot plugin" requests.

## Install

```sh
# 1) From npm or the plugin market
dsh plugin --profile web add dsh-maibot-plugin-writer

# 2) From a checkout (development / local use)
git clone https://github.com/Lgv-H/dsh-maibot-plugin-writer.git
dsh plugin --profile web add link:/path/to/dsh-maibot-plugin-writer

# 3) Offline (checkout users; same as 2 without pnpm needing the registry)
node scripts/deploy-local.mjs --profile web
```

Restart the profile's service once after installing/updating. The bundled skill is picked up by the file watcher, so it is visible to new sessions without a restart.

Uninstall: `dsh plugin --profile web remove dsh-maibot-plugin-writer`.

## Quick start

After installing and restarting, just ask inside DSH:

> Write a MaiBot plugin that posts a good-morning message in a given group every day at 8am, with an editable message.

DSH follows the skill's workflow: `maibot_plugin_catalog` → `maibot_sdk_reference` → `maibot_plugin_scaffold` → fill in the implementation with file tools → `maibot_plugin_validate` until zero errors → `maibot_plugin_install` (stays disabled). It then reports the plugin id, directory, capabilities used, and how to enable/verify it.

## Configuration

Override in the profile's `cordis.patch.yml` (profile layer wins over the plugin's bundled layer):

```yaml
- id: dsh-maibot-plugin-writer
  name: dsh-maibot-plugin-writer
  config:
    maibotRoot: 'C:\...\modules\MaiBot'   # MaiBot source root (contains src/plugin_runtime and plugins/)
    pythonPath: ''                        # optional: interpreter for AST checks; auto-detected otherwise
    dshHome: ''                           # optional: defaults to $DSH_HOME or ~/.dsh
    syncSkill: true                       # drop the bundled skill into <dshHome>/skills
```

`maibotRoot` resolution order (explicit wins; a wrong explicit value fails loudly instead of silently falling through):

1. tool argument `maibotRoot`
2. plugin config `maibotRoot`
3. env `DSH_MAIBOT_ROOT` / `MAIBOT_ROOT`
4. walking up from the current working directory
5. auto-discovery of common installs: `%APPDATA%\MaiBotOneKeyDesktop\*\modules\MaiBot`, `~/MaiBot`, `~/maibot`, `~/Documents/MaiBot`, `/opt/MaiBot`, … (newest wins; all candidates are listed in the reported source)

Python resolution: config `pythonPath` → `python-env/`, `.venv/`, `.venv312/` next to MaiBot → `PATH`.

## Permissions & data disclosures

No network access, no credentials, and it never executes the code it validates (static parsing only).

| Category | Behaviour |
|---|---|
| Network | none |
| Reads | `<maibotRoot>/src/plugin_runtime/**`, `<maibotRoot>/plugins/**`, `<site-packages>/maibot_sdk/**` |
| Writes | scaffold target (default `<maibotRoot>/plugins/<id>`), install target plus `[plugin].enabled`, and `<dshHome>/skills/maibot-plugin-writer` |
| Subprocess | local Python running `lib/ast_probe.py` during validation (parses files, prints JSON) |
| Credentials | none |

See [SECURITY.md](SECURITY.md) for details.

## Compatibility

| Component | Requirement | Verified on |
|---|---|---|
| DSH | web profile with `ctx.tools` | 0.1.7-rc.2 desktop client + web profile, `@deepseek-ai/dsh-tools` 0.1.2-rc.1 |
| Node.js | ≥ 20 | 22.20.0 |
| MaiBot | 1.x (host `_manifest.json` v2 + `plugin_runtime`) | one-key installer, 60+ plugins side by side |
| MaiBot Plugin SDK | 2.x | 2.8.2 |
| Python (optional) | enables AST checks; absence degrades to text-level checks and is reported | bundled `python-env` (3.12) |

Platforms: verified on Windows. Path discovery also covers common macOS / Linux locations, but those were not tested.

## Testing

```sh
npm test              # 33 dependency-free unit tests (no install, no MaiBot needed)
npm run test:smoke    # 24 smoke assertions against a real host (auto-locates MaiBot)
npm run test:repo     # run the smoke test from the repo checkout
npm run pack:check    # inspect the published file list
```

Latest full run: 33/33 unit, 24/24 smoke, `npm pack --dry-run` → 18 files / 47.7 kB.
CI runs `npm test`, `node --check` and `npm pack --dry-run` on Node 20 and 22.

## Known limitations

- **Static only**: it does not start MaiBot or verify runtime behaviour; capability authorization still happens at runtime.
- **No business-logic judgement**: it guarantees contract conformance, capability consistency and structural correctness — not that the plugin design is right.
- **AST checks need Python**; without it the result explicitly says `未做 AST 深检：<reason>`.
- **Writing into `plugins/` triggers a host reload** (MaiBot's file watcher restarts the plugin runtime) — expected behaviour.
- **No network**, so it never fetches newer SDK docs; the local host is the source of truth (which is also why it cannot go stale).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `maibot_*` tools missing after restart | Confirm the bundle layer is in the profile (`--dump-config`) and that the service really restarted |
| "cannot determine MaiBot root" | Pass `maibotRoot`, set `DSH_MAIBOT_ROOT`, or configure it in the plugin config |
| "AST checks skipped" | Set `pythonPath`, or provide `python-env/` / `.venv/` next to MaiBot |
| "duplicate plugin id" | The host drops both candidates; rename one id or remove the stale directory |
| Installed but nothing happens | Generated plugins are `enabled = false`; set it to `true` and the host reloads itself |
| Market install/update fails | Unrelated to this plugin; if pnpm cannot reach the registry, use `scripts/deploy-local.mjs` |

## Development

```sh
git clone https://github.com/Lgv-H/dsh-maibot-plugin-writer.git
cd dsh-maibot-plugin-writer
npm test
node scripts/deploy-local.mjs --profile web --force   # sync into a profile, then restart it
```

> The runtime copy must live inside `<profile>/plugins/`: Node resolves bare specifiers (`@deepseek-ai/dsh-tools`) from the module's **real path**, so linking that directory elsewhere breaks plugin loading.

## Publish

```sh
npm pack --dry-run
npm publish --access public
git push -u origin main
```

Adding the `dsh-plugin` topic to the repository helps ecosystem discovery.

## AI authorship

**Every part of this repository is AI-written and AI-maintained**, including `lib/`, `test/`, `scripts/`, `skills/`, [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md) and this README.

- **Author**: the coding agent of DeepSeek Harness (DSH), driven by a human user's requirements and review.
- **Basis**: not memory, but the running host implementation — `src/plugin_runtime/runner/manifest_validator.py`, `capabilities/registry.py`, `host/authorization.py`, `host/event_dispatcher.py`, `host/message_utils.py` — plus the installed `maibot_sdk` (component decorators and the `ctx` method table).
- **Verification**: 33 dependency-free unit tests and 24 real-host smoke assertions pass; the validator itself was checked against real plugins (it catches the `message.get("plain_text")` misuse and the `{"blocked": True}` handler missing `intercept_message=True`, among others).
- **Human responsibility**: review the intent, run it in your own environment, confirm the permission surface, then publish/enable. Plugin output follows the same rule — generated MaiBot plugins stay `enabled = false` so enabling remains a human decision.
- **Known AI limitations**: it may produce code that passes validation yet is poorly designed, may be overly optimistic about untested platforms, and docs may drift from implementation — trust the code and tests, and please open an issue when they disagree.

If you are not comfortable running AI-written/AI-maintained code, please do not use this plugin.

## Disclaimer

Provided "as is", without warranty of any kind. It reads and writes paths outside the session workspace (MaiBot's `plugins/` directory, `<dshHome>/skills`) and spawns a local Python subprocess for static parsing. Read [SECURITY.md](SECURITY.md) before use. MaiBot plugins generated by this tool and enabled by you carry the risks of their generated content and your decision to enable them.

## License

[MIT](LICENSE) © 2026 Lgv-H
