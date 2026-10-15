// oh-my-copilot-slim extension: preset diagnostics, council roster, and
// best-effort per-role MCP/skill policy for the agent team in ../../agents.
// Independently written for this project (see NOTICE). Unofficial adaptation of
// alvinunreal/oh-my-opencode-slim; not endorsed by the upstream authors or GitHub.
import { joinSession } from "@github/copilot-sdk/extension";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve, parse as parsePath } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

const ROLES = ["orchestrator", "oracle", "council", "librarian", "explorer", "designer", "fixer", "observer"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CONFIG_FILE = "oh-my-copilot-slim.json";
const KNOWN_MCPS = ["codegraph", "context7", "gh_grep"];
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const CODEGRAPH_PKG = "@colbymchenry/codegraph@1.6.2";
const copilotHome = () => process.env.COPILOT_HOME || join(homedir(), ".copilot");

function findPluginRoot() {
    if (process.env.OMCS_PLUGIN_ROOT) return resolve(process.env.OMCS_PLUGIN_ROOT);
    let dir = EXT_DIR;
    for (let i = 0; i < 6; i++) {
        if (existsSync(join(dir, "plugin.json")) && existsSync(join(dir, "presets"))) return dir;
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return resolve(EXT_DIR, "..", "..");
}
const PLUGIN_ROOT = findPluginRoot();

function readJson(path) {
    if (!existsSync(path)) return { ok: false, missing: true };
    try {
        return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
    } catch (err) {
        return { ok: false, error: String(err?.message ?? err) };
    }
}

const nativeModel = (m) => (typeof m === "string" ? m.replace(/^github-copilot\//, "") : undefined);

// Upstream `variant` maps to Copilot reasoning effort when it is a known effort level.
function effortOf(role) {
    const v = role?.reasoningEffort ?? role?.variant;
    return typeof v === "string" ? v : undefined;
}

function loadConfig(cwd) {
    const layers = [
        { label: "plugin default", path: join(PLUGIN_ROOT, "presets", "github-copilot.json") },
        { label: "user", path: join(copilotHome(), CONFIG_FILE) },
        { label: "project", path: join(cwd || process.cwd(), ".github", CONFIG_FILE) },
    ];
    const sources = [];
    const merged = { preset: undefined, presets: {}, council: { councillors: [] }, enforcement: "deny" };
    for (const layer of layers) {
        const res = readJson(layer.path);
        if (res.missing) continue;
        if (!res.ok) {
            sources.push(`${layer.label}: ${layer.path} (INVALID JSON, ignored: ${res.error})`);
            continue;
        }
        sources.push(`${layer.label}: ${layer.path}`);
        const cfg = res.value ?? {};
        if (typeof cfg.preset === "string") merged.preset = cfg.preset;
        for (const [name, roles] of Object.entries(cfg.presets ?? {})) {
            merged.presets[name] ??= {};
            for (const [role, def] of Object.entries(roles ?? {})) {
                merged.presets[name][role] = { ...(merged.presets[name][role] ?? {}), ...def };
            }
        }
        if (cfg.council && typeof cfg.council === "object") merged.council = cfg.council;
        if (["deny", "warn", "off"].includes(cfg.enforcement)) merged.enforcement = cfg.enforcement;
    }
    const active = merged.preset && merged.presets[merged.preset] ? merged.presets[merged.preset] : undefined;
    return { ...merged, roles: active ?? {}, sources, activeFound: Boolean(active) };
}

// Upstream list semantics: "*" all, "!x" excludes x, "!*" none, explicit names allow; deny wins.
function listAllows(list, name) {
    if (!Array.isArray(list)) return true;
    if (list.includes("!*") || list.includes(`!${name}`)) return false;
    return list.includes("*") || list.includes(name);
}
const explicitNames = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === "string" && x !== "*" && !x.startsWith("!")) : []);

function normalizeRole(value) {
    if (typeof value !== "string" || !value) return undefined;
    const tail = value.toLowerCase().split(/[:/]|--/).pop().trim();
    return ROLES.includes(tail) ? tail : undefined;
}

function parseFrontmatter(text) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!m) return {};
    const out = {};
    for (const line of m[1].split(/\r?\n/)) {
        const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
        if (!kv) continue;
        let val = kv[2].trim();
        if (val.startsWith("[")) {
            try {
                val = JSON.parse(val);
            } catch {
                /* keep raw string */
            }
        }
        out[kv[1]] = val;
    }
    return out;
}

function readAgentFiles() {
    const dir = join(PLUGIN_ROOT, "agents");
    const out = {};
    try {
        for (const f of readdirSync(dir)) {
            if (!f.endsWith(".agent.md")) continue;
            out[f.replace(/\.agent\.md$/, "")] = parseFrontmatter(readFileSync(join(dir, f), "utf8"));
        }
    } catch {
        /* reported by doctor */
    }
    return out;
}

const asArray = (res, key) => (Array.isArray(res) ? res : Array.isArray(res?.[key]) ? res[key] : []);

async function safe(fn) {
    try {
        return { ok: true, value: await fn() };
    } catch (err) {
        return { ok: false, error: String(err?.message ?? err) };
    }
}

let session;
let mcpCache = { at: 0, names: [] };

async function mcpServerNames() {
    if (Date.now() - mcpCache.at < 30_000) return mcpCache.names;
    const res = await safe(() => session.rpc.mcp.list());
    const names = res.ok ? asArray(res.value, "servers").map((s) => s?.name).filter(Boolean) : [];
    mcpCache = { at: Date.now(), names: [...new Set([...names, ...KNOWN_MCPS])] };
    return mcpCache.names;
}

function mcpServerForTool(toolName, servers) {
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

async function rootRole() {
    const res = await safe(() => session.rpc.agent.getCurrent());
    const a = res.ok ? res.value?.agent : undefined;
    return normalizeRole(a?.id) ?? normalizeRole(a?.name);
}

async function onPreToolUse(input) {
    try {
        const toolName = String(input?.toolName ?? "");
        const isSkill = toolName === "skill";
        const servers = isSkill ? [] : await mcpServerNames();
        const server = isSkill ? undefined : mcpServerForTool(toolName, servers);
        if (!isSkill && !server) return undefined;

        const cfg = loadConfig(input?.workingDirectory);
        if (cfg.enforcement === "off") return undefined;
        const role = input?.agentType ? normalizeRole(input.agentType) ?? normalizeRole(input.agentId) : await rootRole();
        if (!role || !cfg.roles[role]) return undefined;
        const def = cfg.roles[role];

        let violation;
        if (isSkill) {
            const name = String(input?.toolArgs?.skill ?? "").split(":").pop();
            if (name && !listAllows(def.skills, name)) violation = `skill "${name}" is not in ${role}'s skills ${JSON.stringify(def.skills ?? [])}`;
        } else if (!listAllows(def.mcps, server)) {
            violation = `MCP server "${server}" is not in ${role}'s mcps ${JSON.stringify(def.mcps ?? [])}`;
        }
        if (!violation) return undefined;
        const reason = `oh-my-copilot-slim policy: ${violation}. Change it in .github/${CONFIG_FILE} or set "enforcement".`;
        if (cfg.enforcement === "warn") return { additionalContext: `Warning (not blocked): ${reason}` };
        return { permissionDecision: "deny", permissionDecisionReason: reason };
    } catch {
        return undefined;
    }
}

async function onSubagentStart(input) {
    try {
        const role = normalizeRole(input?.agentName);
        if (!role) return undefined;
        const def = loadConfig(input?.workingDirectory).roles[role];
        if (!def) return undefined;
        return {
            additionalContext:
                `[oh-my-copilot-slim] Role policy for ${role}: skills ${JSON.stringify(def.skills ?? ["*"])}, ` +
                `MCP servers ${JSON.stringify(def.mcps ?? ["*"])}. Only load skills and use MCP servers allowed here.`,
        };
    } catch {
        return undefined;
    }
}

function runCmd(cmd, args, opts = {}) {
    return new Promise((done) => {
        execFile(cmd, args, { timeout: 10_000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
            done({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), error: err ? String(err.message ?? err) : undefined }),
        );
    });
}

async function repoRoot(cwd) {
    const r = await runCmd("git", ["rev-parse", "--show-toplevel"], { cwd });
    return r.ok ? r.stdout.trim() || undefined : undefined;
}

const hasCodegraphIndex = (dir) => existsSync(join(dir, ".codegraph", "codegraph.db"));

// codegraph definitions the user made outside this plugin. Copilot's MCP precedence is
// user/workspace config < plugin < --additional-mcp-config, so the plugin's server shadows these.
function otherCodegraphDefs(dir) {
    const candidates = [
        ["user", join(copilotHome(), "mcp-config.json")],
        ["workspace", join(dir, ".mcp.json")],
        ["workspace", join(dir, ".github", "mcp.json")],
    ];
    const out = [];
    for (const [label, path] of candidates) {
        const r = readJson(path);
        if (r.ok && r.value?.mcpServers && Object.hasOwn(r.value.mcpServers, "codegraph")) out.push(`${label} ${path}`);
    }
    return out;
}

async function codegraphStatus(cwd, serverList, mcpsOk) {
    const lines = ["", "## CodeGraph"];
    const warnings = [];
    const server = serverList.find((x) => x?.name === "codegraph");
    const root = (await repoRoot(cwd)) ?? cwd;
    const [node, npx] = await Promise.all([runCmd("node", ["--version"]), runCmd("npx", ["--version"])]);

    let serverText;
    if (!mcpsOk) serverText = "unverified (mcp.list unavailable)";
    else if (!server) serverText = "NOT CONFIGURED (the plugin's bundled server is missing or disabled; reinstall/enable the plugin or run `copilot mcp enable codegraph`)";
    else {
        const bundled = server.sourcePlugin === "oh-my-copilot-slim";
        const from = bundled
            ? `bundled by this plugin (${CODEGRAPH_PKG})`
            : `${server.sourcePlugin ? `plugin ${server.sourcePlugin}` : server.source ?? "unknown source"} (overrides the bundled server)`;
        serverText = `${server.status ?? "?"}, ${from}${server.error ? ` - error: ${server.error}` : ""}`;
        if (server.status && !["connected", "pending"].includes(server.status))
            warnings.push(`codegraph MCP status is "${server.status}". Agents fall back to normal search; check Node.js/npx and network access for the first npx download.`);
    }
    lines.push(`- MCP server \`codegraph\`: ${serverText}`);
    lines.push(`- Node.js: ${node.ok ? node.stdout.trim() : "NOT FOUND on PATH"}; npx: ${npx.ok ? npx.stdout.trim() : "NOT FOUND on PATH"}`);
    if (!node.ok || !npx.ok) warnings.push("codegraph needs Node.js and npx on the PATH Copilot uses to start MCP servers.");

    const indexed = hasCodegraphIndex(root);
    lines.push(`- Index for ${root}: ${indexed ? "present (.codegraph/codegraph.db)" : "none - agents use normal search; omcs_codegraph_init can create one after you confirm"}`);

    const others = otherCodegraphDefs(root);
    if (others.length && server?.sourcePlugin === "oh-my-copilot-slim")
        warnings.push(
            `Your own codegraph server (${others.join("; ")}) is shadowed by this plugin's bundled server (Copilot MCP precedence: user/workspace config < plugin < --additional-mcp-config). To use yours, start Copilot with --additional-mcp-config pointing at a file that defines "codegraph".`,
        );
    return { lines, warnings };
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

async function codegraphInit(args, invocation) {
    const cwd = invocation?.workingDirectory ?? process.cwd();
    const fail = (msg) => ({ textResultForLlm: msg, resultType: "failure", error: msg });
    const target = args?.path ? resolve(cwd, String(args.path)) : (await repoRoot(cwd)) ?? cwd;
    if (!existsSync(target) || !statSync(target).isDirectory()) return fail(`Not a directory: ${target}`);
    if (resolve(target) === resolve(homedir()) || resolve(target) === parsePath(resolve(target)).root)
        return fail(`Refusing to index ${target} (home directory or filesystem root). Pass a repository path.`);

    const reindex = hasCodegraphIndex(target);
    const plan =
        `${reindex ? "Re-run CodeGraph indexing for" : "Create a CodeGraph index for"} ${target}. ` +
        `This runs \`npx -y ${CODEGRAPH_PKG} init --yes\` (downloads the package on first use; needs Node.js and network), ` +
        `writes ${join(target, ".codegraph")} (a local SQLite index with its own .gitignore), and CodeGraph keeps local state in ~/.codegraph. ` +
        `Telemetry is disabled for this run (CODEGRAPH_TELEMETRY=0). Large repositories can take several minutes.`;

    let confirmedBy;
    if (session.capabilities?.ui?.elicitation) {
        const answer = await safe(() => session.ui.confirm(`${plan}\n\nProceed?`));
        if (answer.ok) {
            if (!answer.value) return { textResultForLlm: "The user declined CodeGraph indexing. Continue with normal search tools.", resultType: "rejected" };
            confirmedBy = "user confirmation dialog";
        }
    }
    if (!confirmedBy) {
        if (args?.confirm !== true) {
            return {
                textResultForLlm: `Not run. ${plan}\nAsk the user explicitly whether to index this repository. Only if they agree, call omcs_codegraph_init again with confirm: true. Until then, use normal search tools.`,
                resultType: "success",
            };
        }
        confirmedBy = "confirm: true (no confirmation dialog available in this host)";
    }

    const r = await runCmd("npx", ["-y", CODEGRAPH_PKG, "init", "--yes", target], {
        cwd: target,
        timeout: 20 * 60_000,
        env: { ...process.env, CODEGRAPH_TELEMETRY: "0" },
    });
    const output = stripAnsi(`${r.stdout}\n${r.stderr}`).trim().split(/\r?\n/).filter(Boolean).slice(-20).join("\n");
    if (!r.ok || !hasCodegraphIndex(target))
        return fail(`CodeGraph indexing failed for ${target} (${r.error ?? "no index was created"}).\n${output}\nContinue with normal search tools.`);
    return {
        textResultForLlm: `CodeGraph index ready at ${join(target, ".codegraph")} (confirmed via ${confirmedBy}).\n${output}\nUse codegraph_explore with projectPath "${target}".`,
        resultType: "success",
    };
}

async function doctor(cwd) {
    const cfg = loadConfig(cwd);
    const files = readAgentFiles();
    const [models, current, agents, mcps, skills] = await Promise.all([
        safe(() => session.rpc.model.list()),
        safe(() => session.rpc.model.getCurrent()),
        safe(() => session.rpc.agent.list({})),
        safe(() => session.rpc.mcp.list()),
        safe(() => session.rpc.skills.list()),
    ]);
    const modelList = models.ok ? asArray(models.value, "list").concat(asArray(models.value, "models")) : [];
    const modelById = new Map(modelList.filter((m) => m?.id).map((m) => [m.id, m]));
    const agentList = agents.ok ? asArray(agents.value, "agents") : [];
    const serverList = mcps.ok ? asArray(mcps.value, "servers") : [];
    const skillList = skills.ok ? asArray(skills.value, "skills") : [];

    const lines = ["# oh-my-copilot-slim doctor", "", `Plugin root: ${PLUGIN_ROOT}`, "Config sources (later wins):"];
    lines.push(...(cfg.sources.length ? cfg.sources.map((s) => `- ${s}`) : ["- NONE FOUND"]));
    lines.push(`Active preset: ${cfg.preset ?? "(unset)"}${cfg.activeFound ? "" : " - NOT FOUND in presets"}`, `Enforcement: ${cfg.enforcement}`, "");

    const warnings = [];
    for (const [label, r] of [["model.list", models], ["agent.list", agents], ["mcp.list", mcps], ["skills.list", skills]]) {
        if (!r.ok) warnings.push(`Runtime API ${label} unavailable (${r.error}); related checks are UNVERIFIED.`);
    }
    if (current.ok) {
        const c = current.value ?? {};
        lines.push(`Session model: ${c.modelId ?? "(unknown)"}${c.reasoningEffort ? ` (${c.reasoningEffort})` : ""}${c.autoTier ? ` [Auto: ${c.autoTier}]` : ""}`);
        if (c.autoTier || c.modelId === "auto")
            warnings.push("Session model is Auto: Copilot runs every subagent on the resolved session model, ignoring per-role models. Pick a concrete model to get per-role models.");
    }

    lines.push("", "| Role | Agent registered | Preset model | Available | Effort | Agent file | MCPs | Skills |", "|---|---|---|---|---|---|---|---|");
    for (const role of ROLES) {
        const def = cfg.roles[role];
        if (!def) {
            lines.push(`| ${role} | - | (not in preset) | - | - | - | - | - |`);
            continue;
        }
        const reg = agentList.find((a) => normalizeRole(a?.id) === role || normalizeRole(a?.name) === role);
        const regText = !agents.ok ? "unverified" : reg ? `yes (${reg.id ?? reg.name})` : "NO";
        const model = nativeModel(def.model);
        const info = model ? modelById.get(model) : undefined;
        let avail = !model ? "inherit" : !models.ok ? "unverified" : !info ? "NOT AVAILABLE -> falls back to session model" : "yes";
        if (info?.policy?.state && info.policy.state !== "enabled") avail = `policy: ${info.policy.state}`;
        if (role === "observer" && info && info.capabilities?.supports?.vision === false) avail += "; NO VISION";
        const effort = effortOf(def);
        let effortText = effort ?? "default";
        if (effort && !EFFORTS.includes(effort)) effortText = `${effort} (unknown level)`;
        else if (effort && info) {
            const supported = info.supportedReasoningEfforts ?? [];
            if (info.capabilities?.supports?.reasoningEffort === false || (supported.length && !supported.includes(effort)))
                effortText = `${effort} UNSUPPORTED (supported: ${supported.join(",") || "none"})`;
        }
        const fm = files[role];
        const drift = [];
        if (!fm) drift.push("missing");
        else {
            if (model && fm.model && fm.model !== model) drift.push(`model ${fm.model}`);
            if (model && !fm.model && !reg?.model) drift.push("no model");
            if ((effort ?? "") !== (fm.reasoningEffort ?? "")) drift.push(`effort ${fm.reasoningEffort ?? "none"}`);
        }
        const mcpText = explicitNames(def.mcps).map((n) => {
            const s = serverList.find((x) => x?.name === n);
            const agentScoped = reg?.mcpServers && Object.hasOwn(reg.mcpServers, n);
            if (s) return `${n}:${s.status ?? "?"}`;
            if (agentScoped || (role === "librarian" && ["context7", "gh_grep"].includes(n))) return `${n}:agent-scoped`;
            return mcps.ok ? `${n}:NOT CONFIGURED` : `${n}:unverified`;
        });
        const skillText = explicitNames(def.skills).map((n) => {
            const s = skillList.find((x) => x?.name === n);
            return `${n}:${!skills.ok ? "unverified" : !s ? "MISSING" : s.enabled === false ? "disabled" : "ok"}`;
        });
        if (Array.isArray(def.skills) && def.skills.includes("*")) skillText.unshift("*");
        lines.push(
            `| ${role} | ${regText} | ${model ?? "-"} | ${avail} | ${effortText} | ${drift.length ? `DRIFT: ${drift.join(", ")}` : "ok"} | ${mcpText.join(" ") || "none"} | ${skillText.join(" ") || "none"} |`,
        );
    }

    const cg = await codegraphStatus(cwd, serverList, mcps.ok);
    lines.push(...cg.lines);
    warnings.push(...cg.warnings);

    const seats = councilSeats(cfg);
    if (!seats.length) warnings.push("Council roster is empty: council will not run until you configure seats (see README).");
    warnings.push(
        "Skill restrictions: empty skill lists are enforced by omitting the skill tool; named lists are enforced by a best-effort hook that only applies when Copilot reports the calling agent's type.",
        "Per-role models are preferences: a user /subagents override wins, and unavailable models fall back to the session model.",
    );
    lines.push("", "## Notes", ...[...new Set(warnings)].map((w) => `- ${w}`));
    return lines.join("\n");
}

function councilSeats(cfg) {
    const raw = Array.isArray(cfg.council?.councillors) ? cfg.council.councillors : [];
    return raw
        .filter((s) => s && typeof s.model === "string")
        .map((s, i) => ({ name: typeof s.name === "string" && s.name ? s.name : `seat-${i + 1}`, model: nativeModel(s.model), reasoningEffort: effortOf(s) }));
}

async function councilRoster(cwd) {
    const cfg = loadConfig(cwd);
    const seats = councilSeats(cfg);
    if (!seats.length) {
        return [
            "Council is NOT CONFIGURED: no council seats are defined, so no councillors will be dispatched.",
            `To enable it, add seats to .github/${CONFIG_FILE} (project) or ~/.copilot/${CONFIG_FILE} (user), e.g.:`,
            '{ "council": { "councillors": [ { "name": "alpha", "model": "claude-opus-5.5", "variant": "high" }, { "name": "beta", "model": "gpt-6.1-sol" } ] } }',
            "Each seat costs one model call per council run. Offer oracle as a single-model alternative.",
        ].join("\n");
    }
    const models = await safe(() => session.rpc.model.list());
    const ids = new Set(models.ok ? asArray(models.value, "list").concat(asArray(models.value, "models")).map((m) => m?.id) : []);
    const rows = seats.map((s) => {
        const status = !models.ok ? "availability unverified" : ids.has(s.model) ? "available" : "NOT AVAILABLE (dispatch would fall back to the session model; report this seat as substituted)";
        return `- ${s.name}: model=${s.model}${s.reasoningEffort ? ` reasoning_effort=${s.reasoningEffort}` : ""} - ${status}`;
    });
    return [
        `Council seats (${seats.length}). Dispatch one "councillor" task per seat in parallel, passing model and reasoning_effort, then send all responses to "council" for synthesis:`,
        ...rows,
    ].join("\n");
}

session = await joinSession({
    tools: [
        {
            name: "omcs_doctor",
            description:
                "oh-my-copilot-slim: check the agent-team preset against this Copilot runtime (agents registered, preset models available, reasoning effort support, MCP servers, skills, drift between preset and agent files). Use when roles, models, MCPs, or skills look wrong.",
            parameters: { type: "object", properties: {} },
            handler: async (_args, invocation) => doctor(invocation?.workingDirectory ?? process.cwd()),
        },
        {
            name: "omcs_council_roster",
            description:
                "oh-my-copilot-slim: return the configured council seats (name, model, reasoning effort, availability) for an explicitly requested council run, or explain that none are configured.",
            parameters: { type: "object", properties: {} },
            handler: async (_args, invocation) => councilRoster(invocation?.workingDirectory ?? process.cwd()),
        },
        {
            name: "omcs_codegraph_init",
            description:
                "oh-my-copilot-slim: build a CodeGraph index (.codegraph/) for the current repository so the codegraph MCP server can answer codegraph_explore. Opt-in only: never call it unless the user asked for indexing or agreed to it. It asks the user in a confirmation dialog when the host supports one; otherwise it does nothing unless confirm is true, which you may only set after the user explicitly agreed.",
            parameters: {
                type: "object",
                properties: {
                    confirm: { type: "boolean", description: "Set true only after the user explicitly agreed to index this repository." },
                    path: { type: "string", description: "Directory to index. Defaults to the git root of the working directory." },
                },
            },
            handler: codegraphInit,
        },
    ],
    hooks: { onPreToolUse, onSubagentStart },
});
