# Compatibility: oh-my-opencode-slim → GitHub Copilot

This page maps the upstream [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) concepts to what this adaptation uses in native GitHub Copilot. It also lists the behavior that could not be verified.

## Concept mapping

| Upstream (OpenCode) | This adaptation (Copilot) | Parity |
|---|---|---|
| Plugin with agent definitions | Copilot plugin: `agents/*.agent.md` | Native |
| Per-role `model` (`github-copilot/<id>`) | Agent `model: <id>` (prefix stripped) | Preference. Unavailable → session model; Auto session → session model |
| `variant` (`high`, `max`) | Agent `reasoningEffort` | Native. The model must support the level (`omcs_doctor` checks this) |
| `skills: []` | `skill` tool omitted from the agent's `tools` | Enforced |
| `skills: ["a","b"]` | `skill` tool plus a `onPreToolUse` hook that denies other names | Best-effort (see below) |
| `skills: ["*"]` | No restriction | Native |
| `mcps: []` | No MCP tools in `tools` | Enforced for subagents |
| `mcps: ["x"]` | `tools: [..., "x/*"]` plus the hook | Enforced for subagents when the server is configured |
| `mcps: ["*", "!x", ...]` | Hook denies server `x` for that role | Best-effort; applies to the orchestrator as the main agent |
| Built-in context7 / grep.app MCPs | Agent-scoped `mcp-servers` on librarian | Native |
| Background tasks (`task`, `task_status`, `task_message`, `task_revive`) | Copilot `task` (`mode: "background"`), `read_agent`, `write_agent`, `list_agents` | Native equivalents |
| `question` / `wait_for_user` | `ask_user` | Native |
| `ast_grep_search`, LSP tools | `grep`/`glob`/`view`, plus the bundled CodeGraph `codegraph_explore` when the repo is indexed | Partial |
| `codegraph` MCP (user-provided upstream) | Bundled plugin-level `codegraph` server (`@colbymchenry/codegraph@1.6.2`, telemetry off) plus opt-in `omcs_codegraph_init` | Bundled; index is opt-in |
| Council presets (`councillors`) | `council.councillors` in `oh-my-copilot-slim.json` plus `omcs_council_roster` | Opt-in. No seats by default |
| Council agent (synthesizer) | `council` agent with no tools | Native |
| Councillor (read-only seat) | Hidden `councillor` agent, model passed per call | Native |
| Upstream `simplify` skill | Independently written `simplify` | Different text; same intent |
| Upstream `codemap` skill plus Node script | `codemap` skill using `git diff` change detection | Adapted |
| `pragmatic-engineering` (not an upstream skill) | Independently written skill | New; your own skill of the same name takes precedence |
| Schema URL `oh-my-opencode-slim@latest/...schema.json` | Not loaded; mentioned in the preset `$comment` | Informational |

## How enforcement works

1. **Agent `tools` lists.** Copilot only exposes the listed tools to a subagent. This is the primary restriction, and it is what enforces empty skill and MCP lists.
2. **The `onPreToolUse` hook** in `extensions/oh-my-copilot-slim/extension.mjs`.
   - It works out the calling role in one of two ways:
     - From the hook's `agentType` field, after stripping any plugin namespace prefix such as `oh-my-copilot-slim:fixer`.
     - For the main agent, from the currently selected agent.
   - It then denies `skill` calls and MCP tool calls that the role's preset doesn't allow.
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

Everything below was verified with Copilot CLI 1.0.95 and an isolated `COPILOT_HOME`:

- **v0.2.0 (CodeGraph):**
  - A local install of the plugin lists `codegraph` under "Plugin servers" in `copilot mcp list`; `copilot mcp get codegraph` shows `Source: Plugin`, `Source plugin: oh-my-copilot-slim (0.2.0)`, the pinned `npx` command, and `CODEGRAPH_TELEMETRY` set.
  - With a `codegraph` in the user `mcp-config.json`, and separately in a workspace `.mcp.json`, `mcp get codegraph` still showed the plugin's server.
  - `codegraph serve --mcp` (1.6.2) answers `initialize` and lists `codegraph_explore`; without an index it says to use built-in tools; it exits when its stdin closes.
  - With a stubbed SDK: `omcs_codegraph_init` returns a plan without running when unconfirmed, returns `rejected` when the dialog is declined, indexes a scratch repository when confirmed, and refuses the home directory. `omcs_doctor` reports server source, Node/npx versions, index presence, and a shadowed user definition. The hook allows `codegraph` for orchestrator, oracle, explorer, and fixer and denies it for council, librarian, designer, and observer.
- Both install paths install from GitHub: `copilot plugin marketplace add nkhus/oh-my-copilot-slim` followed by `copilot plugin install oh-my-copilot-slim@oh-my-copilot-slim`, and `copilot plugin install nkhus/oh-my-copilot-slim`. `plugin list` shows v0.1.0, and all nine agents, the extension, and the three skills are installed.
- `copilot --plugin-dir <checkout> plugin list` lists the plugin, and `copilot skill list` lists the three plugin skills.
- All agent and skill frontmatter parses as YAML. Field names follow the Copilot custom-agent reference.
- The extension loads in a live Copilot session.
  - `omcs_doctor` reports per-role model availability, effort, MCP and skill status, and drift.
  - `omcs_council_roster` reports seats, including unavailable seat models.
- With a stubbed SDK, the policy hook behaves as intended:
  - denies context7 for the orchestrator;
  - allows codegraph;
  - allows fixer → simplify and denies fixer → codemap;
  - handles namespaced agent types;
  - ignores non-role agents;
  - supports the `warn` and `off` modes;
  - ignores an invalid override file.

## Not verified / known limitations

- **Hook attribution.** It is not confirmed whether Copilot reports `agentType` in `onPreToolUse` for every plugin subagent. If it doesn't, named skill lists are advisory only. Empty lists stay enforced by `tools`.
- **Plugin agent naming.** Copilot may show plugin agents with a namespace. The orchestrator is told to use whatever name the `task` tool lists.
- **Model availability and effort support** depend on your plan and organization policy. Run `omcs_doctor`.
- **Auto model.** If your session model is Auto, all subagents use the session's resolved model.
- **Desktop vs CLI tool names** differ slightly. The `tools` aliases (`read`, `search`, `edit`, `execute`, `web`) are Copilot's documented aliases.
- **No end-to-end multi-agent run was performed** during validation, to avoid spending credits.
- **CodeGraph in a live session.** Whether Copilot connects the bundled server and how it passes the project root (MCP roots vs. working directory) was not verified in a live session; agents pass `projectPath` explicitly. `--additional-mcp-config` overriding the plugin server is documented by GitHub but `copilot mcp get` doesn't reflect it, so it is not verified here.
- **PATH.** The Copilot app must be able to find `npx` on the PATH it uses to launch MCP servers. If Node.js is installed via a version manager, the app may not see it; `omcs_doctor` reports what the extension sees.
