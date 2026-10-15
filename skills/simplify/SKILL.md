---
name: simplify
description: Reduce unnecessary complexity in code you are writing or reviewing - remove dead code, needless abstraction, duplication, and indirection while preserving behavior. Use when asked to simplify, clean up, or review for over-engineering.
---

<!-- Independently written for oh-my-copilot-slim. Not copied from oh-my-opencode-slim's simplify skill (which is adapted from a third-party skill). -->

# Simplify

Goal: the same behavior with less code, fewer concepts, and fewer places a
reader must look. Simplification is a refactor - behavior must not change.

## Process

1. **Pin behavior first.** Identify how the code is exercised: existing
   tests, call sites, public API. If nothing covers the code you'll touch,
   note it and keep changes mechanical.
2. **Find complexity that isn't earning its keep:**
   - Dead code: unused exports, params, branches, flags, commented-out code
   - Speculative generality: interfaces with one implementation, options
     nobody passes, plugin points with one plugin
   - Indirection: wrappers that only forward, layers that only rename
   - Duplication: repeated logic that has the same reason to change
   - Convoluted control flow: deep nesting, flag variables, early-return
     opportunities, boolean expressions that can be stated directly
   - Reinvented standard library or framework features
3. **Rank by payoff vs risk.** Prefer deletions and local rewrites over
   cross-cutting restructures.
4. **Apply small steps,** validating after each meaningful step.
5. **Report** what was removed or merged and why behavior is unchanged.

## Rules

- Don't change public APIs, persisted formats, or observable behavior
  unless explicitly asked.
- Duplication is cheaper than the wrong abstraction: only merge code that
  changes for the same reason.
- Don't trade clarity for brevity - clever one-liners are not simpler.
- Match the project's existing style and idioms.
- When reviewing (read-only), output a prioritized list:
  `file:line - problem - simpler alternative - risk`.
