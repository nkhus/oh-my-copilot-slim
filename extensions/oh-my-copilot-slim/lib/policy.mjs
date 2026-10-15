// Role detection and per-role policy (skills, MCP servers, extension tools, disabled agents).
// Independently written; semantics follow upstream oh-my-opencode-slim config (see NOTICE).
import { rt, KNOWN_MCPS, CONFIG_FILE, PLUGIN_NAME, asArray, safe, listAllows, normalizeRole } from "./core.mjs";

// Which roles may call each extension tool. Mirrors upstream: ast_grep_search for
// read-only roles, ast_grep_replace only for edit-capable roles, nothing for the council synthesizer.
export const TOOL_ROLES = {
    omcs_smartfetch: ["orchestrator", "librarian"],
    omcs_ast_grep_search: ["orchestrator", "oracle", "librarian", "explorer", "designer", "fixer", "observer"],
    omcs_ast_grep_replace: ["orchestrator", "designer", "fixer"],
    omcs_acp_run: ["orchestrator"],
    omcs_codegraph_init: ["orchestrator"],
};

let mcpCache = { at: 0, names: [] };
export async function mcpServerNames() {
    if (Date.now() - mcpCache.at < 30_000) return mcpCache.names;
    const res = await safe(() => rt.session.rpc.mcp.list());
    const names = res.ok ? asArray(res.value, "servers").map((s) => s?.name).filter(Boolean) : [];
    mcpCache = { at: Date.now(), names: [...new Set([...names, ...KNOWN_MCPS])] };
    return mcpCache.names;
}

export function mcpServerForTool(toolName, servers) {
    const t = toolName.toLowerCase();
    let best;
    for (const s of servers) {
        const n = s.toLowerCase();
        if ([`${n}-`, `${n}/`, `${n}__`, `mcp__${n}__`].some((p) => t.startsWith(p))) {
            if (!best || s.length > best.length) best = s;
        }
    }
    return best;
}

let rootCache = { at: 0, role: undefined, id: undefined };
// Role of the session's selected main agent (undefined for Copilot's default agent).
export async function rootAgent() {
    if (Date.now() - rootCache.at < 2_000) return rootCache;
    const res = await safe(() => rt.session.rpc.agent.getCurrent());
    const a = res.ok ? res.value?.agent : undefined;
    rootCache = { at: Date.now(), role: normalizeRole(a?.id) ?? normalizeRole(a?.name), id: a?.id ?? a?.name };
    return rootCache;
}
export const rootRole = async () => (await rootAgent()).role;
export const resetRootCache = () => (rootCache = { at: 0 });

// Role making a tool call: child hooks carry agentType; otherwise the main agent.
export async function callerRole(input) {
    if (input?.agentType || input?.agentId) return { role: normalizeRole(input.agentType) ?? normalizeRole(input.agentId), child: true };
    return { role: await rootRole(), child: false };
}

// Subagent type requested by a task-tool call, normalized to a role if it is ours.
export function taskTarget(toolName, args) {
    if (toolName !== "task") return undefined;
    const type = args?.agent_type ?? args?.agentType;
    if (typeof type !== "string") return undefined;
    const ours = type.toLowerCase().startsWith(`${PLUGIN_NAME}:`) || type.toLowerCase().startsWith(`${PLUGIN_NAME}/`);
    return { type, role: ours ? normalizeRole(type) : undefined };
}

// A task call targeting a role in disabled_agents. Always denied, independent of "enforcement",
// because upstream does not register disabled agents at all.
export function disabledAgentDecision(cfg, toolName, args) {
    const target = taskTarget(toolName, args);
    if (!target?.role || cfg.agentEnabled(target.role)) return undefined;
    return {
        permissionDecision: "deny",
        permissionDecisionReason: `oh-my-copilot-slim: agent "${target.role}" is listed in disabled_agents; handle the work yourself or pick another agent.`,
    };
}

// Returns a violation string or undefined.
export async function policyViolation(cfg, toolName, args, role) {
    if (TOOL_ROLES[toolName] && role && !TOOL_ROLES[toolName].includes(role)) return `${toolName} is not available to the ${role} role (allowed: ${TOOL_ROLES[toolName].join(", ")})`;

    if (!role || !cfg.roles[role]) return undefined;
    const def = cfg.roles[role];
    if (toolName === "skill") {
        const name = String(args?.skill ?? "").split(":").pop();
        if (name && !listAllows(def.skills, name)) return `skill "${name}" is not in ${role}'s skills ${JSON.stringify(def.skills ?? [])}`;
        return undefined;
    }
    const server = mcpServerForTool(toolName, await mcpServerNames());
    if (server && !listAllows(def.mcps, server)) return `MCP server "${server}" is not in ${role}'s mcps ${JSON.stringify(def.mcps ?? [])}`;
    return undefined;
}

export function policyDecision(cfg, violation) {
    if (!violation) return undefined;
    const reason = `oh-my-copilot-slim policy: ${violation}. Change it in .github/${CONFIG_FILE} or set "enforcement".`;
    if (cfg.enforcement === "off") return undefined;
    if (cfg.enforcement === "warn") return { additionalContext: `Warning (not blocked): ${reason}` };
    return { permissionDecision: "deny", permissionDecisionReason: reason };
}
