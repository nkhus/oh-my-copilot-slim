# oh-my-copilot-slim

> **An unofficial adaptation of [alvinunreal/oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) for GitHub Copilot.**
> oh-my-opencode-slim is an agent-orchestration plugin for [OpenCode](https://opencode.ai), released under the MIT license.
> This project re-implements its role team natively for GitHub Copilot (the Copilot app, CLI, and SDK runtime).
> It is **not** affiliated with, sponsored by, or endorsed by the oh-my-opencode-slim authors, OpenCode, or GitHub.
> See [NOTICE](NOTICE) for exactly what was adapted from upstream.

It is a native Copilot **plugin** that adds:

- **An eight-role agent team**: orchestrator, oracle, council, librarian, explorer, designer, fixer, and observer, plus a hidden `councillor` seat agent. Each role has its own model, reasoning effort, tools, MCP servers, and skill policy.
- **Eleven skills**: `simplify`, `codemap`, `pragmatic-engineering`, `deepwork`, `verification-planning`, `worktrees`, `clonedeps`, `reflect`, `loop-engineering`, `interview`, and `oh-my-copilot-slim` (setup help).
- **Commands**: `/deepwork`, `/reflect`, `/omcs-loop` (upstream's `/loop`), `/interview`, and `/preset`.
- **Presets**: multiple presets with `extends` inheritance, model fallback chains, and runtime switching with `/preset`.
- **Orchestrator automation**: council keyword trigger, per-turn phase reminder, repeated tool-call guard, and image routing to observer. Each can be turned off.
- **Tools**: structural search/replace with [ast-grep](https://ast-grep.github.io) (replace is a dry run unless asked), an enhanced web fetch (`llms.txt`, main-content extraction), opt-in external [ACP](https://agentclientprotocol.com) agents, and a `doctor` that checks everything against your Copilot runtime.
- **A bundled [CodeGraph](https://github.com/colbymchenry/codegraph) MCP server** (`codegraph`) for the roles whose preset lists it, with opt-in repository indexing.
- **Project-local customization**: per-project config, per-role prompt overrides, and `disabled_agents`/`disabled_hooks`/`disabled_commands`.

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
copilot skill list    # shows the 11 skills under "Plugin skills"
copilot mcp list      # shows codegraph under "Plugin servers"
```

Then, inside a session, ask: *"run omcs_doctor"*. It prints a per-role table showing:

- whether the role's agent is registered;
- whether the preset model is available and supports the requested reasoning effort;
- whether its MCP servers and skills are present;
- whether the agent files have drifted from the preset;
- the active preset, its `extends` chain, the chosen model in each fallback chain, and whether the live preset override is applied;
- prompt overrides, hooks, commands, image routing, ast-grep, ACP agents, and config warnings;
- CodeGraph status: where the active `codegraph` server comes from, Node.js/npx availability, and whether the current repository has an index.

## Use

Select **orchestrator** as your agent:

- In the app, pick it in the agent picker.
- In the CLI, run `copilot --agent orchestrator` or use `/agent`.

The orchestrator plans the work and delegates to the specialists with Copilot's native `task` tool, which supports background agents, `read_agent`, and `write_agent`. You can also call any specialist directly, e.g. *"use the explorer agent to find …"*.

| Role | Model (preset) | Effort | Tools | MCP servers | Skills | Purpose |
|---|---|---|---|---|---|---|
| orchestrator | gpt-6.1-sol | default | all | all except `context7` | all | Plans, delegates, verifies |
| oracle | claude-opus-5.5 | high | read, search, shell, skill, ast-grep search | codegraph | simplify, codemap | Architecture, review, hard bugs (read-only) |
| council | gpt-6.1-sol | high | none | none | none | Synthesizes council seat answers |
| librarian | gpt-6-luna | default | read, search, web fetch/search, smartfetch, ast-grep search | gh_grep, context7 | none | External docs and code examples |
| explorer | gpt-6-luna | default | read, search, shell, skill, ast-grep search | codegraph | codemap | Fast read-only codebase recon |
| designer | gpt-6-luna | default | read, search, edit, shell, ast-grep | none | none | UI/UX implementation and review |
| fixer | gpt-6-luna | max | read, search, edit, shell, skill, ast-grep | codegraph | simplify, pragmatic-engineering | Bounded implementation |
| observer | gpt-6-luna | default | read, search, ast-grep search | none | none | Images, PDFs, diagrams |

The preset values come from [`presets/github-copilot.json`](presets/github-copilot.json). It uses upstream's preset format; the `github-copilot/` model prefix is stripped because native Copilot model IDs don't have it.

### Commands

| Command | What it does |
|---|---|
| `/deepwork <task>` | Large, risky, multi-phase work: plan, gates, verified execution (the `deepwork` skill). |
| `/reflect [--sessions] [--last N] [focus]` | Looks for repeated work and proposes skill, config, or prompt improvements. |
| `/omcs-loop <goal, success criteria, max attempts>` | Execute → verify loop with the fixer. Upstream calls it `/loop`; Copilot already has a built-in `/loop`. |
| `/interview [idea]` | Refines a feature idea through questions (`ask_user`) and saves a Markdown spec to `interview/<slug>.md`. |
| `/preset [name]` | Lists presets, or switches and saves the choice to your user config. |

Commands that create working files (`/deepwork`, `/omcs-loop`, image routing) put them under `.slim/` in the repository; add `.slim/` to your `.gitignore`.

### Tools

| Tool | Roles | What it does |
|---|---|---|
| `omcs_ast_grep_search` | all but council | Structural code search with [ast-grep](https://ast-grep.github.io) patterns. |
| `omcs_ast_grep_replace` | orchestrator, designer, fixer | Structural rewrite. **Dry run by default**; writes only with `dryRun: false`. |
| `omcs_smartfetch` | orchestrator, librarian | Web fetch that prefers `llms.txt` on docs sites, extracts the main content, adds metadata, and can save binaries. |
| `omcs_acp_run` | orchestrator | Runs a task on an external ACP agent you configured (off by default). |
| `omcs_codegraph_init` | orchestrator | Builds a CodeGraph index after you confirm. |
| `omcs_council_roster` | orchestrator | Returns the configured council seats. |
| `omcs_doctor` | any | Health report. |

ast-grep paths are restricted to the current repository. It uses `ast-grep` on your PATH, or downloads the pinned `@ast-grep/cli@0.51.0` with `npx` on first use.

### Automation

Four hooks run for the orchestrator. Turn any off with `disabled_hooks`:

- **`council-inject`**: council keywords (for example "ask the council", in several languages) inject the Council Mode procedure once per session. Text in code blocks is ignored, and slash commands never trigger it.
- **`phase-reminder`**: a short workflow reminder on every orchestrator turn.
- **`tool-loop-guard`**: warns after 3 identical tool calls with identical results, and blocks the 6th identical `view`/`grep`/`glob` call.
- **`image-routing`**: if the session model can't read images, saves attachments to `.slim/images/` and tells the orchestrator to delegate them to observer.

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

All settings live in `oh-my-copilot-slim.json`: the plugin default, then `~/.copilot/oh-my-copilot-slim.json` (user), then `.github/oh-my-copilot-slim.json` (project); later files win. The full reference is in [docs/configuration.md](docs/configuration.md). Or ask the orchestrator to *"configure oh-my-copilot-slim"*: the `oh-my-copilot-slim` skill proposes the change.

```json
{
  "preset": "cheap",
  "presets": {
    "cheap": {
      "extends": "github-copilot",
      "fixer": { "model": ["claude-haiku-5.5", "gpt-6-luna"], "variant": "low" }
    }
  },
  "disabled_agents": ["designer"],
  "disabled_hooks": ["phase-reminder"]
}
```

### Models and effort

The agent files carry the default preset's model and effort. When the active preset differs (another preset, `extends`, fallback chains, or `agents` overrides), the extension applies the difference at session start as a **per-session subagent override**. This uses an experimental Copilot API.

- While that override is active it replaces your `/subagents` settings for the session. Set `"apply_preset": "off"` to keep `/subagents` in charge.
- With the default preset nothing is overridden, so `/subagents` works as usual.
- `/preset <name>` applies to new subagent dispatches immediately. Your main session model only changes if you confirm.
- Fallback chains use the first model your account can access. `omcs_doctor` shows the choice.

### Policy

`enforcement` controls how MCP and skill policy violations are handled:

- `deny` (default) blocks the tool call.
- `warn` allows the call and adds a warning.
- `off` disables the policy hook.

`disabled_agents` is always enforced: `task` calls to a disabled role are denied.

### Prompt overrides

Put `<role>.md` (replace) or `<role>_append.md` (append) in `.github/oh-my-copilot-slim/` in your repository, or in `~/.copilot/oh-my-copilot-slim/`. Use a preset subfolder (`.github/oh-my-copilot-slim/<preset>/`) for preset-specific prompts. They are applied in memory for each session and never modify the plugin. Copilot's own `.github/agents/` files are separate agents and don't override these roles. Details: [docs/configuration.md](docs/configuration.md#prompt-overrides).

### ACP agents

[Agent Client Protocol](https://agentclientprotocol.com) agents (for example Gemini CLI or a Claude Code ACP adapter) can be added as optional delegates in your **user** config under `acpAgents`. Nothing is installed or enabled by default; install and log in to the agent yourself. Permission requests from the agent are confirmed in a dialog by default. See [docs/configuration.md](docs/configuration.md#acp-agents).

## Compatibility with upstream

This is an adaptation, not a drop-in port. The important differences:

- **Models are preferences, not pins.**
  - A model you can't access falls back to the next model in the chain, then to the session model. `omcs_doctor` shows which models are available.
  - **If your session model is _Auto_, Copilot runs every subagent on the resolved session model** and ignores the per-role models. Pick a concrete session model to get per-role models.
- **Skill and MCP lists are enforced by tool lists and a hook.**
  - Subagents only get the tools in their agent file; MCP servers are listed as `server/*`.
  - Copilot always gives agents the `skill` tool, so skill lists (including empty ones) are enforced by the policy hook. That only works when Copilot reports which agent made the call; otherwise the policy is advisory, injected into the subagent's prompt.
  - Tool allow-lists are not an OS sandbox. Read-only roles with shell access are read-only by instruction.
- **Orchestration** uses Copilot's native background agents. Upstream's OpenCode-specific session tools and hooks are mapped to Copilot equivalents and are not re-implemented.
- **`/interview`** runs in the chat with Copilot's question prompts instead of upstream's local browser page.
- **Image routing** can't remove the image from the main model's input; it adds the saved paths and a delegation hint.
- **smartfetch** extracts content heuristically (no JavaScript rendering, no Readability).
- **Not ported**: terminal multiplexer panes, the companion app, the TUI sidebar, prompt-cache handling, OpenCode error-recovery hooks, the installer and update checker, and the deepwork goal/guard hooks.

See [docs/compatibility.md](docs/compatibility.md) for the per-feature parity table and the list of unverified behavior.

## Development

```sh
copilot --plugin-dir .         # load this checkout without installing
node --test tests/*.test.mjs   # unit tests (no Copilot or network needed)
```

Layout:

- `plugin.json`: plugin manifest.
- `.github/plugin/marketplace.json`: marketplace manifest.
- `plugin.json` → `mcpServers`: the bundled CodeGraph server.
- `agents/`, `skills/`: the agents and skills.
- `extensions/oh-my-copilot-slim/extension.mjs`: the extension entry point; its modules are in `lib/`.
- `tests/`: unit tests with stubbed Copilot APIs.
- `presets/`: the default preset.

## License

MIT. See [LICENSE](LICENSE). Portions are adapted from oh-my-opencode-slim (MIT, © 2025); its license notice is reproduced in [NOTICE](NOTICE). CodeGraph and ast-grep are not included in this repository; they are downloaded from npm at runtime under their own MIT licenses.
