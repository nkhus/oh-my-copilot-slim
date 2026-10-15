// Session hooks for oh-my-copilot-slim. Council keyword injection, the phase reminder,
// and the repeated-tool-call guard are adapted from alvinunreal/oh-my-opencode-slim (MIT),
// src/hooks/{council-inject,phase-reminder,tool-loop-guard}. Modified for GitHub Copilot; see NOTICE.
import { rt, normalizeRole, safe, log } from "./core.mjs";
import { loadConfig } from "./config.mjs";
import { callerRole, rootRole, resetRootCache, policyViolation, policyDecision, disabledAgentDecision } from "./policy.mjs";
import { matchesCouncilTrigger, COUNCIL_PROCEDURE } from "./council.mjs";
import { routeImages } from "./images.mjs";
import { applyPreset } from "./presets.mjs";
import { applyPromptOverrides, promptState } from "./prompts.mjs";

const reminder = (body) => `<system-reminder>\n${body}\n</system-reminder>`;

export const PHASE_REMINDER =
    "!IMPORTANT! Scheduler workflow: pick the lightest workflow that fits. Direct work: execute and verify proportionately. " +
    "Otherwise: plan lanes -> dispatch specialists with `task` (mode background for parallel lanes) -> track agent ids -> " +
    "let completion notifications resume you (read_agent once per finished lane) -> reconcile results -> verify. !END!";

// ---- tool-loop-guard ----------------------------------------------------------
export const LOOP_WARN_AT = 3;
export const LOOP_BLOCK_AT = 5;
const LOOP_EXEMPT = new Set(["task", "write_agent", "ask_user"]);
const LOOP_BLOCK_TOOLS = new Set(["view", "grep", "glob"]);
const MAX_TRACKED = 512;
export const LOOP_MARKER = "[REPEATED TOOL CALLS - STOP]";
export const LOOP_WARNING = `${LOOP_MARKER} You have issued the exact same tool call with identical arguments ${LOOP_WARN_AT} times in a row and received identical results. This is an infinite loop and you are making no progress.

STOP repeating this call. Instead:
1. Reconsider what you are looking for; the earlier result already contains what this call can tell you.
2. If you need different information, make a DIFFERENT call (different path, pattern, or tool).
3. If the task is actually done, produce your final answer now instead of calling more tools.`;

export function stableStringify(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    return `{${Object.keys(value)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
        .join(",")}}`;
}

const loopState = new Map();
const loopKey = (input) => `${input?.sessionId ?? "?"}|${input?.agentId ?? input?.agentType ?? "main"}`;
const callPrint = (input) => `${String(input?.toolName ?? "").toLowerCase()}:${stableStringify(input?.toolArgs ?? null)}`;
const resultPrint = (result) => stableStringify(result?.textResultForLlm ?? result ?? null);

export function loopGuardPre(input) {
    const tool = String(input?.toolName ?? "").toLowerCase();
    if (LOOP_EXEMPT.has(tool) || !LOOP_BLOCK_TOOLS.has(tool)) return undefined;
    const st = loopState.get(loopKey(input));
    if (st && st.last === callPrint(input) && st.runs >= LOOP_BLOCK_AT) {
        return {
            permissionDecision: "deny",
            permissionDecisionReason: `${LOOP_MARKER} Refusing to execute "${tool}": this exact call (same tool, same arguments) has returned identical results ${st.runs} times in a row. Stop repeating it. Reassess your goal, make a different call, or produce your final answer.`,
        };
    }
    return undefined;
}

export function loopGuardPost(input) {
    const tool = String(input?.toolName ?? "").toLowerCase();
    if (LOOP_EXEMPT.has(tool)) return undefined;
    const key = loopKey(input);
    const call = callPrint(input);
    const out = resultPrint(input?.toolResult);
    const prev = loopState.get(key);
    const runs = prev && prev.last === call ? (prev.lastOutput === out ? prev.runs + 1 : 1) : 1;
    loopState.delete(key);
    loopState.set(key, { last: call, lastOutput: out, runs });
    while (loopState.size > MAX_TRACKED) loopState.delete(loopState.keys().next().value);
    return runs >= LOOP_WARN_AT ? LOOP_WARNING : undefined;
}

// ---- image routing (attachments only arrive on the user.message event) ----------
const pendingImageNudge = new Map();
const promptSeen = new Map();

export async function onUserMessageEvent(event) {
    try {
        const data = event?.data ?? {};
        const attachments = data.attachments;
        if (!Array.isArray(attachments) || !attachments.length) return;
        const sessionId = event?.sessionId ?? rt.session?.sessionId;
        const cwd = rt.cwd ?? process.cwd();
        const cfg = loadConfig(cwd);
        const nudge = await routeImages({ attachments, cwd, sessionId, cfg });
        if (nudge) pendingImageNudge.set(sessionId ?? "?", nudge);
    } catch (err) {
        log(`[oh-my-copilot-slim] image routing failed: ${err?.message ?? err}`, "warning", true);
    }
}

function takeImageNudge(sessionId) {
    const k = sessionId ?? rt.session?.sessionId ?? "?";
    const v = pendingImageNudge.get(k) ?? pendingImageNudge.get("?");
    pendingImageNudge.delete(k);
    pendingImageNudge.delete("?");
    return v;
}

// ---- hook entry points ----------------------------------------------------------
const councilInjected = new Set();
const join = (...parts) => parts.filter(Boolean).join("\n\n") || undefined;

export async function onUserPromptSubmitted(input) {
    try {
        rt.cwd = input?.workingDirectory ?? rt.cwd;
        const cfg = loadConfig(input?.workingDirectory);
        resetRootCache();
        const role = await rootRole();
        const parts = [];
        if (role === "orchestrator") {
            const sid = input?.sessionId ?? "?";
            if (cfg.hookEnabled("council-inject") && !councilInjected.has(sid) && matchesCouncilTrigger(input?.prompt)) {
                councilInjected.add(sid);
                parts.push(reminder(COUNCIL_PROCEDURE));
            }
            if (cfg.hookEnabled("phase-reminder")) parts.push(reminder(PHASE_REMINDER));
        }
        // Give the user.message event (which carries attachments) a moment to arrive.
        promptSeen.set(input?.sessionId ?? "?", Date.now());
        await new Promise((r) => setTimeout(r, 25));
        parts.push(takeImageNudge(input?.sessionId));
        const additionalContext = join(...parts);
        return additionalContext ? { additionalContext } : undefined;
    } catch {
        return undefined;
    }
}

export async function onPreToolUse(input) {
    try {
        rt.cwd = input?.workingDirectory ?? rt.cwd;
        const cfg = loadConfig(input?.workingDirectory);
        const toolName = String(input?.toolName ?? "");
        const hard = disabledAgentDecision(cfg, toolName, input?.toolArgs);
        if (hard) return hard;
        if (cfg.hookEnabled("tool-loop-guard")) {
            const blocked = loopGuardPre(input);
            if (blocked) return blocked;
        }
        const { role, child } = await callerRole(input);
        const decision = cfg.enforcement === "off" ? undefined : policyDecision(cfg, await policyViolation(cfg, toolName, input?.toolArgs, role));
        const late = child ? undefined : takeImageNudge(input?.sessionId);
        if (late && decision?.permissionDecision !== "deny") return { ...(decision ?? {}), additionalContext: join(decision?.additionalContext, late) };
        return decision;
    } catch {
        return undefined;
    }
}

export async function onPostToolUse(input) {
    try {
        const cfg = loadConfig(input?.workingDirectory);
        const warning = cfg.hookEnabled("tool-loop-guard") ? loopGuardPost(input) : undefined;
        return warning ? { additionalContext: warning } : undefined;
    } catch {
        return undefined;
    }
}

export async function onSubagentStart(input) {
    try {
        const role = normalizeRole(input?.agentName);
        if (!role) return undefined;
        const cfg = loadConfig(input?.workingDirectory);
        const def = cfg.roles[role];
        const parts = [];
        if (def)
            parts.push(
                `[oh-my-copilot-slim] Role policy for ${role}: skills ${JSON.stringify(def.skills ?? ["*"])}, ` +
                    `MCP servers ${JSON.stringify(def.mcps ?? ["*"])}. Only load skills and use MCP servers allowed here.`,
            );
        const append = promptState.fallbackAppend.get(role);
        if (append) parts.push(`[oh-my-copilot-slim] Additional instructions (${role}_append.md):\n${append}`);
        const additionalContext = join(...parts);
        return additionalContext ? { additionalContext } : undefined;
    } catch {
        return undefined;
    }
}

// Overrides are in-memory, so re-apply them whenever a session starts or resumes.
export async function onSessionStart(input) {
    try {
        rt.cwd = input?.workingDirectory ?? rt.cwd;
        await refreshRuntime(input?.workingDirectory);
    } catch {
        /* reported by omcs_doctor */
    }
    return undefined;
}

export async function refreshRuntime(cwd) {
    const dir = cwd ?? rt.cwd ?? process.cwd();
    const [preset, prompts] = await Promise.all([safe(() => applyPreset(dir)), safe(() => applyPromptOverrides(dir))]);
    return { preset, prompts };
}
