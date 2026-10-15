---
name: reflect
description: Review recent work, find repeated workflow patterns, and suggest reusable skills, agents, commands, config changes, or playbooks. Use when the user asks to learn from past sessions, improve recurring workflows, or identify what should be turned into reusable agent instructions.
---

<!-- Adapted from alvinunreal/oh-my-opencode-slim (MIT), src/skills/reflect/SKILL.md (master @ 0656d3ef). Modified for GitHub Copilot; see NOTICE. -->

# Reflect

Reflect is an orchestrator-only workflow for learning from repeated work. It
looks back over recent sessions, project notes, and existing agent assets, then
recommends the smallest useful improvement: a skill, custom agent, command,
configuration change, prompt rule, documentation playbook, or no change.

The goal is to identify real repeated friction and suggest practical improvements with evidence.

## When to Use

Use Reflect when the user asks to:

- run `/reflect` or `/reflect <focus>`;
- run `/reflect --sessions` for session archaeology;
- learn from recent sessions or repeated workflows;
- find work they keep doing manually;
- improve their oh-my-copilot-slim setup based on actual usage (use the
  oh-my-copilot-slim skill for config and prompt changes);
- review whether a recurring process should become a reusable playbook;
- turn repeated workflow friction into a safer future default.

Do not use Reflect for ordinary implementation work, one-off debugging, broad
architecture review, or speculative agent creation without workflow evidence.

## Session Mode

When the user includes `--sessions` in their reflect command, shift to session
archaeology: analyze historical Copilot sessions across all repos to find
repeated patterns, friction, and improvement opportunities. The `/reflect`
command passes the number of sessions to analyze (`--last N`, default 50).

Session history is read-only evidence. Never modify, delete, or move session
data, and never copy secrets or private content from it into reports or assets.

### Session Discovery

1. **Prefer `session_store_sql` when the tool is available.** It queries
   Copilot's session history (tables `sessions`, `turns`, `checkpoints`,
   `session_files`, `session_refs`). Always time-bound queries, select only the
   columns you need, and use `LIMIT`. Run one query per call. Start with a
   recent window (for example 30 days) and widen only if it yields too few
   sessions.

   Recent sessions (set the limit to the `--last N` value):

   ```sql
   SELECT id, cwd, repository, branch, summary, created_at, updated_at
   FROM sessions
   WHERE created_at >= now() - INTERVAL '30 days'
   ORDER BY created_at DESC
   LIMIT 50
   ```

   Conversation for one session:

   ```sql
   SELECT turn_index, user_message, assistant_response, timestamp
   FROM turns
   WHERE session_id = '<session_id>'
   ORDER BY turn_index
   LIMIT 200
   ```

   Useful extras, each filtered by `session_id`: `checkpoints` (title,
   overview: compact goal/progress summaries), `session_files` (files changed
   and the tool used), and `session_refs` (linked commits, PRs, issues). Where
   the cloud store exposes `tool_executions` or `session_usage`, use them for
   tool names, failures, durations, and models. When querying the local store
   only (`source: "local"`), use SQLite syntax: `LIKE` instead of `ILIKE`, and
   compare date prefixes such as
   `substr(created_at, 1, 10) >= date('now', '-30 days')` instead of
   `INTERVAL`.

2. **Fall back to local session files.** When `session_store_sql` is not
   available, read session data under
   `$COPILOT_HOME/session-state/` (default `~/.copilot/session-state/`)
   read-only. Each session has a directory `<session-id>/` that may contain
   `events.jsonl`, `checkpoints/`, `plan.md`, and `files/`.

   - Pick the newest N session directories by modification time
     (for example
     `ls -t "${COPILOT_HOME:-$HOME/.copilot}/session-state" | head -n 50`),
     skipping the current session.
   - `events.jsonl` has one JSON event per line with a `type` field. Use
     `user.message` events for user requests, `assistant.message` events for
     the agent's replies, and `tool.execution_complete` events for tool names
     and success/failure signals. Skip large tool output payloads and anything
     that is not needed for the analysis.
   - `checkpoints/` and `plan.md` (when present) are compact summaries of the
     session's goal and progress; read them first, and open `events.jsonl`
     only when they are missing or insufficient.
   - Derive `project` from the session's working directory or repository when
     it is recorded; otherwise mark it unknown.
   - Prefer streaming or filtering tools (for example `grep` for a `type`
     value, or a small read-only script) over loading whole large files into
     context.

### Per-Session Analysis

For each session, analyze and produce a structured summary:

```json
{
  "session": "5f0c2a9e-1b7d-4c3e-9a61-2d8e4f7b0c11",
  "project": "/home/user/Projects/example-app",
  "timestamp": "2026-06-10T15:08:45.427Z",
  "goal": "Fix CI failure",
  "success": true,
  "frictions": [
    "Repeated grep to find test file",
    "Three failed test runs before passing"
  ],
  "recommendations": [
    "Create /test-ci command"
  ],
  "duration_minutes": 18,
  "models_used": ["<model-id>"],
  "agents_used": ["orchestrator", "fixer", "explorer"],
  "tools_used": ["view", "edit", "bash"],
  "confidence": 0.85
}
```

**Confidence scoring:**
- 0.9-1.0: Clear success/failure, obvious patterns
- 0.7-0.9: Likely outcome, patterns inferred from tool usage
- 0.5-0.7: Uncertain outcome, limited evidence
- <0.5: Skip or mark as "needs more evidence"

### Storage and Caching

Store session summaries in
`$COPILOT_HOME/oh-my-copilot-slim/reflections/sessions/` (default
`~/.copilot/oh-my-copilot-slim/reflections/sessions/`). This directory is the
only place session mode writes to without asking.

**Cache logic:**
1. Check if `<session-id>.json` exists in reflections directory
2. If yes, load it (saves tokens)
3. If no, analyze session and save summary
4. Aggregate across all summaries for final report

### Aggregation

After analyzing all sessions, aggregate findings:

1. **Group by theme** - sessions with similar frictions cluster together
2. **Count frequency** - "42/50 sessions had repeated grep before editing"
3. **Rank by impact** - prioritize recommendations that appear most often
4. **Filter noise** - skip one-off issues, focus on repeated patterns
5. **Cross-reference** - see if patterns correlate with specific models, agents, or repos

**Scope categories:**
- **Global** - applies to all repos (pattern seen in >50% of repos)
- **Cross-repo** - applies to specific repos where pattern appears
- **Project-specific** - only relevant to one repo

### Output Format

Return a compact report with scope and confidence:

```text
Session Reflection Report
Analyzing 50 most recent sessions across 8 repos.

Repos analyzed:
- <repo> (<N> sessions)
- ... (M more)

Findings
- <pattern>: N/50 sessions across M repos.
  - Scope: global | cross-repo (<repos>) | project-specific (<repo>)
  - Confidence: 0.95
  - Impact: High | Medium | Low

Recommended changes
- <asset>: <purpose>
  - Scope: global | cross-repo (<repos>) | project-specific (<repo>)
  - Confidence: 0.97
  - Estimated time saved: High | Medium | Low

Skipped
- <candidate>: why not worth packaging now.
  - Scope: <reason>
  - Confidence: <score>

Needs more evidence
- <candidate>: what would make it actionable.
  - Current scope: <what we've seen>
  - Required scope: <what would confirm>
```

### Error Handling

**History source issues:**
- `session_store_sql` unavailable or failing → fall back to the local
  session files and say so in the report.
- No history found → "No Copilot session history found at <path>. Use
  Copilot in at least one repo first."
- History is empty → "Copilot session history is empty. No sessions to
  analyze."

**Session loading issues:**
- Session ID not loadable → Skip with warning: "Session <id> could not be loaded, skipping."
- Session has no messages → Skip: "Session <id> has no messages."

**Recovery pattern:**
- Log the failure
- Continue with remaining sessions
- Report failures at end: "3 sessions skipped due to load errors"

## Core Contract

Reflect must be conservative and evidence-driven.

Required behavior:

- inspect existing assets before suggesting new ones;
- prefer recent, repeated, user-visible friction over isolated incidents;
- recommend the smallest useful form;
- treat "create nothing" as a successful result when evidence is weak;
- ask before changing prompts, skills, commands, agents, MCP access, or config;
- avoid duplicating existing assets;
- explain when config, prompt, agent, skill, MCP, or plugin changes take effect
  (see Guardrails).

## Evidence Sources

Use available evidence in this order:

1. Current conversation and explicit user instructions.
2. Project-local guidance and memories, such as `AGENTS.md`,
   `.github/copilot-instructions.md`, `.github/instructions/`, `.github/agents/`,
   `.github/skills/`, `.github/oh-my-copilot-slim/`, `.slim/`, notes,
   checkpoints, task progress files, and codemaps.
3. Existing skills, commands, agents, prompt overrides, MCP permissions, and
   oh-my-copilot-slim configuration.
4. Recent Copilot session history (`session_store_sql` or
   `$COPILOT_HOME/session-state/`) if it is available and safe to inspect.
5. External docs only when a proposed workflow depends on a third-party tool or
   library whose behavior needs confirmation.

Respect privacy and safety boundaries. Do not inspect unrelated personal files,
credentials, private messages, or external accounts unless the user explicitly
asks and the workflow requires it.

## Workflow

Reflect can be triggered directly:

```text
/reflect
/reflect release workflow and checks
/reflect --sessions
/reflect --sessions --last 100
```

With no arguments, review recent work broadly. With arguments, focus the review
on that workflow area while still checking whether existing assets already cover
it.

### 1. Inventory Existing Assets

Before proposing anything, identify what already exists:

- bundled plugin skills, repository skills (`.github/skills/`), and personal
  skills (`$COPILOT_HOME/skills/`);
- custom agents (plugin roles and `.github/agents/*.agent.md`);
- slash commands (the plugin's `/deepwork`, `/reflect`, `/omcs-loop`,
  `/interview`, `/preset`);
- prompt overrides and append files (`.github/oh-my-copilot-slim/` and
  `$COPILOT_HOME/oh-my-copilot-slim/`);
- custom instructions (`.github/copilot-instructions.md`, `AGENTS.md`,
  `.github/instructions/*.instructions.md`);
- active oh-my-copilot-slim preset, model routing, skills, and MCP permissions;
- project playbooks, docs, codemaps, and local workflow notes.

If an existing asset already covers the candidate, recommend extending or using
that asset instead of creating a near-duplicate.

### 2. Find Repeated Workflow Patterns

Look for repeated signals such as:

- the same command sequence appears across sessions;
- the user repeatedly asks for the same review, setup, release, or debugging
  process;
- the same manual research or context-gathering steps keep recurring;
- the same specialist routing decision is repeatedly needed;
- the same project-specific rule is repeatedly re-explained;
- repeated failures happen because an agent lacks a stable instruction, tool, or
  permission boundary.

Strong candidates usually have at least two occurrences, stable inputs, a clear
output, and a clear stopping condition.

### 3. Score Candidates

For each candidate, decide:

- **Frequency:** How often has it happened?
- **Cost:** Does it waste meaningful time, context, money, or attention?
- **Risk:** Does inconsistent execution cause bugs, regressions, bad decisions,
  or unsafe changes?
- **Stability:** Are the inputs and desired output predictable?
- **Coverage:** Is there already an asset that handles it well?

Only recommend creating or changing assets when confidence is high.

### 4. Choose the Smallest Useful Form

Pick the least powerful form that solves the repeated problem:

- **Prompt/config rule:** a small behavior change to an existing agent.
- **Skill:** reusable workflow guidance for a task shape.
- **Command:** a repeatable manual trigger with stable inputs.
- **Custom agent:** a distinct specialist lane with clear delegation rules.
- **MCP/tool permission change:** a safe access adjustment for an existing agent.
- **Project playbook/doc:** human-readable process guidance when automation is too
  heavy.
- **Skip:** weak, one-off, ambiguous, sensitive, or already-covered work.

Avoid creating custom agents when a prompt rule or skill is enough. Avoid skills
when a short project playbook is enough. Avoid config changes when the benefit is
unclear.

### 5. Propose Before Changing

Unless the user explicitly requested a specific edit, present a concise proposal
before writing files or changing config:

```text
Found 2 strong repeated workflows and 1 weak candidate.

Recommended:
- Add a small orchestrator prompt rule for <workflow> because <evidence>.
- Extend existing <skill> instead of creating a new one because <overlap>.

Skip:
- <candidate> because it only appeared once.

Proceed with the proposed edits?
```

When applying changes, preserve existing user settings and prefer narrow,
append-only edits.

## Output Format

Return a compact report:

```text
Findings
- <workflow>: evidence, frequency/confidence, recommended form.

Recommended changes
- <asset/config/doc>: one-line purpose and why this is the smallest useful form.

Skipped
- <candidate>: why not worth packaging now.

Needs more evidence
- <candidate>: what would make it actionable.
```

If nothing qualifies, say:

```text
No strong repeated workflow found. I would not add or change any reusable assets
yet.
```

## Guardrails

- Do not manufacture assets to justify the workflow.
- Do not create overlapping skills or agents.
- Do not silently change global config, prompts, or permissions.
- Do not add broad instructions that make agents more eager, expensive, or
  invasive without a clear benefit.
- Do not overfit to a single session unless the user explicitly asks for that
  exact reusable workflow.
- Do not use private or sensitive material as examples in generated assets.
- When config, prompt, agent, skill, MCP, or plugin files change, tell the user
  when it takes effect: oh-my-copilot-slim config and prompt-override changes
  apply to new sessions (prompt overrides and the preset are also re-applied
  when a session starts or resumes); `/preset` switches immediately for new
  subagent dispatches; skill, agent, and plugin file changes need a new
  session (or a `/plugin` reload).
