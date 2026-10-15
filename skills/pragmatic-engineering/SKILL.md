---
name: pragmatic-engineering
description: Pragmatic implementation discipline - build the smallest correct change, validate it, and avoid gold-plating. Use when implementing features or fixes where scope, risk, and verification matter.
---

<!-- Independently written for oh-my-copilot-slim. "pragmatic-engineering" is not a bundled oh-my-opencode-slim skill; a user or project skill with the same name takes precedence over this one. -->

# Pragmatic engineering

## Before changing code
- Restate the concrete outcome and how it will be verified.
- Read the code you'll change and its nearest callers/tests. Follow existing
  patterns over personal preference.
- Identify the smallest change that fully solves the problem. Complete
  beats minimal-but-broken; minimal beats speculative.

## While changing code
- YAGNI: no options, hooks, or abstractions without a current caller.
- Keep diffs focused; don't mix refactors with behavior changes unless
  the refactor is required for the change.
- Handle realistic failure modes at boundaries (I/O, user input, network);
  don't add defensive code for impossible internal states.
- Prefer boring, well-known solutions and existing dependencies.
- Leave the code at least as clear as you found it; comment only the
  non-obvious "why".

## Verify
- Run the narrowest check that proves the change (targeted test, type
  check, lint, or a reproduction), then broaden only if needed.
- Reproduce a bug before fixing it when practical; confirm it's gone after.
- Don't report success you haven't observed. Say what was not verified.

## Report
- What changed (files), why, how it was verified, and any known risks or
  follow-ups - briefly.
