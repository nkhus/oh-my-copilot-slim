# oh-my-copilot-slim

> **An unofficial adaptation of [alvinunreal/oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) for GitHub Copilot.**
> oh-my-opencode-slim is an agent-orchestration plugin for [OpenCode](https://opencode.ai), released under the MIT license.
> This project re-implements its role team natively for GitHub Copilot (the Copilot app, CLI, and SDK runtime).
> It is **not** affiliated with, sponsored by, or endorsed by the oh-my-opencode-slim authors, OpenCode, or GitHub.
> See [NOTICE](NOTICE) for exactly what was adapted from upstream.

It is a native Copilot **plugin** that adds:

- **An eight-role agent team**: orchestrator, oracle, council, librarian, explorer, designer, fixer, and observer, plus a hidden `councillor` seat agent. Each role has its own model, reasoning effort, tools, MCP servers, and skill policy.
- **Skills**: `simplify`, `codemap`, and `pragmatic-engineering`.
- **A bundled [CodeGraph](https://github.com/colbymchenry/codegraph) MCP server** (`codegraph`) for the roles whose preset lists it, with opt-in repository indexing.
- **A small extension** with three tools and two hooks:
  - `omcs_doctor` checks the preset (and CodeGraph) against your Copilot runtime.
  - `omcs_council_roster` returns the configured council seats.
  - `omcs_codegraph_init` builds a CodeGraph index for the current repository, only after you confirm.
  - The hooks apply each role's MCP and skill policy at runtime.

This is not an OpenCode launcher and does not need OpenCode.

## Install

Requires GitHub Copilot with plugin support (Copilot CLI or the Copilot app). The bundled CodeGraph server also needs Node.js (`npx`) and, on first start, network access to download `@colbymchenry/codegraph` from npm; without them everything else still works.

**CLI (recommended)**: add this repository as a plugin marketplace, then install the plugin from it:

```sh
copilot plugin marketplace add nkhus/oh-my-copilot-slim
copilot plugin install oh-my-copilot-slim@oh-my-copilot-slim
```

Installing directly from the repository also works:

```sh
copilot plugin install nkhus/oh-my-copilot-slim
```

Copilot CLI 1.0.95 marks direct repo installs as deprecated in favor of `plugin@marketplace`.

**Copilot app**: go to **Customize → Plugins**, add the `nkhus/oh-my-copilot-slim` repository (or the marketplace above), and enable **oh-my-copilot-slim**.

**Try it without installing**:

```sh
git clone https://github.com/nkhus/oh-my-copilot-slim
copilot --plugin-dir ./oh-my-copilot-slim
```

**Update or remove**: use the plugin name exactly as `copilot plugin list` shows it (`oh-my-copilot-slim@oh-my-copilot-slim` for a marketplace install, `oh-my-copilot-slim` for a direct install):

```sh
copilot plugin update oh-my-copilot-slim@oh-my-copilot-slim
copilot plugin uninstall oh-my-copilot-slim@oh-my-copilot-slim
```

### Verify the install

```sh
copilot plugin list   # shows oh-my-copilot-slim
copilot skill list    # shows codemap, pragmatic-engineering, simplify under "Plugin skills"
copilot mcp list      # shows codegraph under "Plugin servers"
```

Then, inside a session, ask: *"run omcs_doctor"*. It prints a per-role table showing:

- whether the role's agent is registered;
- whether the preset model is available and supports the requested reasoning effort;
- whether its MCP servers and skills are present;
- whether the agent files have drifted from the preset;
- CodeGraph status: where the active `codegraph` server comes from, Node.js/npx availability, and whether the current repository has an index.

## Use

Select **orchestrator** as your agent:

- In the app, pick it in the agent picker.
- In the CLI, run `copilot --agent orchestrator` or use `/agent`.

The orchestrator plans the work and delegates to the specialists with Copilot's native `task` tool, which supports background agents, `read_agent`, and `write_agent`. You can also call any specialist directly, e.g. *"use the explorer agent to find …"*.

| Role | Model (preset) | Effort | Tools | MCP servers | Skills | Purpose |
|---|---|---|---|---|---|---|
| orchestrator | gpt-6.1-sol | default | all | all except `context7` | all | Plans, delegates, verifies |
| oracle | claude-opus-5.5 | high | read, search, shell, skill | codegraph | simplify, codemap | Architecture, review, hard bugs (read-only) |
| council | gpt-6.1-sol | high | none | none | none | Synthesizes council seat answers |
| librarian | gpt-6-luna | default | read, search, web | gh_grep, context7 | none | External docs and code examples |
| explorer | gpt-6-luna | default | read, search, shell, skill | codegraph | codemap | Fast read-only codebase recon |
| designer | gpt-6-luna | default | read, search, edit, shell | none | none | UI/UX implementation and review |
| fixer | gpt-6-luna | max | read, search, edit, shell, skill | codegraph | simplify, pragmatic-engineering | Bounded implementation |
| observer | gpt-6-luna | default | read, search | none | none | Images, PDFs, diagrams |

The preset values come from [`presets/github-copilot.json`](presets/github-copilot.json). It uses upstream's preset format; the `github-copilot/` model prefix is stripped because native Copilot model IDs don't have it.

### MCP servers

- **librarian** ships agent-scoped definitions for `context7` (`https://mcp.context7.com/mcp`) and `gh_grep` (`https://mcp.grep.app`). These are public remote endpoints, the same defaults upstream uses. Queries sent to them leave your machine.
- **codegraph** is bundled at plugin level (see [CodeGraph](#codegraph)).

### CodeGraph

The plugin starts [CodeGraph](https://github.com/colbymchenry/codegraph) (MIT, by Colby McHenry; a separate project, not affiliated with this one) as the MCP server `codegraph`:

```sh
npx -y @colbymchenry/codegraph@1.6.2 serve --mcp   # with CODEGRAPH_TELEMETRY=0
```

- **Who gets it:** orchestrator, oracle, explorer, and fixer (the roles whose preset lists `codegraph`). Council, librarian, designer, observer, and councillor don't list it in their `tools` and are also blocked by the policy hook. Plugin MCP servers are session-wide, so other agents you select, and Copilot's built-in agents that get MCP tools, may see it too.
- **Local only.** CodeGraph reads your code and keeps its index in the repository's `.codegraph/` folder. The plugin disables its anonymous telemetry with `CODEGRAPH_TELEMETRY=0`. CodeGraph still keeps local state in `~/.codegraph/` (settings, update checks, running-server records).
- **Indexing is opt-in.** CodeGraph only answers for repositories that have an index. Without one, agents use normal search (grep/glob/view). To index the current repository, ask: *"index this repo with codegraph"*. The orchestrator calls `omcs_codegraph_init`, which asks you to confirm (a dialog where the host supports one, otherwise the agent must ask you first) and then runs `codegraph init` for the repository's git root. It refuses your home directory and the filesystem root. You can also run it yourself: `npx -y @colbymchenry/codegraph@1.6.2 init`. Add `.codegraph/` to your global gitignore if you don't want it showing up; CodeGraph writes its own `.gitignore` inside the folder.
- **Using your own `codegraph` server.** Copilot's documented MCP precedence is *user config (`~/.copilot/mcp-config.json`) < plugin < `--additional-mcp-config`*, so the plugin's server replaces a `codegraph` in your user config. In testing (CLI 1.0.95) it also replaced one in a workspace `.mcp.json`. `omcs_doctor` warns when your definition is shadowed. To use yours, start Copilot with `--additional-mcp-config @your-codegraph.json` (a file with an `mcpServers.codegraph` entry). `copilot mcp disable codegraph` turns off the server by name, which also disables your own definition of the same name.

### Council

Council never runs automatically. Running it takes one model call per seat plus one synthesis call, and your preset does not define any seats, so it is **off until you configure seats**. Add seats to `.github/oh-my-copilot-slim.json` (project) or `~/.copilot/oh-my-copilot-slim.json` (user):

```json
{
  "council": {
    "councillors": [
      { "name": "alpha", "model": "claude-opus-5.5", "variant": "high" },
      { "name": "beta", "model": "gpt-6.1-sol" }
    ]
  }
}
```

Then ask the orchestrator for a council. It will:

1. Call `omcs_council_roster`.
2. Dispatch one `councillor` per seat in parallel, each with that seat's model and effort.
3. Hand all the answers to `council`, which writes a structured consensus report.

If no seats are configured, the orchestrator tells you so and offers oracle instead.

## Configure

### Models and effort

Copilot chooses each role's model in this order:

1. A per-call value.
2. Your Copilot `subagents` override, set with `/subagents` or in `~/.copilot/settings.json`.
3. The agent file's `model` and `reasoningEffort`.
4. The session's model.

To change a role's model, use `/subagents`. Plugin files are overwritten on update.

### Policy overrides

Optional overrides live in `oh-my-copilot-slim.json`. The project file (`.github/oh-my-copilot-slim.json`) wins over the user file (`~/.copilot/oh-my-copilot-slim.json`, or `$COPILOT_HOME`), which wins over the plugin default. Merging is per role: the fields you set replace the defaults for that role.

```json
{
  "presets": { "github-copilot": { "fixer": { "skills": ["*"] } } },
  "enforcement": "deny"
}
```

`enforcement` controls how policy violations are handled:

- `deny` (default) blocks the tool call.
- `warn` allows the call and adds a warning.
- `off` disables the policy hook.

Model and effort values in this file are only *checked* by `omcs_doctor`; they don't re-pin the agent. Use `/subagents` for that.

## Compatibility with upstream

This is an adaptation, not a drop-in port. The important differences:

- **Models are preferences, not pins.**
  - A model you can't access falls back to the session model. `omcs_doctor` shows which models are available.
  - **If your session model is _Auto_, Copilot runs every subagent on the resolved session model** and ignores the per-role models. Pick a concrete session model to get per-role models.
- **Skill lists**:
  - Roles with an empty skill list are *enforced*: they don't get the `skill` tool at all.
  - Named lists (oracle, explorer, fixer) are enforced by a best-effort hook. It only applies when Copilot reports which agent is calling the tool. Otherwise the policy is advisory, injected into the subagent's prompt.
  - Copilot's agent files have no per-agent skill allow-list.
- **MCP lists**:
  - For subagents, MCP access is restricted by each agent's `tools` list.
  - The orchestrator's `!context7` rule is enforced by the hook when the orchestrator is the selected main agent.
  - CodeGraph is bundled as a plugin-level server named `codegraph`; it replaces a user-defined server with that name (see [CodeGraph](#codegraph)).
  - Tool allow-lists are not an OS sandbox. Read-only roles with shell access are read-only by instruction.
- **Orchestration** uses Copilot's native background agents. Upstream's OpenCode-specific session tools and hooks are mapped to Copilot equivalents and are not re-implemented.
- **The `variant` field** maps to Copilot's `reasoningEffort`.

See [docs/compatibility.md](docs/compatibility.md) for the full mapping and the list of unverified behavior.

## Development

```sh
copilot --plugin-dir .   # load this checkout without installing
```

Layout:

- `plugin.json`: plugin manifest.
- `.github/plugin/marketplace.json`: marketplace manifest.
- `plugin.json` → `mcpServers`: the bundled CodeGraph server.
- `agents/`, `skills/`: the agents and skills.
- `extensions/oh-my-copilot-slim/extension.mjs`: the extension.
- `presets/`: the default preset.

## License

MIT. See [LICENSE](LICENSE). Portions are adapted from oh-my-opencode-slim (MIT, © 2025); its license notice is reproduced in [NOTICE](NOTICE). CodeGraph is not included in this repository; it is downloaded from npm at runtime under its own MIT license.
