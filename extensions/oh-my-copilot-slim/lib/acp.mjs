// Optional external Agent Client Protocol (ACP) delegates.
// Protocol handling adapted from alvinunreal/oh-my-opencode-slim (MIT), src/tools/acp-run.ts.
// Modified for GitHub Copilot; see NOTICE. Agents are user-configured only; nothing is installed.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isAbsolute } from "node:path";
import { textResult, failResult, cwdOf, confirmWithUser, log } from "./core.mjs";
import { loadConfig } from "./config.mjs";

export const DEFAULT_ACP_TIMEOUT_MS = 600_000;
const MAX_ACP_TIMEOUT_MS = 2_147_483_647;
const MAX_OUTPUT_CHARS = 200_000;
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const readText = (v) => (typeof v === "string" ? v : isRecord(v) && typeof v.text === "string" ? v.text : undefined);

// Validate one user-config entry; returns {config} or {error}.
export function normalizeAcpAgent(name, raw) {
    if (!isRecord(raw)) return { error: `acpAgents.${name} must be an object` };
    if (typeof raw.command !== "string" || !raw.command) return { error: `acpAgents.${name}.command is required` };
    if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every((x) => typeof x === "string"))) return { error: `acpAgents.${name}.args must be a string array` };
    if (raw.env !== undefined && !(isRecord(raw.env) && Object.values(raw.env).every((x) => typeof x === "string"))) return { error: `acpAgents.${name}.env must map strings to strings` };
    if (raw.cwd !== undefined && (typeof raw.cwd !== "string" || !isAbsolute(raw.cwd))) return { error: `acpAgents.${name}.cwd must be an absolute path` };
    const permissionMode = raw.permissionMode ?? "ask";
    if (!["ask", "allow", "reject"].includes(permissionMode)) return { error: `acpAgents.${name}.permissionMode must be ask, allow or reject` };
    const timeoutMs = raw.timeoutMs ?? DEFAULT_ACP_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_ACP_TIMEOUT_MS) return { error: `acpAgents.${name}.timeoutMs must be an integer >= 0 (0 disables the timeout)` };
    return { config: { command: raw.command, args: raw.args ?? [], env: raw.env ?? {}, cwd: raw.cwd, description: typeof raw.description === "string" ? raw.description : undefined, permissionMode, timeoutMs } };
}

export function selectPermissionOption(params, mode) {
    const choices = (Array.isArray(params?.options) ? params.options : []).filter((o) => isRecord(o) && typeof o.optionId === "string");
    const reject = choices.find((o) => typeof o.kind === "string" && o.kind.startsWith("reject"));
    if (mode === "reject") return reject?.optionId;
    const allow = choices.find((o) => typeof o.kind === "string" && o.kind.startsWith("allow"));
    return allow?.optionId ?? reject?.optionId;
}

function readModelOption(value) {
    const models = (Array.isArray(value?.configOptions) ? value.configOptions : []).filter((o) => isRecord(o) && (o.id === "model" || o.category === "model"));
    if (models.length !== 1 || typeof models[0].id !== "string" || models[0].type !== "select") throw new Error("ACP agent does not advertise exactly one model select option; omit model");
    return models[0];
}

const supportsModel = (options, value) => (Array.isArray(options) ? options : []).filter(isRecord).some((o) => (Array.isArray(o.options) ? o.options.filter(isRecord).some((i) => i.value === value) : o.value === value));
const isAuthError = (err) => err?.code === -32001 || /auth[_ ]required/i.test(String(err?.message ?? ""));

export class AcpClient {
    constructor(name, config, cwd, { ask } = {}) {
        this.name = name;
        this.config = config;
        this.ask = ask;
        this.nextId = 1;
        this.pending = new Map();
        this.chunks = [];
        this.errors = [];
        this.tools = new Map();
        this.settled = false;
        this.child = spawn(config.command, config.args, { cwd: config.cwd ?? cwd, env: { ...process.env, ...config.env }, stdio: ["pipe", "pipe", "pipe"] });
        this.cwd = config.cwd ?? cwd;
        this.exited = new Promise((res) => this.child.once("close", res));
        this.child.stderr.on("data", (c) => this.errors.push(String(c)));
        this.child.stdin.on("error", (e) => this.rejectAll(e));
        this.child.on("error", (e) => this.rejectAll(e));
        this.child.on("exit", (code, signal) => this.rejectAll(new Error(`ACP agent '${name}' exited before replying (code ${code ?? "null"}, signal ${signal ?? "null"})`)));
        createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
    }

    rejectAll(err) {
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
    }

    write(msg) {
        if (!this.child.stdin.destroyed) this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
    }

    request(method, params) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.write({ id, method, params });
        });
    }

    async receive(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch {
            return;
        }
        if (!isRecord(msg)) return;
        if ("id" in msg && "method" in msg) return this.handleRequest(msg);
        if ("id" in msg) {
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            if (msg.error) p.reject(Object.assign(new Error(msg.error.message ?? "ACP request failed"), { code: msg.error.code, data: msg.error.data }));
            else p.resolve(msg.result);
            return;
        }
        if (msg.method === "session/update" && !this.settled) {
            const u = msg.params?.update;
            if (!isRecord(u)) return;
            if (u.sessionUpdate === "agent_message_chunk") {
                const t = readText(u.delta) ?? readText(u.content);
                if (t) this.chunks.push(t);
            } else if ((u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") && typeof u.toolCallId === "string") {
                const prev = this.tools.get(u.toolCallId) ?? {};
                this.tools.set(u.toolCallId, { title: u.title ?? prev.title ?? u.toolCallId, status: u.status ?? prev.status ?? "" });
            }
        }
    }

    async handleRequest(msg) {
        if (msg.method !== "session/request_permission") {
            this.write({ id: msg.id, error: { code: -32601, message: `Unsupported ACP client method: ${msg.method}` } });
            return;
        }
        const title = msg.params?.toolCall?.title ?? msg.params?.permission ?? "ACP permission request";
        let mode = this.config.permissionMode;
        if (mode === "ask") {
            const ok = this.ask ? await this.ask(`ACP agent '${this.name}' requests permission: ${title}`) : undefined;
            // No interactive UI or a declined prompt means reject.
            mode = ok === true ? "allow" : "reject";
        }
        const optionId = selectPermissionOption(msg.params, mode);
        this.write({ id: msg.id, result: { outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } } });
    }

    async run(prompt, model) {
        const init = await this.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
        const authMethods = Array.isArray(init?.authMethods) ? init.authMethods.filter(isRecord) : [];
        let created;
        try {
            created = await this.request("session/new", { cwd: this.cwd, mcpServers: [] });
        } catch (err) {
            if (!isAuthError(err) || typeof authMethods[0]?.id !== "string") throw err;
            await this.request("authenticate", { methodId: authMethods[0].id });
            created = await this.request("session/new", { cwd: this.cwd, mcpServers: [] });
        }
        if (typeof created?.sessionId !== "string") throw new Error("ACP agent did not return a sessionId");
        this.sessionId = created.sessionId;
        if (model !== undefined) {
            const option = readModelOption(created);
            if (!supportsModel(option.options, model)) throw new Error(`ACP agent '${this.name}' does not advertise model '${model}'`);
            const updated = await this.request("session/set_config_option", { sessionId: this.sessionId, configId: option.id, value: model });
            const confirmed = readModelOption(updated);
            if (confirmed.id !== option.id || confirmed.currentValue !== model) throw new Error(`ACP model selection was not confirmed as '${model}'`);
        }
        this.active = true;
        const res = await this.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text: prompt }] });
        this.active = false;
        this.settled = true;
        return { text: this.chunks.join("").trim(), stopReason: res?.stopReason };
    }

    async close() {
        this.settled = true;
        if (this.child.exitCode !== null || this.child.signalCode !== null) return;
        if (this.active && this.sessionId) this.write({ method: "session/cancel", params: { sessionId: this.sessionId } });
        this.child.stdin.end();
        const wait = (ms) => Promise.race([this.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), ms).unref?.())]);
        if (await wait(1500)) return;
        this.child.kill("SIGTERM");
        if (await wait(1500)) return;
        this.child.kill("SIGKILL");
        await wait(1000);
    }
}

export async function runAcp(name, config, { prompt, model, cwd, timeoutMs, signal, ask }) {
    const client = new AcpClient(name, config, cwd, { ask });
    const limit = timeoutMs ?? config.timeoutMs;
    let timer;
    const onAbort = () => client.close();
    signal?.addEventListener?.("abort", onAbort);
    try {
        const work = client.run(prompt, model);
        const res = limit > 0 ? await Promise.race([work, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(`ACP agent '${name}' timed out after ${limit}ms`)), limit)))]) : await work;
        const tools = [...client.tools.values()].map((t) => `${t.status === "completed" ? "✓" : t.status === "failed" ? "✗" : "·"} ${t.title}`);
        let text = res.text || `ACP agent '${name}' completed without text output.${client.errors.length ? ` stderr:\n${client.errors.join("").trim().slice(0, 4000)}` : ""}`;
        if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[..output truncated..]`;
        return { text, stopReason: res.stopReason, tools };
    } catch (err) {
        const stderr = client.errors.join("").trim();
        throw new Error(`${err?.message ?? err}${stderr ? `\nstderr:\n${stderr.slice(0, 4000)}` : ""}`);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        await client.close();
    }
}

export function configuredAcpAgents(cfg) {
    const out = {};
    const errors = [];
    for (const [name, raw] of Object.entries(cfg.acpAgents ?? {})) {
        const n = normalizeAcpAgent(name, raw);
        if (n.error) errors.push(n.error);
        else out[name] = n.config;
    }
    return { agents: out, errors };
}

export const acpRunTool = {
    name: "omcs_acp_run",
    description:
        "oh-my-copilot-slim: delegate a task to an external Agent Client Protocol (ACP) agent that the user configured in acpAgents (for example Claude Code ACP or Gemini ACP). Off unless configured. Returns the agent's final text. Only use when the user asked for that agent or a second opinion from it.",
    parameters: {
        type: "object",
        properties: {
            agent: { type: "string", description: "Configured ACP agent name (see omcs_doctor)" },
            prompt: { type: "string", description: "Self-contained task or question for the ACP agent" },
            model: { type: "string", description: "Optional exact model value advertised by the ACP agent; omit to use its default" },
            timeout_ms: { type: "number", description: "Optional timeout override in ms (0 disables)" },
        },
        required: ["agent", "prompt"],
    },
    handler: async (args, invocation) => {
        const cwd = cwdOf(invocation);
        const cfg = loadConfig(cwd);
        const { agents, errors } = configuredAcpAgents(cfg);
        const names = Object.keys(agents);
        if (!names.length) return failResult(`No ACP agents are configured.${errors.length ? ` Config errors: ${errors.join("; ")}` : ""} Add acpAgents to ${cfg.paths.user} (user config only) to enable this tool.`);
        const config = agents[args?.agent];
        if (!config) return failResult(`Unknown ACP agent '${args?.agent}'. Configured: ${names.join(", ")}.`);
        if (typeof args?.prompt !== "string" || !args.prompt.trim()) return failResult("prompt is required");
        const timeout = args.timeout_ms === undefined ? undefined : Number(args.timeout_ms);
        if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 0 || timeout > MAX_ACP_TIMEOUT_MS)) return failResult("timeout_ms must be an integer >= 0");
        try {
            log(`oh-my-copilot-slim: running ACP agent '${args.agent}' (${config.command})`, "info", true);
            const r = await runAcp(args.agent, config, { prompt: args.prompt, model: args.model, cwd, timeoutMs: timeout, signal: invocation?.signal, ask: confirmWithUser });
            const trail = r.tools.length ? `\n\n---\nACP tool calls (${r.tools.length}):\n${r.tools.slice(-20).join("\n")}` : "";
            return textResult(`${r.text}${trail}${r.stopReason && r.stopReason !== "end_turn" ? `\n\n(stopReason: ${r.stopReason})` : ""}`);
        } catch (err) {
            return failResult(`ACP agent '${args.agent}' failed: ${err?.message ?? err}`);
        }
    },
};
