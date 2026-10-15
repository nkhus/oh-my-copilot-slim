---
name: interview
description: Refine a rough feature idea into a clear markdown spec through a short Q&A with the user (ask_user), grounded in the current repository. Use for /interview, or when the user wants to think through, scope, or spec a feature before building it.
---

<!-- Independently written for oh-my-copilot-slim; the workflow follows alvinunreal/oh-my-opencode-slim's /interview (MIT, docs/interview.md). See NOTICE. -->

# Interview

Turn a rough idea into a spec the team can build from, by asking the user a
few focused questions and grounding the answers in the repository.

Upstream opens a local browser UI for this; here the interview runs in chat
with the `ask_user` tool. There is no browser UI.

## Output location

Write the spec to `interview/<slug>.md` in the current repository by default.
The `/interview` command states the configured directory
(`interview.outputDir` in oh-my-copilot-slim config); use that when given.

- `<slug>`: short kebab-case name derived from the idea (e.g.
  `offline-sync`).
- Create the directory if needed.
- Never overwrite an existing file without asking. If `<slug>.md` exists, ask
  (`ask_user`) whether to update that spec or pick a new slug.

## Workflow

### 1. Understand the starting point

- If no idea was given, ask what the user wants to build.
- Ground yourself before asking: skim the README, `AGENTS.md`, and the code
  areas the idea touches. For anything beyond a quick look, dispatch the
  explorer (`task` tool, `agent_type: "oh-my-copilot-slim:explorer"`) with a
  bounded question such as "where is X handled and what are its extension
  points?". Ask the librarian
  (`agent_type: "oh-my-copilot-slim:librarian"`) only when the idea depends
  on an external library or service whose behavior matters.
- Don't ask the user what the repository can answer.

### 2. Ask focused questions

- One question per `ask_user` call. Make it concrete and answerable.
- Prefer multiple-choice: offer 2-5 `choices` that reflect real options found
  in the repo, with your recommended option first. Allow freeform answers.
- Order questions by impact: scope and goals first, then users and flows,
  then interface, then technical constraints, then acceptance.
- Use each answer to shape the next question; skip questions already
  answered.
- Plan for 3-8 rounds. Stop when the spec is clear enough to build from, or
  when the user says they are done. If important points remain open, record
  them under Risks & Open Questions instead of asking more.
- Keep a running list of every question and answer for the appendix.

### 3. Write the spec

Use these sections, in order. Keep each one short and concrete; write "None"
or "N/A" rather than padding.

```markdown
# <Feature name>

## Summary
## Problem & Goals
## Non-goals
## Users & Use Cases
## Requirements
<!-- functional requirements, numbered -->
## Non-functional Requirements
## UX / Interface
## Technical Approach
<!-- grounded in the repo: files, modules, patterns, and integration points to use -->
## Risks & Open Questions
## Acceptance Criteria
<!-- checkable statements -->
## Milestones

## Appendix: Q&A history
1. **Q:** <question>
   **A:** <answer>
```

- State assumptions you made explicitly and mark them as assumptions.
- Reference real paths in Technical Approach; don't invent modules.
- Acceptance criteria must be verifiable (a test, a command, an observable
  behavior).

### 4. Hand off

Report the spec path and a two-line summary, then offer next steps, for
example:

- `/deepwork implement the spec in interview/<slug>.md` for large work;
- delegate a bounded milestone to the fixer for small work;
- continue the interview to resolve the open questions.

Do not start implementing unless the user asks.
