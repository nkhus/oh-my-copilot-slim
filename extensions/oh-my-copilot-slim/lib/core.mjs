// Shared runtime state and helpers for the oh-my-copilot-slim extension.
// Independently written for this project (see NOTICE).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

export const PLUGIN_NAME = "oh-my-copilot-slim";
export const ROLES = ["orchestrator", "oracle", "council", "librarian", "explorer", "designer", "fixer", "observer"];
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const CONFIG_FILE = "oh-my-copilot-slim.json";
export const KNOWN_MCPS = ["codegraph", "context7", "gh_grep"];
export const CODEGRAPH_PKG = "@colbymchenry/codegraph@1.6.2";
export const HOOK_NAMES = ["council-inject", "phase-reminder", "tool-loop-guard", "image-routing", "preset-apply", "prompt-overrides"];
export const COMMAND_NAMES = ["deepwork", "reflect", "interview", "preset", "omcs-loop"];

// Mutable runtime state shared by all modules; `session` is set after joinSession.
export const rt = { session: undefined, cwd: undefined };

export const copilotHome = () => process.env.COPILOT_HOME || join(homedir(), ".copilot");
export const userDataDir = () => join(copilotHome(), PLUGIN_NAME);

const EXT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
export const PLUGIN_ROOT = findPluginRoot();

export function readJson(path) {
    if (!existsSync(path)) return { ok: false, missing: true };
    try {
        return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
    } catch (err) {
        return { ok: false, error: String(err?.message ?? err) };
    }
}

export const nativeModel = (m) => (typeof m === "string" ? m.replace(/^github-copilot\//, "") : undefined);

// Upstream `variant` maps to Copilot reasoning effort.
export function effortOf(def) {
    const v = def?.reasoningEffort ?? def?.variant;
    return typeof v === "string" ? v : undefined;
}

export const asArray = (res, key) => (Array.isArray(res) ? res : Array.isArray(res?.[key]) ? res[key] : []);

export async function safe(fn) {
    try {
        return { ok: true, value: await fn() };
    } catch (err) {
        return { ok: false, error: String(err?.message ?? err) };
    }
}

export function log(message, level = "info", ephemeral = false) {
    try {
        void rt.session?.log(message, { level, ephemeral })?.catch?.(() => {});
    } catch {
        /* logging must never break a hook */
    }
}

// Upstream list semantics: "*" all, "!x" excludes x, "!*" none, explicit names allow; deny wins.
export function listAllows(list, name) {
    if (!Array.isArray(list)) return true;
    if (list.includes("!*") || list.includes(`!${name}`)) return false;
    return list.includes("*") || list.includes(name);
}
export const explicitNames = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === "string" && x !== "*" && !x.startsWith("!")) : []);

// Plugin agents are namespaced ("oh-my-copilot-slim:fixer"); map any form back to the role.
export function normalizeRole(value) {
    if (typeof value !== "string" || !value) return undefined;
    const tail = value.toLowerCase().split(/[:/]|--/).pop().trim();
    return ROLES.includes(tail) ? tail : undefined;
}

// Minimal frontmatter reader for our own agent files: flat keys and inline arrays.
export function parseFrontmatter(text) {
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
                val = val.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
            }
        }
        out[kv[1]] = val;
    }
    return out;
}

export function readAgentFiles() {
    const dir = join(PLUGIN_ROOT, "agents");
    const out = {};
    try {
        for (const f of readdirSync(dir)) {
            if (!f.endsWith(".agent.md")) continue;
            const fm = parseFrontmatter(readFileSync(join(dir, f), "utf8"));
            const models = Array.isArray(fm.model) ? fm.model : fm.model ? [fm.model] : [];
            out[f.replace(/\.agent\.md$/, "")] = { ...fm, models, effort: fm["reasoning-effort"] };
        }
    } catch {
        /* reported by doctor */
    }
    return out;
}

export function runCmd(cmd, args, opts = {}) {
    return new Promise((done) => {
        const child = execFile(cmd, args, { timeout: 10_000, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
            done({
                ok: !err,
                code: err ? (typeof err.code === "number" ? err.code : undefined) : 0,
                stdout: String(stdout ?? ""),
                stderr: String(stderr ?? ""),
                error: err ? String(err.message ?? err) : undefined,
            }),
        );
        if (opts.input !== undefined) child.stdin?.end(opts.input);
    });
}

export async function repoRoot(cwd) {
    const r = await runCmd("git", ["rev-parse", "--show-toplevel"], { cwd });
    return r.ok ? r.stdout.trim() || undefined : undefined;
}

export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

export const textResult = (text) => ({ textResultForLlm: text, resultType: "success" });
export const failResult = (text) => ({ textResultForLlm: text, resultType: "failure", error: text });

// Ask the user through the host dialog. Returns true/false, or undefined when no dialog exists.
export async function confirmWithUser(message) {
    const s = rt.session;
    if (!s?.capabilities?.ui?.elicitation) return undefined;
    const answer = await safe(() => s.ui.confirm(message));
    return answer.ok ? Boolean(answer.value) : undefined;
}

export const cwdOf = (invocation) => invocation?.workingDirectory ?? rt.cwd ?? process.cwd();
