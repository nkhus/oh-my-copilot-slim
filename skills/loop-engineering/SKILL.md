---
name: loop-engineering
description: Loop engineering runtime Grill + Monitor for execute-verify loops started with /omcs-loop. Use when running a bounded retry loop where one agent executes, another check verifies, and results are kept in .slim/loop-history/.
---

<!-- Adapted from alvinunreal/oh-my-opencode-slim (MIT), src/skills/loop-engineering/SKILL.md (master @ 0656d3ef). Modified for GitHub Copilot; see NOTICE. -->

# Loop Engineering Skill

Loops are started with `/omcs-loop <description>` (upstream's `/loop`; `/loop`
is a Copilot built-in). The command gives you a history directory under
`.slim/loop-history/<loop-id>/`. Agents are the plugin's custom agents,
dispatched with the `task` tool (`agent_type: "oh-my-copilot-slim:<role>"`).

## Grill (orchestrator interview)

Ask with `ask_user`, one question at a time, only for what the description
leaves unclear:

1. Goal: "What are you trying to accomplish?"
2. Success criteria: "Describe how we know the loop succeeded."
3. Success type: choose from `test`, `build`, `lint`, `command`, `fileExists`, `oracle`, `observer`, `manual`. For CLI steps provide `successCommand`; for file detection provide `successPath`.
4. Execute agent: fixer / designer / explorer / librarian
5. Verify agent: oracle / observer / test
6. Max attempts (default 3)
7. Optional context files: which files or directories should be read before execution?

## Loop Monitor

There is no loop runtime with callbacks; the orchestrator runs the loop itself
and records every attempt in `.slim/loop-history/<loop-id>/history-NNN.md`
(PASS/FAIL + reason). Before each attempt, read the prior history files.

- After each attempt, report the current state and attempt count (e.g. `attempt 2 of 3: FAIL - 4 type errors remain`).
- On success → report the final outcome and stop.
- At max attempts, or when retries stop making progress → escalate to the human with the latest failure reason.
- For `manual` verification, present the failure reason (or the evidence) first, then ask the human pass/fail with `ask_user`; record the answer and reason in the history file.
- If the human cancels, stop dispatching, record `CANCELLED` in the history, and report where the loop stopped.
- Verify yourself (run the check, or dispatch the verify agent); never accept the execute agent's own claim of success.

## Notes
- Manual verification is the minimal on-ramp (autoresearch pattern). It pauses the loop until the human answers. Do not auto-resolve.
- Watch for repeated errors and timed-out or stuck background agents (`read_agent`) across attempts; treat them as signals to change the approach or escalate rather than retrying the same prompt.
