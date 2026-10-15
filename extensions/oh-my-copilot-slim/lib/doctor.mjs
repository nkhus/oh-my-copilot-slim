// omcs_doctor: checks the preset against this Copilot runtime and reports every component's state.
import { PLUGIN_ROOT, ROLES, EFFORTS, HOOK_NAMES, COMMAND_NAMES, rt, asArray, safe, normalizeRole, explicitNames, readAgentFiles } from "./core.mjs";
import { loadConfig, modelChain, pickModel } from "./config.mjs";
import { codegraphStatus } from "./codegraph.mjs";
import { councilSeats } from "./council.mjs";
import { presetState, describePlan } from "./presets.mjs";
import { promptState, promptDirs } from "./prompts.mjs";
import { currentModelVision } from "./images.mjs";
import { resolveAstGrep } from "./astgrep.mjs";
import { configuredAcpAgents } from "./acp.mjs";

export const BUNDLED_SKILLS = ["simplify", "codemap", "pragmatic-engineering", "deepwork", "verification-planning", "worktrees", "clonedeps", "reflect", "loop-engineering", "interview", "oh-my-copilot-slim"];

export async function doctor(cwd) {
    const cfg = loadConfig(cwd);
    const files = readAgentFiles();
    const s = rt.session;
    const [models, current, agents, mcps, skills, cmds] = await Promise.all([
        safe(() => s.rpc.model.list()),
        safe(() => s.rpc.model.getCurrent()),
        safe(() => s.rpc.agent.list({})),
        safe(() => s.rpc.mcp.list()),
        safe(() => s.rpc.skills.list()),
        safe(() => s.rpc.commands.list({ includeClientCommands: true, includeBuiltins: false, includeSkills: false })),
    ]);
    const modelList = models.ok ? asArray(models.value, "list").concat(asArray(models.value, "models")) : [];
    const modelById = models.ok ? new Map(modelList.filter((m) => m?.id).map((m) => [m.id, m])) : undefined;
    const agentList = agents.ok ? asArray(agents.value, "agents") : [];
    const serverList = mcps.ok ? asArray(mcps.value, "servers") : [];
    const skillList = skills.ok ? asArray(skills.value, "skills") : [];

    const lines = ["# oh-my-copilot-slim doctor", "", `Plugin root: ${PLUGIN_ROOT}`, "Config sources (later wins):"];
    lines.push(...(cfg.sources.length ? cfg.sources.map((x) => `- ${x}`) : ["- NONE FOUND"]));
    lines.push(
        `Active preset: ${cfg.preset ?? "(unset)"}${cfg.presetSource ? ` [${cfg.presetSource}]` : ""}${cfg.activeFound ? "" : " - NOT RESOLVED"}${cfg.presetChain?.length > 1 ? ` (extends chain: ${cfg.presetChain.join(" <- ")})` : ""}`,
        `Enforcement: ${cfg.enforcement}`,
        "",
    );

    const warnings = [...cfg.warnings];
    for (const [label, r] of [["model.list", models], ["agent.list", agents], ["mcp.list", mcps], ["skills.list", skills]]) {
        if (!r.ok) warnings.push(`Runtime API ${label} unavailable (${r.error}); related checks are UNVERIFIED.`);
    }
    if (current.ok) {
        const c = current.value ?? {};
        lines.push(`Session model: ${c.modelId ?? "(unknown)"}${c.reasoningEffort ? ` (${c.reasoningEffort})` : ""}${c.autoTier ? ` [Auto: ${c.autoTier}]` : ""}`);
        if (c.autoTier || c.modelId === "auto")
            warnings.push("Session model is Auto: Copilot runs every subagent on the resolved session model, ignoring per-role models. Pick a concrete model to get per-role models.");
    }

    lines.push("", "| Role | Agent registered | Preset model (chain) | Available | Effort | Agent file | MCPs | Skills |", "|---|---|---|---|---|---|---|---|");
    for (const role of ROLES) {
        const def = cfg.roles[role];
        if (!cfg.agentEnabled(role)) {
            lines.push(`| ${role} | DISABLED (disabled_agents) | - | - | - | - | - | - |`);
            continue;
        }
        if (!def) {
            lines.push(`| ${role} | - | (not in preset) | - | - | - | - | - |`);
            continue;
        }
        const reg = agentList.find((a) => String(a?.id ?? "").startsWith("oh-my-copilot-slim") && normalizeRole(a?.id) === role);
        const regText = !agents.ok ? "unverified" : reg ? `yes (${reg.id})` : "NO";
        const chain = modelChain(def);
        const { pick, info, skipped } = pickModel(chain, modelById);
        const model = pick?.id;
        let avail = !chain.length ? "inherit" : !models.ok ? "unverified" : !pick ? "NONE AVAILABLE -> session model" : skipped.length ? `fallback (skipped ${skipped.join("; ")})` : "yes";
        if (role === "observer" && info && info.capabilities?.supports?.vision === false) avail += "; NO VISION";
        const effort = pick?.effort;
        let effortText = effort ?? "default";
        if (effort && !EFFORTS.includes(effort)) effortText = `${effort} (unknown level)`;
        else if (effort && info) {
            const supported = info.supportedReasoningEfforts ?? [];
            if (info.capabilities?.supports?.reasoningEffort === false || (supported.length && !supported.includes(effort)))
                effortText = `${effort} UNSUPPORTED (supported: ${supported.join(",") || "none"})`;
        }
        const fm = files[role];
        const fileModels = Array.isArray(fm?.models) ? fm.models : fm?.model ? [fm.model] : [];
        const notes = [];
        if (!fm) notes.push("missing");
        else {
            if (model && fileModels[0] && fileModels[0] !== model) notes.push(`file model ${fileModels[0]}`);
            if ((effort ?? "") !== (fm.effort ?? "")) notes.push(`file effort ${fm.effort ?? "none"}`);
        }
        const row = presetState.lastPlan?.rows?.find((r) => r.role === role);
        const fileText = !notes.length ? "matches preset" : row?.override ? `differs (${notes.join(", ")}); live override applied` : `DRIFT: ${notes.join(", ")}`;
        const mcpText = explicitNames(def.mcps).map((n) => {
            const srv = serverList.find((x) => x?.name === n);
            const agentScoped = reg?.mcpServers && Object.hasOwn(reg.mcpServers, n);
            if (srv) return `${n}:${srv.status ?? "?"}`;
            if (agentScoped || (role === "librarian" && ["context7", "gh_grep"].includes(n))) return `${n}:agent-scoped`;
            return mcps.ok ? `${n}:NOT CONFIGURED` : `${n}:unverified`;
        });
        const skillText = explicitNames(def.skills).map((n) => {
            const sk = skillList.find((x) => x?.name === n || x?.name === `oh-my-copilot-slim:${n}`);
            return `${n}:${!skills.ok ? "unverified" : !sk ? "MISSING" : sk.enabled === false ? "disabled" : "ok"}`;
        });
        if (Array.isArray(def.skills) && def.skills.includes("*")) skillText.unshift("*");
        lines.push(`| ${role} | ${regText} | ${model ?? "-"}${chain.length > 1 ? ` [${chain.map((c) => c.id).join(" > ")}]` : ""} | ${avail} | ${effortText} | ${fileText} | ${mcpText.join(" ") || "none"} | ${skillText.join(" ") || "none"} |`);
    }

    lines.push("", "## Live preset application", presetState.lastPlan ? describePlan(presetState.lastPlan) : "- not applied yet in this session", presetState.applied ? "- Live subagent override is ACTIVE (it replaces /subagents settings for this session)." : "- No live override active.");
    if (presetState.lastError) warnings.push(`Preset application error: ${presetState.lastError}`);

    lines.push("", "## Prompt overrides");
    const dirs = await promptDirs(cwd, cfg.preset);
    lines.push(`Search order: ${dirs.map((d) => d.path).join(" -> ") || "(none)"}`);
    if (promptState.applied.size) for (const [id, v] of promptState.applied) lines.push(`- ${id}: ${v.sources.join(", ")}`);
    else lines.push("- none applied");
    for (const e of promptState.errors) warnings.push(`Prompt override: ${e}`);

    lines.push("", "## Hooks and commands");
    lines.push(`Hooks: ${HOOK_NAMES.map((h) => `${h}:${cfg.hookEnabled(h) ? "on" : "OFF"}`).join(" ")}`);
    const cmdList = cmds.ok ? asArray(cmds.value, "commands") : [];
    lines.push(
        `Commands: ${COMMAND_NAMES.map((c) => `/${c}:${cfg.disabled_commands?.includes(c) ? "OFF" : !cmds.ok ? "unverified" : cmdList.some((x) => x?.name === c) ? "registered" : "NOT REGISTERED"}`).join(" ")}`,
    );

    const vision = await currentModelVision();
    lines.push(
        `Image routing: ${cfg.imageRouting}${!cfg.hookEnabled("image-routing") ? " (hook disabled)" : ""}; session model vision: ${vision.vision === undefined ? "unknown" : vision.vision ? "yes (images stay with the main agent)" : "NO (images are routed to observer)"}`,
    );

    lines.push("", "## Tools");
    const sg = await resolveAstGrep();
    lines.push(`ast-grep: ${sg.error ? `UNAVAILABLE - ${sg.error}` : sg.via}`);
    const acp = configuredAcpAgents(cfg);
    lines.push(`ACP agents: ${Object.keys(acp.agents).length ? Object.entries(acp.agents).map(([n, a]) => `${n} (${a.command}, permissions ${a.permissionMode})`).join(", ") : "none configured (omcs_acp_run is inactive)"}`);
    for (const e of acp.errors) warnings.push(`ACP config: ${e}`);
    lines.push("smartfetch: built in (no external dependencies)");

    const missingSkills = skills.ok ? BUNDLED_SKILLS.filter((n) => !skillList.some((x) => x?.name === n || x?.name === `oh-my-copilot-slim:${n}`)) : [];
    lines.push(`Bundled skills: ${skills.ok ? (missingSkills.length ? `MISSING ${missingSkills.join(", ")}` : `all ${BUNDLED_SKILLS.length} loaded`) : "unverified"}`);

    const cg = await codegraphStatus(cwd, serverList, mcps.ok);
    lines.push(...cg.lines);
    warnings.push(...cg.warnings);

    if (!councilSeats(cfg).length) warnings.push("Council roster is empty: council will not run until you configure seats (see README).");
    warnings.push(
        "Skill restrictions: Copilot offers the skill tool to every agent; role skill lists (including empty ones) are enforced by a best-effort pre-tool hook that only applies when Copilot reports the calling agent's type.",
        "Per-role models are preferences: unavailable models fall back along the preset chain, then to the session model.",
    );
    lines.push("", "## Notes", ...[...new Set(warnings)].map((w) => `- ${w}`));
    return lines.join("\n");
}
