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
| `ast_grep_search`, LSP tools | `grep`/`glob`/`view`, or a codegraph MCP if you configure one | Partial |
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

## Verified

Everything below was verified with Copilot CLI 1.0.95 and an isolated `COPILOT_HOME`:

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
