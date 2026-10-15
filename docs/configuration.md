# Configuration

oh-my-copilot-slim reads `oh-my-copilot-slim.json` from three layers. Later layers win:

1. **Plugin default**: [`presets/github-copilot.json`](../presets/github-copilot.json). It is replaced on plugin update, so don't edit it.
2. **User**: `~/.copilot/oh-my-copilot-slim.json` (or `$COPILOT_HOME/oh-my-copilot-slim.json`).
3. **Project**: `.github/oh-my-copilot-slim.json` in the session's working directory.

`omcs_doctor` lists the files it loaded, warns about invalid JSON (the file is ignored), unknown names, and ignored keys. The bundled `oh-my-copilot-slim` skill knows this format: ask *"configure oh-my-copilot-slim to …"* and it will propose an edit.

## Reference

```jsonc
{
  "preset": "github-copilot",              // active preset
  "presets": {
    "github-copilot": { /* role -> settings, see below */ },
    "cheap": {
      "extends": "github-copilot",          // single-parent inheritance
      "fixer": { "model": ["github-copilot/claude-haiku-5.5", "gpt-6-luna"], "variant": "low" }
    }
  },
  "agents": { "oracle": { "variant": "max" } }, // beats the active preset for that role
  "enforcement": "deny",                     // deny | warn | off (MCP/skill policy hook)
  "apply_preset": "auto",                    // auto | off (live model/effort override)
  "image_routing": "auto",                   // auto | direct
  "disabled_hooks": [],                      // see "Hooks"
  "disabled_agents": [],                     // roles the orchestrator must not dispatch
  "disabled_commands": [],                   // deepwork, reflect, interview, preset, omcs-loop
  "interview": { "outputDir": "interview" }, // where /interview writes specs
  "council": { "councillors": [ { "name": "alpha", "model": "claude-opus-5.5", "variant": "high" } ] },
  "acpAgents": {}                            // user config only, see "ACP agents"
}
```

### Role settings

Each role entry (in a preset or in `agents`) accepts:

| Key | Meaning |
|---|---|
| `model` | A model ID, or an array of IDs as a **fallback chain**. The first model available to your account is used. The `github-copilot/` prefix is optional. Entries may also be `{ "id": "...", "variant": "high" }`. |
| `variant` | Reasoning effort: `low`, `medium`, `high`, `xhigh`, `max` (the model must support it). |
| `skills` | Skill policy: `["*"]`, a list of names, `[]`, or exclusions such as `["*", "!codemap"]` (deny wins). |
| `mcps` | MCP server policy with the same syntax, e.g. `["*", "!context7"]`. |
| `prompt` | Inline prompt that replaces the role's authored prompt (see "Prompt overrides"). |

### Merging rules

- Presets merge per role and per key across layers: a project file can change only `fixer.variant` and keep the rest.
- `extends` resolves ancestors first; cycles and missing parents are reported and ignore the preset.
- Root `agents.<role>` beats the active preset (upstream precedence).
- `disabled_*` lists from a later layer **replace** earlier ones (upstream semantics).
- `council` from a later layer replaces the earlier one.

## Presets and switching

- `/preset` lists presets and marks the active one. `/preset <name>` switches.
  - The choice is written to your **user** config as `"preset": "<name>"`. Other keys are kept; the file is rewritten as formatted JSON. An invalid user config is never overwritten. A project file that pins `preset` still wins in that repository, and `/preset` tells you so.
  - The new preset is applied immediately to **new** subagent dispatches. Running agents keep their model.
  - If the preset assigns the orchestrator a different model, `/preset` asks before switching your session model (`/model`). Without a confirmation UI it leaves your session model alone.
- **What is actually switchable.** Each role's `model`/`variant` comes from its agent file. At session start, and on `/preset`, the extension compares the active preset with the agent files and applies only the differences as a per-session **subagent override** (`session.rpc.tools.updateSubagentSettings`, an experimental Copilot API).
  - While this override is active it **replaces** your `/subagents` settings for that session. Set `"apply_preset": "off"` (or disable the `preset-apply` hook) to keep `/subagents` in charge.
  - When the preset matches the agent files (the default), nothing is applied and `/subagents` works as usual.
  - Tools, MCP servers, and skills cannot be changed at runtime by Copilot. For those, the preset is enforced by the policy hook (see the compatibility doc), not by changing the agent.
  - The main agent's model is never changed without your confirmation.
- **Fallback chains** are resolved against the models your account can use. `omcs_doctor` shows the chosen model and why others were skipped. If nothing in the chain is available, the role keeps its agent-file model.

## Hooks

All hooks are on by default. Disable with `"disabled_hooks": ["<name>"]`.

| Name | What it does |
|---|---|
| `council-inject` | When the orchestrator receives a prompt containing a council keyword (upstream's multilingual list), it injects the Council Mode procedure once per session. Code blocks and inline code are ignored; slash commands never trigger it. |
| `phase-reminder` | Adds a short workflow reminder to every orchestrator prompt. |
| `tool-loop-guard` | After 3 identical tool calls with identical results it warns the agent; after 5 it blocks further identical `view`/`grep`/`glob` calls. `task`, `write_agent`, and `ask_user` are exempt. |
| `image-routing` | See "Image routing". |
| `preset-apply` | The live model/effort override described above. |
| `prompt-overrides` | Project/user prompt files described below. |

The MCP/skill policy hook is controlled by `enforcement`, and `disabled_agents` is always enforced.

## Disabled agents

`"disabled_agents": ["designer"]` makes the policy hook deny `task` calls that target that role (regardless of `enforcement`); the denial tells the orchestrator to do the work itself or pick another role. A disabled `council` also turns off council runs. The orchestrator itself cannot be disabled; select a different main agent instead. Disabling `observer` also switches `image_routing` to `direct` unless you set it explicitly. The agents are still visible in Copilot's agent picker because plugin agents can't be hidden at runtime.

## Prompt overrides

Place Markdown files in `.github/oh-my-copilot-slim/` (project) or `~/.copilot/oh-my-copilot-slim/` (user):

- `<role>.md` replaces the role's prompt.
- `<role>_append.md` is appended to the role's prompt (or to the replacement).
- A preset subdirectory, e.g. `.github/oh-my-copilot-slim/cheap/fixer.md`, wins over the plain file while that preset is active.

Search order, first match wins: from the working directory up to the repository root, each directory's `.github/oh-my-copilot-slim/<preset>/` then `.github/oh-my-copilot-slim/`; then the user directory (preset subdirectory first). An inline `prompt` in the config beats a replacement file.

- Overrides are applied in memory with `session.rpc.agent.setPrompt` at session start and re-applied when a session resumes. They never modify the plugin's agent files. Removing a file restores the authored prompt at the next session start.
- If the runtime rejects an override, an append is delivered as subagent context instead and a replacement is reported as not applied (`omcs_doctor` → "Prompt overrides").
- **Trust**: project prompt files change agent behavior for anyone opening the repository, like any repository instructions. Review them as you would `.github/copilot-instructions.md`.
- **Relation to Copilot's native agents**: repository agents in `.github/agents/*.agent.md` are separate agents with their own names; they don't override this plugin's roles and the policy hook ignores them. Use prompt override files to change a role.

## Image routing

With `"image_routing": "auto"` (default), when you attach images and the session model reports no vision support, the extension saves the images under `.slim/images/<session>/` and tells the orchestrator to delegate to `observer` with the file paths. `direct` leaves images to the main model. Copilot still sends the original attachment to the main model; the extension can't remove it. Models that report vision support (currently most Copilot models) are not affected, and Auto or unknown models are left alone.

## ACP agents

External [Agent Client Protocol](https://agentclientprotocol.com) agents can be used as optional delegates through the `omcs_acp_run` tool (orchestrator only). Nothing is configured or installed by default; you install and authenticate the agent yourself. Define agents **only in your user config** (project definitions are ignored because they would start local processes):

```json
{
  "acpAgents": {
    "gemini": {
      "command": "gemini",
      "args": ["--experimental-acp"],
      "description": "Gemini CLI via ACP",
      "permissionMode": "ask",
      "timeoutMs": 600000
    }
  }
}
```

- `command`/`args` start the agent; `env` adds variables; `cwd` (absolute) defaults to the session's working directory.
- `permissionMode`: `ask` (default; you confirm each permission request in a dialog, and requests are rejected when no dialog is available), `allow`, or `reject`.
- `timeoutMs` defaults to 10 minutes; `0` disables it.
- Copilot strips sensitive environment variables (tokens) from extension processes, so the agent must be logged in on its own. ACP agents run with your user's file access, outside Copilot's tool permissions.

## Commands

| Command | Upstream | What it does |
|---|---|---|
| `/deepwork <task>` | `/deepwork` | Runs the task through the `deepwork` skill (state in `.slim/deepwork/`): plan, phases, gates, verified execution. |
| `/reflect [--sessions] [--last N] [focus]` | `/reflect` | Reviews repeated work in this session (or recent sessions) and proposes skill/config/prompt improvements via the `reflect` skill. |
| `/omcs-loop <goal, success criteria, max attempts>` | `/loop` | Execute → verify loop with the fixer, keeping attempt history in `.slim/loop-history/`. Named `omcs-loop` because Copilot has a built-in `/loop`. |
| `/interview [idea]` | `/interview` | Q&A (via `ask_user`) to refine a feature idea, then writes `<interview.outputDir>/<slug>.md` (default `interview/`). |
| `/preset [name]` | `/preset` | Lists or switches presets. |

Disable any with `"disabled_commands": ["<name>"]`.

## Environment variables

| Variable | Effect |
|---|---|
| `OMCS_AST_GREP_BIN` | Path to an ast-grep binary. Otherwise `ast-grep`/`sg` on PATH, then `npx -y -p @ast-grep/cli@0.51.0 ast-grep`. |
| `OMCS_SMARTFETCH_DIR` | Where `omcs_smartfetch` saves binary downloads (default: a directory under the OS temp dir). |
| `OMCS_PLUGIN_ROOT` | Override the plugin root (development). |
