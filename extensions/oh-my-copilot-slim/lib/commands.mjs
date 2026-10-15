// Slash commands registered as native extension commands (kind "client").
// Prompt templates adapted from alvinunreal/oh-my-opencode-slim (MIT), src/hooks/{deepwork,reflect,loop-command}/index.ts.
// Modified for GitHub Copilot; see NOTICE.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { rt, PLUGIN_ROOT, log, safe, confirmWithUser, copilotHome } from "./core.mjs";
import { loadConfig, modelChain, pickModel } from "./config.mjs";
import { listPresets, switchPreset, runtimeSnapshot } from "./presets.mjs";
import { rootAgent } from "./policy.mjs";

const stripFrontmatter = (text) => text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").replace(/^\s*<!--[\s\S]*?-->\s*/, "").trim();
export const skillBody = (name) => stripFrontmatter(readFileSync(join(PLUGIN_ROOT, "skills", name, "SKILL.md"), "utf8"));

// Commands run while the agent is idle; queue the prompt after the handler returns.
function sendPrompt(prompt, displayPrompt) {
    setTimeout(() => {
        void safe(() => rt.session.send({ prompt, displayPrompt })).then((r) => {
            if (!r.ok) log(`oh-my-copilot-slim: could not send command prompt: ${r.error}`, "error");
        });
    }, 0);
}

const shortId = () => randomBytes(3).toString("hex");

export function deepworkPrompt(task, sessionId) {
    return [skillBody("deepwork"), "", `Your deepwork router head is \`.slim/deepwork/${sessionId}.md\`; the skill covers setup, planning, gates, and state rules.`, "", "Task:", task].join("\n");
}

export function parseReflectArgs(raw) {
    const args = raw.trim();
    const sessions = /(^|\s)--sessions\b/.test(args);
    const m = /--last\s+(\d+)/.exec(args);
    const last = m ? Math.min(Math.max(parseInt(m[1], 10), 1), 100) : 50;
    const focus = args.replace(/--sessions\b/g, "").replace(/--last\s+\d+/g, "").trim();
    return { sessions, last, focus };
}

export function reflectPrompt({ sessions, last, focus }) {
    const mode = sessions
        ? [
              "",
              "Session Reflection Mode:",
              `- Analyze the last ${last} sessions (use --last N to adjust)`,
              `- Prefer the session_store_sql tool (Copilot session history) when it is available; otherwise read local session data under ${join(copilotHome(), "session-state")}/<id>/ (events.jsonl, checkpoints) read-only`,
              "- Analyze each session for patterns and friction",
              "- Aggregate findings across all sessions",
              "- Report with scope (global/cross-repo/project-specific), confidence, and impact",
          ]
        : [];
    return [
        "Use the reflect skill (oh-my-copilot-slim:reflect) for this request.",
        "",
        "Reflect requirements:",
        "- inspect existing skills, agents, prompt overrides, MCP access, oh-my-copilot-slim config, custom instructions, and project playbooks before suggesting anything new;",
        "- find repeated workflow patterns from the current conversation, project notes, logs, or session artifacts that are available and safe to inspect;",
        "- prefer evidence from repeated recent behavior over speculation;",
        "- recommend the smallest useful improvement: prompt/config rule, skill, command, custom agent, MCP/tool access change, project playbook, or skip;",
        "- treat creating nothing as a valid result when evidence is weak;",
        "- ask before changing prompts, skills, agents, MCP access, or config unless the user explicitly requested the exact edit;",
        "- return a compact report with findings, recommended changes, skipped candidates, and items needing more evidence.",
        ...mode,
        "",
        "Focus:",
        focus || (sessions ? "Analyze recent sessions to find repeated patterns, friction, and improvement opportunities." : "Review recent work broadly and identify repeated workflow friction worth improving."),
    ].join("\n");
}

export const LOOP_HELP = [
    "Usage: /omcs-loop <description>",
    "",
    "Describe what to accomplish, what success looks like, and how many tries.",
    "",
    "Examples:",
    "  /omcs-loop fix typescript errors until typecheck passes, max 3 tries",
    "  /omcs-loop improve api performance until response under 500ms, try 5 times",
    "  /omcs-loop refactor auth module, tests must pass, 4 attempts max",
].join("\n");

export function loopPrompt(text, dir = `.slim/loop-history/loop-${Date.now().toString(36)}-${shortId()}`) {
    return [
        "The user ran `/omcs-loop`. From the text below, extract: goal, successCriteria, maxAttempts.",
        "",
        "If ANY are missing or unclear - push back and ask the user to clarify (ask_user).",
        "Do not assume or guess. All three must be explicit.",
        "",
        "Once all three are clear, run the loop (see the loop-engineering skill for guidance):",
        "",
        text,
        "",
        "For each attempt:",
        `1. Read \`${dir}/\` for prior results`,
        "2. Dispatch the fixer (task tool, agent_type oh-my-copilot-slim:fixer) with the goal and prior failures",
        "3. Verify per the successCriteria yourself (run the check; do not trust the fixer's claim)",
        `4. Write the result to \`${dir}/history-{NNN}.md\` (PASS/FAIL + reason)`,
        "5. PASS -> stop. FAIL under maxAttempts -> retry. FAIL at max -> escalate to the user.",
    ].join("\n");
}

export function interviewPrompt(idea, cfg) {
    const outDir = cfg.interview?.outputDir ?? "interview";
    return [
        "Use the interview skill (oh-my-copilot-slim:interview) for this request.",
        `Write the final spec to \`${outDir}/<slug>.md\` in the current repository (create the folder if needed; never overwrite an existing file without asking).`,
        "",
        idea ? `Idea:\n${idea}` : "No idea was given yet: start by asking the user what they want to build.",
    ].join("\n");
}

const commandEnabled = (name) => loadConfig(rt.cwd ?? process.cwd()).disabled_commands?.includes(name) !== true;

function guarded(name, fn) {
    return async (ctx) => {
        if (!commandEnabled(name)) {
            log(`oh-my-copilot-slim: /${name} is disabled by disabled_commands in oh-my-copilot-slim.json.`, "warning");
            return;
        }
        try {
            await fn((ctx?.args ?? "").trim(), ctx);
        } catch (err) {
            log(`oh-my-copilot-slim: /${name} failed: ${err?.message ?? err}`, "error");
        }
    };
}

async function maybeSwitchMainModel(roles) {
    const root = await rootAgent();
    if (root.role !== "orchestrator" || !roles?.orchestrator) return undefined;
    const snap = await runtimeSnapshot();
    const { pick } = pickModel(modelChain(roles.orchestrator), snap.modelById);
    if (!pick?.id) return undefined;
    const cur = await safe(() => rt.session.rpc.model.getCurrent());
    if (cur.ok && cur.value?.modelId === pick.id) return undefined;
    const ok = await confirmWithUser(`The preset's orchestrator model is ${pick.id}${pick.effort ? ` (${pick.effort})` : ""}, but this session uses ${cur.ok ? cur.value?.modelId ?? "an unknown model" : "an unknown model"}. Switch the session model now?`);
    if (ok !== true) return `Main session model unchanged${ok === undefined ? " (no confirmation UI; use /model to switch)" : ""}.`;
    const sw = await safe(() => rt.session.rpc.model.switchTo({ modelId: pick.id, ...(pick.effort ? { reasoningEffort: pick.effort } : {}) }));
    return sw.ok ? `Switched the session model to ${pick.id}.` : `Could not switch the session model: ${sw.error}`;
}

export const commands = [
    {
        name: "deepwork",
        description: "oh-my-copilot-slim: run a complex task through the deepwork phases (plan, gates, verified execution)",
        handler: guarded("deepwork", async (args, ctx) => {
            if (!args) return log("What task should deepwork manage? Run /deepwork <task>.", "warning");
            sendPrompt(deepworkPrompt(args, ctx?.sessionId ?? rt.session?.sessionId), `/deepwork ${args}`);
        }),
    },
    {
        name: "reflect",
        description: "oh-my-copilot-slim: review repeated work and suggest workflow improvements [--sessions] [--last N] [focus]",
        handler: guarded("reflect", async (args) => sendPrompt(reflectPrompt(parseReflectArgs(args)), `/reflect ${args}`.trim())),
    },
    {
        name: "omcs-loop",
        description: "oh-my-copilot-slim: execute-verify loop with the fixer and on-disk history (upstream /loop)",
        handler: guarded("omcs-loop", async (args) => {
            if (!args) return log(LOOP_HELP);
            sendPrompt(loopPrompt(args), `/omcs-loop ${args}`);
        }),
    },
    {
        name: "interview",
        description: "oh-my-copilot-slim: refine a feature idea through Q&A and save a markdown spec in the repo",
        handler: guarded("interview", async (args) => sendPrompt(interviewPrompt(args, loadConfig(rt.cwd ?? process.cwd())), `/interview ${args}`.trim())),
    },
    {
        name: "preset",
        description: "oh-my-copilot-slim: list presets, or switch with /preset <name> (saved to your user config)",
        handler: guarded("preset", async (args) => {
            const cwd = rt.cwd ?? process.cwd();
            if (!args) return log(listPresets(cwd));
            const res = await switchPreset(cwd, args.split(/\s+/)[0]);
            if (!res.ok) return log(res.message, "error");
            const main = await maybeSwitchMainModel(loadConfig(cwd).roles);
            log([res.message, main].filter(Boolean).join("\n\n"));
        }),
    },
];
