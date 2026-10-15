// Bundled CodeGraph MCP support: status for omcs_doctor and the opt-in index tool.
// Independently written; CodeGraph itself is colbymchenry/codegraph (MIT, see NOTICE).
import { existsSync, statSync } from "node:fs";
import { join, resolve, parse as parsePath } from "node:path";
import { homedir } from "node:os";
import { rt, CODEGRAPH_PKG, copilotHome, readJson, runCmd, repoRoot, safe, stripAnsi, cwdOf } from "./core.mjs";

export const hasCodegraphIndex = (dir) => existsSync(join(dir, ".codegraph", "codegraph.db"));

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

export async function codegraphStatus(cwd, serverList, mcpsOk) {
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

export async function codegraphInit(args, invocation) {
    const cwd = cwdOf(invocation);
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
    if (rt.session.capabilities?.ui?.elicitation) {
        const answer = await safe(() => rt.session.ui.confirm(`${plan}\n\nProceed?`));
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

