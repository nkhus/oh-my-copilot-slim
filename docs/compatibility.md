# Compatibility: oh-my-opencode-slim → GitHub Copilot

This page maps the upstream [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) concepts to what this adaptation uses in native GitHub Copilot. It also lists the behavior that could not be verified.

## Concept mapping

| Upstream (OpenCode) | This adaptation (Copilot) | Parity |
|---|---|---|
| Plugin with agent definitions | Copilot plugin: `agents/*.agent.md` | Native |
| Per-role `model` (`github-copilot/<id>`) | Agent `model: <id>` (prefix stripped) | Preference. Unavailable → session model; Auto session → session model |
| `variant` (`high`, `max`) | Agent `reasoning-effort` | Native. The model must support the level (`omcs_doctor` checks this) |
| `skills: []` | Policy hook denies every `skill` call for the role | Best-effort. Copilot always adds the `skill` tool to custom agents |
| `skills: ["a","b"]` / `["*","!a"]` | Policy hook denies other names | Best-effort (see below) |
| `skills: ["*"]` | No restriction | Native |
| `mcps: []` | No MCP tools in `tools` | Enforced for subagents |
| `mcps: ["x"]` | `tools: [..., "x/*"]` plus the hook | Enforced for subagents when the server is configured |
| `mcps: ["*", "!x", ...]` | Hook denies server `x` for that role | Best-effort; applies to the orchestrator as the main agent |
| Built-in context7 / grep.app MCPs | Agent-scoped `mcp-servers` on librarian | Native |
| Background tasks (`task`, `task_status`, `task_message`, `task_revive`) | Copilot `task` (`mode: "background"`), `read_agent`, `write_agent`, `list_agents` | Native equivalents |
| `question` / `wait_for_user` | `ask_user` | Native |
| LSP tools | `grep`/`glob`/`view`, plus CodeGraph `codegraph_explore` when the repo is indexed | Partial |
| `codegraph` MCP (user-provided upstream) | Bundled plugin-level `codegraph` server (`@colbymchenry/codegraph@1.6.2`, telemetry off) plus opt-in `omcs_codegraph_init` | Bundled; index is opt-in |
| Council presets (`councillors`) | `council.councillors` in `oh-my-copilot-slim.json` plus `omcs_council_roster` | Opt-in. No seats by default |
| Council agent (synthesizer) / councillor | `council` agent with no tools / hidden `councillor` agent, model passed per call | Native |
| Upstream `simplify` skill | Independently written `simplify` | Different text; same intent |
| Upstream `codemap` skill plus Node script | `codemap` skill using `git diff` change detection | Adapted |
| `pragmatic-engineering` (not an upstream skill) | Independently written skill | New; your own skill of the same name takes precedence |
| Schema URL `oh-my-opencode-slim@latest/...schema.json` | Not loaded; mentioned in the preset `$comment` | Informational |

## v0.3.0 parity

| # | Upstream feature | Copilot implementation | Status |
|---|---|---|---|
| 1 | Skills `deepwork`, `verification-planning`, `worktrees`, `clonedeps`, `reflect`, `loop-engineering`, `oh-my-opencode-slim` | Ported to `skills/`; OpenCode tools/paths mapped to Copilot (`task`, `ask_user`, `.github/`, `~/.copilot/`); the self-config skill became `oh-my-copilot-slim` | **Done.** Upstream helper scripts that drive OpenCode sessions are replaced by instructions; loop monitor callbacks are replaced by history files; `worktrees` passes absolute paths in prompts because `task` has no working-directory parameter |
| 2 | Hooks `council-inject`, `phase-reminder`, `tool-loop-guard`; `disabled_hooks` | `onUserPromptSubmitted` adds context for the orchestrator; `onPreToolUse`/`onPostToolUse` implement the loop guard; all in `disabled_hooks` | **Done.** Trigger list, code stripping, once-per-session, and thresholds follow upstream |
| 3 | Commands `/deepwork`, `/reflect`, `/loop`, `/interview`, `/preset` | Native extension commands (`joinSession({ commands })`), each sends a prompt built from the matching skill; `disabled_commands` | **Done**, with `/loop` renamed `/omcs-loop` (Copilot has a built-in `/loop`). The deepwork goal/guard hooks are not ported |
| 4 | `/interview` browser UI | `interview` skill + `/interview`: Q&A through `ask_user`, spec written to `interview/<slug>.md` | **Partial.** No browser or canvas UI: plugin-contributed canvases were not used because the flow works in chat and canvases are app-only |
| 5 | Multiple presets, `extends`, `/preset`, model fallback chains | Layered config; `extends` chains with cycle detection; chains resolved against `models.list`; differences applied with `tools.updateSubagentSettings` (experimental); `/preset` persists to the user config | **Partial.** Tools/MCP/skills can't be changed at runtime (the hook enforces them instead); the live override replaces `/subagents` while active; the main session model changes only after confirmation; no mid-task fallback when a model errors |
| 6 | Image routing (`image_routing` auto/direct) | `user.message` event + `onUserPromptSubmitted`: saves images and asks the orchestrator to delegate to observer when the model reports no vision | **Partial.** The original image still reaches the main model; current Copilot models all report vision, so it rarely triggers |
| 7 | `ast_grep_search` / `ast_grep_replace` | `omcs_ast_grep_search` / `omcs_ast_grep_replace` wrapping the ast-grep CLI (pinned `@ast-grep/cli@0.51.0` via npx when not installed); replace defaults to dry run; paths limited to the repository; per-role access | **Done.** Fixes an upstream bug: `--json` makes ast-grep ignore `--update-all`, so upstream's apply never wrote files; this version applies in a second pass and reports ast-grep's own count |
| 8 | smartfetch / webfetch | `omcs_smartfetch`: `llms.txt` preference, main-content extraction, metadata, binary save, redirects and size limits; no new dependencies | **Partial.** Heuristic HTML extraction (no Readability/JS rendering); no secondary-model summarization |
| 9 | ACP agents (`acp-run`) | `omcs_acp_run` (orchestrator only) speaking ACP over stdio to agents defined in the **user** config; permission requests confirmed by dialog by default | **Partial.** Opt-in and off by default. No per-ACP-agent Copilot agents (the orchestrator calls the tool); Copilot strips token env vars from extensions, so the agent must be logged in separately |
| 10 | Project-local customization (prompt files, `disabled_agents`) | `.github/oh-my-copilot-slim.json`; `<role>.md`/`<role>_append.md` (+ preset subfolders) applied with `agent.setPrompt`; `disabled_agents` enforced on `task` | **Done**, with in-memory prompt overrides (re-applied per session); disabled agents still appear in the agent picker |

Not ported because they don't apply to Copilot: terminal multiplexer panes, companion app, TUI sidebar, prompt-cache handling, OpenCode error-recovery hooks, upstream installer/update checker, OpenCode v2 compatibility layer.

## How enforcement works

1. **Agent `tools` lists.** Copilot only exposes the listed tools to a subagent, plus `skill` and `sql`, which it always adds. This is the primary MCP restriction.
2. **The `onPreToolUse` hook** (`extensions/oh-my-copilot-slim/lib/policy.mjs`).
   - It works out the calling role in one of two ways:
     - From the hook's `agentType` field, after stripping any plugin namespace prefix such as `oh-my-copilot-slim:fixer`.
     - For the main agent, from the currently selected agent.
   - It then denies `skill` calls, MCP tool calls, and `omcs_*` tool calls that the role's preset doesn't allow, and `task` calls to roles in `disabled_agents`.
   - Calls from agents that aren't oh-my-copilot-slim roles are never touched.
   - Any error in the hook makes it a no-op rather than blocking you.
3. **`onSubagentStart`** adds the role's skill and MCP policy as context to each role's prompt. This is advisory.

Tool lists and hooks are not an OS sandbox. Read-only roles that keep shell access (oracle, explorer) are read-only by instruction.

## CodeGraph

- **Mechanism.** `plugin.json` declares `mcpServers.codegraph` (a plugin-level server). Agent-scoped `mcp-servers` were not used because they scope a server to one subagent, and the orchestrator runs as the main agent.
- **Who can call it.** Oracle, explorer, and fixer list `codegraph/*` in `tools`; the orchestrator has all tools. Council, librarian, designer, observer, and councillor don't list it, and the policy hook denies `codegraph` for the preset roles that don't allow it. Agents outside this plugin are not restricted.
- **Precedence.** Documented Copilot MCP precedence: `~/.copilot/mcp-config.json` < plugin < `--additional-mcp-config`. The plugin's `codegraph` replaces a user-defined one of the same name; use `--additional-mcp-config` to run your own. `copilot mcp disable codegraph` disables by name.
- **No index.** The server starts without an index and tells agents to use their normal tools; the agent prompts say the same. Agents are told never to index on their own.
- **Indexing.** `omcs_codegraph_init` runs `npx -y @colbymchenry/codegraph@1.6.2 init --yes <git root>` with telemetry off. It asks via `session.ui.confirm` when the host supports dialogs; otherwise it only runs with `confirm: true`, which agents are told to set only after the user agrees. This fallback relies on the model following instructions.
- **Side effects.** `.codegraph/` in the indexed repository, `~/.codegraph/` state, and the npm/npx cache for the downloaded package.

## Verified

Everything below was verified with Copilot CLI 1.0.95 and an isolated `COPILOT_HOME`.

- **v0.3.0**, in a headless SDK session with the plugin installed (tools called directly through `session.rpc.tools.execute`, so no model requests):
  - The extension starts and registers its seven tools and five commands; `omcs_doctor` reports every component.
  - Agent files declare effort with `reasoning-effort` (earlier versions used `reasoningEffort`, which Copilot ignored); `agent.list` now shows `high`/`max`.
  - Bare extension tool names in agent `tools` lists resolve; e.g. the fixer gets `view, grep, glob, create, edit, bash…, skill, codegraph-codegraph_explore, omcs_ast_grep_search, omcs_ast_grep_replace, sql` and the librarian gets `web_fetch`, `web_search`, `context7-*`, `gh_grep-searchGitHub`, and `omcs_smartfetch`.
  - A user preset `cheap` with `extends`, a fallback chain whose first model doesn't exist, and `variant: low` resolved to the second model and was applied as a live override; `designer` in `disabled_agents` was reported disabled.
  - A project `fixer_append.md` was applied with `agent.setPrompt` (Copilot does not report plugin agents' prompt text in `agent.list`, so the extension reads the authored prompt from the agent file).
  - `omcs_ast_grep_search` found matches; `omcs_ast_grep_replace` previewed in dry-run mode and, with `dryRun: false`, changed the file.
- **v0.3.0 unit tests** (`node --test tests/*.test.mjs`, stubbed APIs): council trigger, loop guard, preset `extends`/cycles/chains, layered config and project restrictions, preset planning, prompt override lookup and append safety, image routing, ast-grep formatting, command prompts, council seats, smartfetch against a local HTTP server, and an ACP round trip with a stub agent (including permission rejection without a UI).
- **v0.2.0 (CodeGraph):**
  - A local install of the plugin lists `codegraph` under "Plugin servers" in `copilot mcp list`; `copilot mcp get codegraph` shows `Source: Plugin`, the pinned `npx` command, and `CODEGRAPH_TELEMETRY` set.
  - With a `codegraph` in the user `mcp-config.json`, and separately in a workspace `.mcp.json`, `mcp get codegraph` still showed the plugin's server.
  - `codegraph serve --mcp` (1.6.2) answers `initialize` and lists `codegraph_explore`; without an index it says to use built-in tools; it exits when its stdin closes.
  - `omcs_codegraph_init` returns a plan without running when unconfirmed, returns `rejected` when the dialog is declined, indexes a scratch repository when confirmed, and refuses the home directory.
- Both install paths install from GitHub: `copilot plugin marketplace add nkhus/oh-my-copilot-slim` followed by `copilot plugin install oh-my-copilot-slim@oh-my-copilot-slim`, and `copilot plugin install nkhus/oh-my-copilot-slim`.
- All agent and skill frontmatter parses as YAML. Field names follow the Copilot custom-agent reference.

## Not verified / known limitations

- **No model turns were run** during validation, to avoid spending credits. So these were not observed end to end: whether the orchestrator follows the injected council/phase context, whether a subagent actually receives an overridden prompt (setPrompt succeeded but its effect is only visible in a model turn), whether the live preset override changes the model a subagent runs on, and slash commands being typed in the app.
- **Hook attribution.** It is not confirmed whether Copilot reports `agentType` in `onPreToolUse` for every plugin subagent. If it doesn't, skill lists are advisory only.
- **Experimental APIs.** `tools.updateSubagentSettings`, `agent.setPrompt`, and `agent.list` are marked experimental in the SDK. When they fail, `omcs_doctor` says so and the agent files' values are used.
- **Plugin agent naming.** Copilot may show plugin agents with a namespace. The orchestrator is told to use whatever name the `task` tool lists.
- **Model availability and effort support** depend on your plan and organization policy. Run `omcs_doctor`.
- **Auto model.** If your session model is Auto, all subagents use the session's resolved model.
- **Desktop vs CLI tool names** differ slightly. The `tools` aliases (`read`, `search`, `edit`, `execute`, `web`) are Copilot's documented aliases; `grep`, `glob`, `web_fetch`, and `web_search` are also listed by name because the `search` and `web` aliases alone did not expose them to subagents in testing (CLI 1.0.95).
- **ACP** was tested only with a stub agent; no third-party ACP agent was installed.
- **CodeGraph in a live session.** How Copilot passes the project root to the bundled server (MCP roots vs. working directory) was not verified; agents pass `projectPath` explicitly. `--additional-mcp-config` overriding the plugin server is documented by GitHub but not verified here.
- **PATH.** The Copilot app must be able to find `npx` on the PATH it uses to launch MCP servers and extensions. If Node.js is installed via a version manager, the app may not see it; `omcs_doctor` reports what the extension sees.
