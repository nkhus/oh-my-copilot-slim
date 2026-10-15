// Runtime preset application: resolves the active preset (with `extends` and model
// fallback chains) and applies differences from the agent files as a live, per-session
// subagent override via session.rpc.tools.updateSubagentSettings (experimental API).
// Independently written; preset semantics follow upstream oh-my-opencode-slim (see NOTICE).
import { rt, ROLES, EFFORTS, asArray, safe, normalizeRole, log, readJson } from "./core.mjs";
import { loadConfig, modelChain, pickModel, persistConfigKey, resolvePreset, runtimePreset } from "./config.mjs";

export const presetState = { applied: false, lastPlan: undefined, lastError: undefined };

export async function runtimeSnapshot() {
    const s = rt.session;
    const [models, agents] = await Promise.all([safe(() => s.rpc.model.list()), safe(() => s.rpc.agent.list({}))]);
    const modelList = models.ok ? asArray(models.value, "list").concat(asArray(models.value, "models")) : [];
    return {
        modelsOk: models.ok,
        agentsOk: agents.ok,
        modelById: models.ok ? new Map(modelList.filter((m) => m?.id).map((m) => [m.id, m])) : undefined,
        agents: agents.ok ? asArray(agents.value, "agents") : [],
    };
}

export const agentForRole = (agents, role) =>
    agents.find((a) => a?.source === "plugin" && normalizeRole(a?.id) === role) ??
    agents.find((a) => String(a?.id ?? "").startsWith("oh-my-copilot-slim") && normalizeRole(a?.id) === role);

function effortSupported(info, effort) {
    if (!info || !effort) return true;
    if (info.capabilities?.supports?.reasoningEffort === false) return false;
    const supported = info.supportedReasoningEfforts ?? [];
    return !supported.length || supported.includes(effort);
}

// Pure planning step: what the active preset wants vs what the agent files declare.
export function planPreset(cfg, snap) {
    const rows = [];
    const agentsMap = {};
    const disabled = [];
    for (const role of ROLES) {
        const reg = agentForRole(snap.agents, role);
        const def = cfg.roles[role];
        const row = { role, agentId: reg?.id, registered: Boolean(reg), notes: [] };
        rows.push(row);
        if (!cfg.agentEnabled(role)) {
            row.disabled = true;
            if (reg?.id) disabled.push(reg.id);
            continue;
        }
        if (!def) continue;
        const chain = modelChain(def);
        const { pick, info, skipped, unverified } = pickModel(chain, snap.modelById);
        row.chain = chain.map((c) => c.id);
        row.skipped = skipped;
        row.model = pick?.id;
        if (chain.length && !pick) row.notes.push(`no model in chain [${row.chain.join(", ")}] is available; Copilot falls back to the session model`);
        if (unverified) row.notes.push("model availability unverified");
        let effort = pick?.effort;
        if (effort && !EFFORTS.includes(effort)) {
            row.notes.push(`unknown effort "${effort}" ignored`);
            effort = undefined;
        } else if (effort && !effortSupported(info, effort)) {
            row.notes.push(`effort "${effort}" unsupported by ${pick.id} (supported: ${(info.supportedReasoningEfforts ?? []).join(",") || "none"}); model default used`);
            effort = undefined;
        }
        row.effort = effort;
        if (!reg?.id) continue;
        const authoredModels = reg.models?.length ? reg.models : reg.model ? [reg.model] : [];
        const entry = {};
        // Native fallback: if the agent file already lists the same first choice, Copilot handles fallback itself.
        if (pick && authoredModels[0] !== pick.id) entry.model = pick.id;
        if (effort && effort !== reg.reasoningEffort) entry.effortLevel = effort;
        if (pick && entry.model && !effort && reg.reasoningEffort) row.notes.push(`authored effort ${reg.reasoningEffort} kept by Copilot unless the preset sets one`);
        if (Object.keys(entry).length) {
            agentsMap[reg.id] = entry;
            row.override = entry;
        }
    }
    const settings = Object.keys(agentsMap).length || disabled.length ? { agents: agentsMap, disabledSubagents: disabled } : null;
    return { rows, settings };
}

// Apply (or clear) the live override. Only calls the API when there is something to change.
export async function applyPreset(cwd, { force = false } = {}) {
    const cfg = loadConfig(cwd);
    const snap = await runtimeSnapshot();
    if (!cfg.hookEnabled("preset-apply") || cfg.apply_preset === "off") {
        if (presetState.applied) await safe(() => rt.session.rpc.tools.updateSubagentSettings({ subagents: null }));
        presetState.applied = false;
        presetState.lastPlan = { rows: [], settings: null, skipped: "preset application is turned off (apply_preset/disabled_hooks)" };
        return presetState.lastPlan;
    }
    if (!snap.agentsOk) {
        presetState.lastError = "agent.list unavailable; preset not applied";
        return { rows: [], settings: null, error: presetState.lastError };
    }
    const plan = planPreset(cfg, snap);
    presetState.lastPlan = plan;
    if (!plan.settings && !presetState.applied && !force) return plan;
    const res = await safe(() => rt.session.rpc.tools.updateSubagentSettings({ subagents: plan.settings }));
    if (!res.ok) {
        presetState.lastError = res.error;
        log(`[oh-my-copilot-slim] could not apply preset "${cfg.preset}" live: ${res.error}. Agent files' models/efforts are used.`, "warning");
        return { ...plan, error: res.error };
    }
    presetState.applied = Boolean(plan.settings);
    presetState.lastError = undefined;
    return plan;
}

export function describePlan(plan) {
    const lines = [];
    for (const r of plan.rows ?? []) {
        if (r.disabled) {
            lines.push(`- ${r.role}: DISABLED (disabled_agents)`);
            continue;
        }
        const parts = [];
        if (r.model) parts.push(`model ${r.model}${r.skipped?.length ? ` (skipped: ${r.skipped.join("; ")})` : ""}`);
        if (r.effort) parts.push(`effort ${r.effort}`);
        parts.push(r.override ? `live override ${JSON.stringify(r.override)}` : r.registered ? "matches agent file" : "agent not registered");
        lines.push(`- ${r.role}: ${parts.join(", ")}${r.notes.length ? `; ${r.notes.join("; ")}` : ""}`);
    }
    if (plan.skipped) lines.push(`- ${plan.skipped}`);
    if (plan.error) lines.push(`- NOT APPLIED: ${plan.error}`);
    return lines.join("\n");
}

export function listPresets(cwd) {
    const cfg = loadConfig(cwd);
    const lines = [`Active preset: ${cfg.preset ?? "(none)"}${runtimePreset.name ? " (switched in this session)" : cfg.presetSource ? ` (from ${cfg.presetSource} config)` : ""}`, "", "Presets:"];
    for (const [name, p] of Object.entries(cfg.presets)) {
        const r = resolvePreset(cfg.presets, name);
        lines.push(`- ${name}${name === cfg.preset ? " *" : ""}${p.extends ? ` (extends ${p.extends})` : ""}${r.error ? ` - INVALID: ${r.error}` : ""}`);
    }
    lines.push("", "Switch with /preset <name>. The choice is saved to your user config and applied to new subagent dispatches; running agents keep their model.");
    return lines.join("\n");
}

export async function switchPreset(cwd, name) {
    const cfg = loadConfig(cwd);
    if (!cfg.presets[name]) return { ok: false, message: `Unknown preset "${name}". Available: ${Object.keys(cfg.presets).join(", ") || "none"}.` };
    const resolved = resolvePreset(cfg.presets, name);
    if (resolved.error) return { ok: false, message: `Preset "${name}" is invalid: ${resolved.error}.` };
    const notes = [];
    try {
        persistConfigKey(cfg.paths.user, "preset", name);
        notes.push(`Saved "preset": "${name}" to ${cfg.paths.user}.`);
    } catch (err) {
        notes.push(`Not saved: ${err?.message ?? err}. The switch applies to this session only.`);
    }
    const project = readJson(cfg.paths.project);
    if (project.ok && typeof project.value?.preset === "string" && project.value.preset !== name)
        notes.push(`Note: ${cfg.paths.project} pins "preset": "${project.value.preset}", which wins in future sessions for this repository.`);
    runtimePreset.name = name;
    const plan = await applyPreset(cwd, { force: true });
    return { ok: true, message: [`Switched to preset "${name}".`, ...notes, "", describePlan(plan)].join("\n"), plan, roles: resolved.roles };
}
