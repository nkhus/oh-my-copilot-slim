// Project-local and user prompt overrides: <role>.md replaces and <role>_append.md
// appends to a team agent's prompt, applied in memory via session.rpc.agent.setPrompt.
// Independently written; lookup order follows upstream oh-my-opencode-slim
// docs/project-local-customization.md (see NOTICE).
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { rt, ROLES, PLUGIN_NAME, userDataDir, repoRoot, safe, asArray, normalizeRole, log } from "./core.mjs";
import { loadConfig } from "./config.mjs";

const SAFE_PRESET = /^[A-Za-z0-9][\w.-]*$/;
export const promptState = { applied: new Map(), errors: [], fallbackAppend: new Map() };

// Directories searched nearest-first: per directory, preset subdir then root.
export async function promptDirs(cwd, preset) {
    const dirs = [];
    const real = (p) => {
        try {
            return realpathSync(p);
        } catch {
            return resolve(p);
        }
    };
    const top = real((await repoRoot(cwd)) ?? cwd);
    let dir = real(cwd);
    for (let i = 0; i < 64; i++) {
        dirs.push({ label: "project", path: join(dir, ".github", PLUGIN_NAME) });
        if (dir === top) break;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    dirs.push({ label: "user", path: userDataDir() });
    const out = [];
    for (const d of dirs) {
        if (preset && SAFE_PRESET.test(preset)) out.push({ ...d, label: `${d.label} (${preset})`, path: join(d.path, preset) });
        out.push(d);
    }
    return out;
}

function firstFile(dirs, file) {
    for (const d of dirs) {
        const p = join(d.path, file);
        if (existsSync(p)) {
            try {
                return { path: p, label: d.label, text: readFileSync(p, "utf8") };
            } catch {
                /* unreadable: keep searching */
            }
        }
    }
    return undefined;
}

// The runtime omits authored prompts for plugin agents in agent.list, so read the
// agent file body (after frontmatter) when needed. Returns undefined if unknown.
export function stripFrontmatter(text) {
    const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
    return (m ? text.slice(m[0].length) : text).replace(/^\s+/, "");
}

function authoredPrompt(agent) {
    if (typeof agent?.prompt === "string" && agent.prompt.trim()) return agent.prompt;
    if (typeof agent?.path === "string" && agent.path.endsWith(".md")) {
        try {
            const body = stripFrontmatter(readFileSync(agent.path, "utf8"));
            if (body.trim()) return body;
        } catch {
            /* unreadable */
        }
    }
    return undefined;
}

// Resolve the override for one role: base = inline prompt ?? file ?? default; then append.
export function resolveRolePrompt(def, dirs, role) {
    const file = firstFile(dirs, `${role}.md`);
    const append = firstFile(dirs, `${role}_append.md`);
    const inline = typeof def?.prompt === "string" ? def.prompt : undefined;
    const notes = [];
    if (inline !== undefined && file) notes.push(`inline prompt overrides prompt file ${file.path}`);
    return { inline, file, append, notes, any: inline !== undefined || Boolean(file) || Boolean(append) };
}

export async function applyPromptOverrides(cwd) {
    const cfg = loadConfig(cwd);
    const s = rt.session;
    promptState.errors = [];
    promptState.fallbackAppend.clear();
    if (!cfg.hookEnabled("prompt-overrides")) return [];
    const dirs = await promptDirs(cwd, cfg.preset);
    const list = await safe(() => s.rpc.agent.list({ includePrompt: true }));
    if (!list.ok) {
        promptState.errors.push(`agent.list unavailable: ${list.error}`);
        return [];
    }
    const agents = asArray(list.value, "agents").filter((a) => String(a?.id ?? "").startsWith(PLUGIN_NAME));
    const report = [];
    for (const role of ROLES) {
        const agent = agents.find((a) => normalizeRole(a.id) === role);
        if (!agent) continue;
        const r = resolveRolePrompt(cfg.roles[role], dirs, role);
        const prev = promptState.applied.get(agent.id);
        if (!r.any) {
            // Restore the authored prompt if an override was removed during this session.
            if (prev && prev.original !== undefined) {
                const res = await safe(() => s.rpc.agent.setPrompt({ id: agent.id, prompt: prev.original }));
                if (res.ok) promptState.applied.delete(agent.id);
            } else if (prev) {
                promptState.errors.push(`${role}: override removed but authored prompt unknown; start a new session to restore it`);
            }
            continue;
        }
        const original = prev?.original ?? authoredPrompt(agent);
        if (r.inline === undefined && !r.file && original === undefined) {
            // Append-only, but the authored prompt is unknown: never replace the role
            // prompt with just the appended text; deliver it as subagent context instead.
            promptState.fallbackAppend.set(role, r.append.text);
            promptState.errors.push(`${role}: authored prompt unavailable; append delivered as subagent context`);
            report.push(`${role}: append: ${r.append.path} (as subagent context)`);
            continue;
        }
        const base = r.inline ?? r.file?.text ?? original;
        const finalPrompt = r.append ? `${base}\n\n${r.append.text}` : base;
        const sources = [r.inline !== undefined ? "inline config prompt" : r.file ? `replace: ${r.file.path}` : undefined, r.append ? `append: ${r.append.path}` : undefined].filter(Boolean);
        const res = await safe(() => s.rpc.agent.setPrompt({ id: agent.id, prompt: finalPrompt }));
        if (res.ok) {
            promptState.applied.set(agent.id, { original, sources });
            report.push(`${role}: ${sources.join(", ")}`);
        } else {
            promptState.errors.push(`${role}: setPrompt failed (${res.error})`);
            // Honest fallback: an append can still be delivered as subagent context; a replacement cannot.
            if (r.append) promptState.fallbackAppend.set(role, r.append.text);
            log(`[oh-my-copilot-slim] prompt override for ${role} not applied: ${res.error}${r.append ? " (append delivered as subagent context instead)" : ""}`, "warning");
        }
        for (const n of r.notes) report.push(`${role}: ${n}`);
    }
    return report;
}
