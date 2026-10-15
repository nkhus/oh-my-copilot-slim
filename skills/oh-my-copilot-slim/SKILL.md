---
name: oh-my-copilot-slim
description: Configure and improve the oh-my-copilot-slim plugin for the current user or repository. Use when users want to tune role models or reasoning effort, presets, prompt overrides, skills, MCP access, council seats, disabled agents/hooks/commands, ACP agents, or other plugin behavior. Also use when recurring workflow friction suggests a safe config or prompt improvement.
---

<!-- Adapted from alvinunreal/oh-my-opencode-slim (MIT), src/skills/oh-my-opencode-slim/SKILL.md (master @ 0656d3ef). Modified for GitHub Copilot; see NOTICE. -->

# oh-my-copilot-slim Configuration Skill

You help users configure, customize, and safely improve their
oh-my-copilot-slim setup.

The goal is not just to answer configuration questions. When useful, help the
user make their agent team better for future sessions: tune models and effort,
adjust role prompts, restrict or widen skills and MCP access, add focused
custom agents, and explain when changes take effect.

## When to Use

Use this skill when the user asks about or is likely to benefit from changes to:

- `$COPILOT_HOME/oh-my-copilot-slim.json` (user config) or
  `<repo>/.github/oh-my-copilot-slim.json` (project config)
- role models, reasoning effort, presets, or `/preset`
- orchestrator delegation behavior or specialist-role prompts
- prompt override files (`<role>.md`, `<role>_append.md`)
- skills, MCP access, disabled agents, hooks, or commands
- council seats, image routing, interview output, or ACP agents
- deepwork, reflect, interview, or loop behavior that config controls
- recurring workflow friction that could be fixed by a prompt/config change

Also use it proactively, with restraint, when a session reveals a repeatable
improvement opportunity. Example: if the user repeatedly asks the same role to
follow a project-specific rule, suggest adding that rule to a prompt append
file.

## What Is Possible

`$COPILOT_HOME` defaults to `~/.copilot`. The team's roles are plugin custom
agents: `orchestrator` (the main agent), `oracle`, `council`, `librarian`,
`explorer`, `designer`, `fixer`, and `observer` (plus a hidden `councillor`
seat agent used by council).

Concrete files agents should know:

| Path | Use |
|---|---|
| plugin `presets/github-copilot.json` | Bundled default preset. Lowest layer; overwritten on plugin update, so never edit it |
| `$COPILOT_HOME/oh-my-copilot-slim.json` | User plugin config (plain JSON). `/preset <name>` saves `preset` here |
| `<repo>/.github/oh-my-copilot-slim.json` | Project plugin config; wins over user config (plain JSON) |
| `<dir>/.github/oh-my-copilot-slim/<role>.md` | Project full prompt replacement for a role |
| `<dir>/.github/oh-my-copilot-slim/<role>_append.md` | Project append-only prompt tuning for a role |
| `<dir>/.github/oh-my-copilot-slim/<preset>/<role>[_append].md` | Project preset-specific prompt files |
| `$COPILOT_HOME/oh-my-copilot-slim/<role>[_append].md` | User prompt replacement/append |
| `$COPILOT_HOME/oh-my-copilot-slim/<preset>/<role>[_append].md` | User preset-specific prompt files |
| `.github/agents/<name>.agent.md` | Native Copilot repository custom agent |
| `.github/skills/<name>/SKILL.md`, `$COPILOT_HOME/skills/<name>/SKILL.md` | Repository / personal skills |
| `.github/copilot-instructions.md`, `AGENTS.md`, `.github/instructions/*.instructions.md` | Copilot custom instructions (all agents, not role-specific) |

Config layering, lowest to highest: bundled preset < user config < project
config. Within that:

- `presets.<name>.<role>` objects deep-merge per role across layers (fields
  you set replace that field only).
- `agents.<role>` (root) entries beat the active preset for that role.
- Lists such as `disabled_agents`, `disabled_hooks`, and `disabled_commands`
  are replaced by a later layer, not merged.
- Invalid JSON in a layer is ignored as a whole (with a warning in
  `omcs_doctor`).
- A preset switched with `/preset` in the current session wins over every
  layer for that session.

Prompt file names are exact role names (`orchestrator.md`,
`fixer_append.md`, ...). Prefer `<role>_append.md` for small behavior tuning.
Use `<role>.md` only when the user intentionally wants to replace the bundled
prompt entirely.

Prompt override lookup order:

1. Search `.github/oh-my-copilot-slim/` from the current directory upward to
   the git root (nearest first), then `$COPILOT_HOME/oh-my-copilot-slim/`.
2. In each directory, if a preset is active, its `<preset>/` subdirectory is
   checked before the directory itself.
3. The first `<role>.md` found is the base; the first `<role>_append.md` found
   is appended after it. Replacement and append are found independently.
4. An inline `prompt` string in the role's config replaces the prompt file
   (the append file still applies).
5. If nothing is found, the bundled agent prompt is used.

Common customizations:

- **Switch presets**: `/preset` lists presets; `/preset <name>` switches.
- **Tune models/effort**: assign models and `variant`/`reasoningEffort` per
  role in a preset or under `agents.<role>`.
- **Limit costs**: use cheaper models for `explorer`, `librarian`, and `fixer`.
- **Improve quality**: use stronger models for `orchestrator`, `oracle`, or
  design-heavy `designer` work.
- **Control skills**: set `skills` per role with `["*"]`, explicit names, or
  exclusions like `["*", "!codemap"]`; or adjust with `skills_add` /
  `skills_remove` (applied after all layers; remove wins).
- **Control MCPs**: set `mcps` per role with the same allow/exclude style.
- **Disable roles**: list them in `disabled_agents` (any role except
  `orchestrator`).
- **Configure council**: add `council.councillors` seats; council is off
  until seats exist.
- **Tune prompts**: append to or replace a role's prompt with prompt files.
- **Add custom agents**: create a native `.github/agents/<name>.agent.md`
  (repository) and a small orchestrator append rule that says when to use it.

Important honesty boundaries (tell the user when relevant):

- Model ids are native Copilot ids; a `github-copilot/` prefix is stripped.
  A `model` may be a list (`["id", {"id": "...", "variant": "high"}]`); the
  first available entry is used.
- The active preset's per-role model/effort is applied as a live,
  per-session subagent override (an experimental Copilot API) and only where
  it differs from the plugin's agent files. If that API is unavailable, the
  agent files' models are used. A model the user can't access falls back to
  the session model. If the session model is *Auto*, subagents run on the
  session's resolved model.
- The main session model is not switched automatically; `/preset` offers to
  switch it, otherwise the user can use `/model`.
- While the live preset override is active it replaces Copilot's `/subagents`
  settings for the session; with `apply_preset: "off"`, `/subagents` settings
  and the agent files apply.
- Empty `skills`/`mcps` lists are enforced by the agents' tool lists; named
  lists and exclusions are enforced by the plugin's hooks on a best-effort
  basis (advisory where Copilot doesn't report the calling agent).
- `omcs_doctor` shows the effective config, sources, warnings, the preset
  plan, and model availability. Use it to verify every change.
- Unknown root `agents.<name>` keys do not create custom agents; use native
  `.github/agents/*.agent.md` files instead.

## Config Keys

| Key | Values / shape |
|---|---|
| `preset` | Name of the active preset |
| `presets.<name>` | `{ "extends": "<parent>"?, "<role>": {...} }`; single-parent inheritance, child wins per field |
| `presets.<name>.<role>` / `agents.<role>` | `model` (`"<id>"` or `["<id>", {"id", "variant"}]`), `variant` or `reasoningEffort` (`low`, `medium`, `high`, `xhigh`, `max`), `skills`, `mcps`, `skills_add`, `skills_remove`, `prompt` |
| `council.councillors` | `[{ "name", "model", "variant"? }]` |
| `enforcement` | `deny` (default), `warn`, `off` - how skill/MCP policy violations are handled |
| `disabled_hooks` | `council-inject`, `phase-reminder`, `tool-loop-guard`, `image-routing`, `preset-apply`, `prompt-overrides` |
| `disabled_agents` | Roles except `orchestrator` |
| `disabled_commands` | `deepwork`, `reflect`, `interview`, `preset`, `omcs-loop` |
| `image_routing` | `auto` (route images to observer) or `direct`; defaults to `direct` when observer is disabled |
| `apply_preset` | `auto` (default) or `off` (don't apply the live per-session override) |
| `interview.outputDir` | Directory for `/interview` specs (default `interview`) |
| `acpAgents.<name>` | `command`, `args`, `env`, `cwd` (absolute), `description`, `permissionMode` (`ask`, `allow`, `reject`), `timeoutMs`; run with `omcs_acp_run`. **User config only**; ignored in project config because it launches local processes |

## Config Shapes

### Tune a role's model/effort/skills/MCPs

Edit the active preset under `presets.<preset>.<role>`, or create a small
preset that extends the bundled one:

```json
{
  "preset": "my-team",
  "presets": {
    "my-team": {
      "extends": "github-copilot",
      "oracle": {
        "model": ["claude-opus-5.5", { "id": "gpt-6.1-sol", "variant": "high" }],
        "variant": "high"
      },
      "librarian": {
        "model": "gpt-6-luna",
        "variant": "low",
        "skills": [],
        "mcps": ["context7", "gh_grep"]
      }
    }
  }
}
```

For a one-off override that should beat any preset, use root `agents`:

```json
{
  "agents": {
    "fixer": { "skills_add": ["codemap"] }
  }
}
```

### Add council seats

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

### Append instructions to a role prompt

Create, for example:

```text
$COPILOT_HOME/oh-my-copilot-slim/orchestrator_append.md
```

or for one repository only:

```text
<repo>/.github/oh-my-copilot-slim/orchestrator_append.md
```

or for only the `my-team` preset:

```text
$COPILOT_HOME/oh-my-copilot-slim/my-team/orchestrator_append.md
```

Example content:

```markdown
## Local Orchestrator Preference

- Before spawning parallel writer agents, identify non-overlapping file ownership.
- If file ownership overlaps, ask the user or serialize the work.
```

### Replace a role prompt entirely

Create:

```text
$COPILOT_HOME/oh-my-copilot-slim/orchestrator.md
```

Use this rarely. Full replacements must restate all essential plugin behavior,
because they replace the bundled prompt.

## Safe Improvement Rules

Configuration changes affect future agent behavior, so treat them as user-owned.

1. **Ask before changing config or prompts.**
   - Explain the proposed improvement briefly.
   - State which file would change.
   - Ask for confirmation unless the user explicitly requested the exact edit.
2. **Prefer narrow changes.**
   - Do not rewrite large prompts when a small rule solves the problem.
   - Do not add custom agents for one-off tasks.
3. **Preserve existing user settings.**
   - Read the current file first and merge into it; never regenerate it from
     scratch.
   - Back up the file (for example a copy next to it with a `.bak` suffix)
     before editing, unless it does not exist yet.
   - If the existing file is not valid JSON, do not overwrite it; show the
     parse error and ask the user how to proceed.
   - Config files are plain JSON: no comments or trailing commas.
4. **Avoid hidden behavior changes.**
   - Mention cost, permissions, or delegation changes before applying them.
   - Be explicit if a model change may increase spend (premium requests).
   - Never put `acpAgents` in a project config; it is ignored there.
5. **Tell the user when changes take effect.**
   - Config and prompt-override changes apply to new sessions; prompt
     overrides and the preset are also re-applied when a session starts or
     resumes.
   - `/preset <name>` switches immediately for new subagent dispatches;
     running agents keep their model.
   - Skill, agent, and plugin file changes need a new session (or a
     `/plugin` reload).

## Configuration Workflow

When making or proposing changes:

1. **Inspect current setup**
   - Run `omcs_doctor` to see config sources, warnings, the active preset and
     its plan, and model availability.
   - Read the user config and, if present, the project
     `.github/oh-my-copilot-slim.json`.
   - Check for prompt override files in `.github/oh-my-copilot-slim/` and
     `$COPILOT_HOME/oh-my-copilot-slim/`.
2. **Decide the smallest useful change**
   - Model/effort or preset tuning for performance, quality, or cost.
   - Prompt append for recurring behavior.
   - Native custom agent when a repeatable specialty deserves a separate lane.
   - Skill/MCP access change when access is too broad or too narrow.
   - User vs project config: personal preferences go to the user config;
     team/repository conventions go to the project config.
3. **Ask for confirmation**
   - Show a concise proposal.
   - Include the target file path.
4. **Apply the edit carefully**
   - Back up, then merge; preserve unrelated settings.
   - Keep role, preset, skill, and MCP names exact.
5. **Validate**
   - Ensure the file parses as JSON.
   - Run `omcs_doctor` and check that it reports no new warnings (unknown
     names, unknown preset, inheritance cycle, unavailable model).
6. **Explain activation**
   - Tell the user when the change takes effect (see rule 5).

## Custom Agent Pattern

Custom agents work best when they are narrow, repeatable, and easy for the
Orchestrator to route. oh-my-copilot-slim config does not define new agents;
use a native Copilot custom agent, for example
`.github/agents/api-reviewer.agent.md`:

```markdown
---
name: api-reviewer
description: Reviews API design, compatibility, error semantics, and migration risk. Use for public API or SDK contract changes.
tools: ["read", "search"]
---

You review API design, compatibility, error semantics, and migration risk.
Return concise findings with file references.
```

Then add an orchestrator append rule so the Orchestrator knows when to use it,
for example in `.github/oh-my-copilot-slim/orchestrator_append.md`:

```markdown
- Delegate API contract changes, public SDK changes, backwards-compatibility
  questions, or migration-risk review to the `api-reviewer` agent (task tool).
  Do not use it for routine implementation.
```

Good custom agents have:

- a specific job;
- clear trigger conditions (in the orchestrator rule and the description);
- explicit non-use conditions;
- only the tools they actually need;
- a model appropriate to the task's judgment/cost needs.

Avoid custom agents that duplicate existing specialists:

- codebase scouting → `explorer`
- external docs/research → `librarian`
- architecture/debugging/review → `oracle`
- UI/UX polish → `designer`
- scoped mechanical implementation → `fixer`

## Prompt Tuning Pattern

Prompt edits are best for recurring behavior that should happen across many
sessions.

Good reasons to tune a prompt:

- The Orchestrator repeatedly delegates too much or too little for this user's
  workflow.
- A specialist repeatedly misses a project-specific convention.
- The user wants a stable communication or verification style.
- The team has a recurring review checklist or deployment rule.

Poor reasons to tune a prompt:

- A one-off task failed once.
- The current problem can be solved by normal instruction in this session.
- The change would make the agent worse for general use.
- The rule applies to every agent, not one role: use Copilot custom
  instructions (`.github/copilot-instructions.md` or `AGENTS.md`) instead.

When suggesting a prompt improvement, say:

```text
I noticed this is recurring. I can add a small rule to <role/config path> so
future sessions handle it automatically. Want me to make that change?
```

## Examples

### Make Orchestrator more conservative with background writers

Proposal:

```text
I can add a narrow Orchestrator prompt rule to avoid parallel writer agents in
the same directory unless their file ownership is explicit. Target:
$COPILOT_HOME/oh-my-copilot-slim/orchestrator_append.md. Apply it?
```

### Use a cheaper model for scouting in one repository

Proposal:

```text
I can set the explorer to a lighter model for this repository only by adding
"agents": { "explorer": { "model": "<model-id>" } } to
.github/oh-my-copilot-slim.json. This lowers cost; explorer output may be less
thorough. Apply it?
```

### Explain activation

After editing:

```text
Updated the config and omcs_doctor reports no warnings. This applies to new
sessions; run /preset <name> to apply a preset change to new subagent
dispatches in this session.
```

## Final Checklist

- [ ] Did the user confirm config/prompt edits, unless explicitly requested?
- [ ] Did you back up and preserve existing settings (and leave invalid JSON
      untouched)?
- [ ] Is the active preset still valid (`omcs_doctor`)?
- [ ] Are skill/MCP permissions intentional and minimal?
- [ ] Did you explain when the change takes effect?
