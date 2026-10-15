// Configuration loading for oh-my-copilot-slim: layered JSON config, preset
// inheritance (`extends`), model fallback chains, and safe persistence.
// Independently written; config keys follow upstream oh-my-opencode-slim (see NOTICE).
import { writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { PLUGIN_ROOT, CONFIG_FILE, ROLES, HOOK_NAMES, COMMAND_NAMES, copilotHome, readJson, nativeModel, effortOf } from "./core.mjs";

export const configPaths = (cwd) => ({
    plugin: join(PLUGIN_ROOT, "presets", "github-copilot.json"),
    user: join(copilotHome(), CONFIG_FILE),
    project: join(cwd || process.cwd(), ".github", CONFIG_FILE),
});

// In-memory preset selected with /preset in this extension process; wins over every config layer.
export const runtimePreset = { name: undefined };

const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : undefined);

// Resolve a preset's roles through its single-parent `extends` chain (ancestor < child).
export function resolvePreset(presets, name) {
    const chain = [];
    let cur = name;
    while (cur !== undefined) {
        if (chain.includes(cur)) return { roles: {}, chain, error: `preset inheritance cycle: ${[...chain, cur].join(" -> ")}` };
        if (!presets[cur]) {
            const msg = chain.length ? `preset "${chain.at(-1)}" extends unknown preset "${cur}"` : `preset "${cur}" not found`;
            return { roles: {}, chain, error: msg };
        }
        chain.push(cur);
        const parent = presets[cur].extends;
        cur = typeof parent === "string" && parent ? parent : undefined;
    }
    const roles = {};
    for (const presetName of [...chain].reverse()) {
        for (const [role, def] of Object.entries(presets[presetName])) {
            if (role === "extends" || !def || typeof def !== "object") continue;
            roles[role] = { ...(roles[role] ?? {}), ...def };
        }
    }
    return { roles, chain };
}

// Normalize upstream `model` (string, or array of strings / {id, variant}) into a chain.
export function modelChain(def) {
    const raw = Array.isArray(def?.model) ? def.model : def?.model !== undefined ? [def.model] : [];
    const fallbackEffort = effortOf(def);
    const out = [];
    for (const entry of raw) {
        if (typeof entry === "string") out.push({ id: nativeModel(entry), effort: fallbackEffort });
        else if (entry && typeof entry.id === "string") out.push({ id: nativeModel(entry.id), effort: effortOf(entry) ?? fallbackEffort });
    }
    return out.filter((e) => e.id);
}

// Pick the first available model of a chain. `available` is a Map id -> model info (or undefined = unknown).
export function pickModel(chain, available) {
    if (!chain.length) return { pick: undefined, skipped: [] };
    if (!available) return { pick: chain[0], skipped: [], unverified: true };
    const skipped = [];
    for (const entry of chain) {
        const info = available.get(entry.id);
        if (info && (!info.policy?.state || info.policy.state === "enabled")) return { pick: entry, info, skipped };
        skipped.push(info ? `${entry.id} (policy: ${info.policy.state})` : `${entry.id} (not available)`);
    }
    return { pick: undefined, skipped };
}

// Upstream skills_add / skills_remove: applied after all layers; remove wins; "*" lists use "!name".
export function foldSkillDirectives(def) {
    const add = strList(def.skills_add) ?? [];
    const remove = strList(def.skills_remove) ?? [];
    if (!add.length && !remove.length) return def;
    const { skills_add, skills_remove, ...rest } = def;
    let skills = Array.isArray(def.skills) ? [...def.skills] : ["*"];
    for (const s of add) if (!skills.includes(s)) skills.push(s);
    if (skills.includes("*")) {
        for (const s of remove) if (!skills.includes(`!${s}`)) skills.push(`!${s}`);
    } else skills = skills.filter((s) => !remove.includes(s));
    return { ...rest, skills: [...new Set(skills)] };
}

export function loadConfig(cwd) {
    const paths = configPaths(cwd);
    const layers = [
        { label: "plugin default", path: paths.plugin },
        { label: "user", path: paths.user },
        { label: "project", path: paths.project },
    ];
    const sources = [];
    const warnings = [];
    const merged = {
        preset: undefined,
        presetSource: undefined,
        presets: {},
        council: { councillors: [] },
        enforcement: "deny",
        disabled_hooks: [],
        disabled_agents: [],
        disabled_commands: [],
        image_routing: undefined,
        apply_preset: "auto",
        acpAgents: {},
        interview: { outputDir: "interview" },
        agents: {},
    };
    for (const layer of layers) {
        const res = readJson(layer.path);
        if (res.missing) continue;
        if (!res.ok) {
            sources.push(`${layer.label}: ${layer.path} (INVALID JSON, ignored: ${res.error})`);
            warnings.push(`${layer.label} config ${layer.path} is invalid JSON and was ignored.`);
            continue;
        }
        sources.push(`${layer.label}: ${layer.path}`);
        const cfg = res.value ?? {};
        if (typeof cfg.preset === "string") {
            merged.preset = cfg.preset;
            merged.presetSource = layer.label;
        }
        for (const [name, preset] of Object.entries(cfg.presets ?? {})) {
            if (!preset || typeof preset !== "object") continue;
            merged.presets[name] ??= {};
            for (const [role, def] of Object.entries(preset)) {
                if (role === "extends") merged.presets[name].extends = def;
                else if (def && typeof def === "object") merged.presets[name][role] = { ...(merged.presets[name][role] ?? {}), ...def };
            }
        }
        // Root `agents.<role>` entries beat the active preset (upstream precedence).
        for (const [role, def] of Object.entries(cfg.agents ?? {})) {
            if (def && typeof def === "object") merged.agents[role] = { ...(merged.agents[role] ?? {}), ...def };
        }
        if (cfg.council && typeof cfg.council === "object") merged.council = cfg.council;
        if (["deny", "warn", "off"].includes(cfg.enforcement)) merged.enforcement = cfg.enforcement;
        // Upstream semantics: a later layer's list replaces the earlier one.
        for (const key of ["disabled_hooks", "disabled_agents", "disabled_commands"]) {
            const list = strList(cfg[key]);
            if (list) merged[key] = list;
        }
        if (["auto", "direct"].includes(cfg.image_routing)) merged.image_routing = cfg.image_routing;
        if (["auto", "off"].includes(cfg.apply_preset)) merged.apply_preset = cfg.apply_preset;
        if (cfg.interview && typeof cfg.interview.outputDir === "string") merged.interview = { outputDir: cfg.interview.outputDir };
        if (cfg.acpAgents && typeof cfg.acpAgents === "object" && Object.keys(cfg.acpAgents).length) {
            // ACP agents launch local processes, so a repository must not be able to define them.
            if (layer.label === "project") warnings.push(`acpAgents in the project config ${layer.path} are ignored; define ACP agents in the user config only.`);
            else merged.acpAgents = { ...merged.acpAgents, ...cfg.acpAgents };
        }
    }
    for (const [key, known] of [["disabled_hooks", HOOK_NAMES], ["disabled_agents", ROLES], ["disabled_commands", COMMAND_NAMES]]) {
        const unknown = merged[key].filter((x) => !known.includes(x));
        if (unknown.length) warnings.push(`${key} has unknown names ${JSON.stringify(unknown)} (known: ${known.join(", ")}).`);
    }
    if (merged.disabled_agents.includes("orchestrator")) warnings.push(`disabled_agents cannot disable the orchestrator; select another main agent instead.`);
    if (runtimePreset.name) {
        merged.preset = runtimePreset.name;
        merged.presetSource = "session (/preset)";
    }
    const resolved = merged.preset ? resolvePreset(merged.presets, merged.preset) : { roles: {}, chain: [], error: "no preset selected" };
    if (resolved.error) warnings.push(`Active preset: ${resolved.error}.`);
    const roles = { ...resolved.roles };
    for (const [role, def] of Object.entries(merged.agents)) roles[role] = { ...(roles[role] ?? {}), ...def };
    for (const [role, def] of Object.entries(roles)) roles[role] = foldSkillDirectives(def);
    const imageRouting = merged.image_routing ?? (merged.disabled_agents.includes("observer") ? "direct" : "auto");
    return {
        ...merged,
        imageRouting,
        roles,
        presetChain: resolved.chain,
        activeFound: !resolved.error,
        sources,
        warnings,
        paths,
        hookEnabled: (name) => !merged.disabled_hooks.includes(name),
        agentEnabled: (role) => role === "orchestrator" || !merged.disabled_agents.includes(role),
    };
}

// Update one top-level key in a JSON config file without touching other settings.
// Refuses to overwrite a file that is not valid JSON.
export function persistConfigKey(path, key, value) {
    const cur = readJson(path);
    if (!cur.ok && !cur.missing) throw new Error(`${path} is not valid JSON (${cur.error}); fix it before changing settings.`);
    const data = cur.ok && cur.value && typeof cur.value === "object" ? cur.value : {};
    data[key] = value;
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.omcs-${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, path);
    return existsSync(path);
}
