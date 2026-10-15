// Structural code search/replace via the ast-grep CLI (MIT, https://ast-grep.github.io).
// Tool shape and output format adapted from alvinunreal/oh-my-opencode-slim (MIT),
// src/tools/ast-grep/{cli,tools,utils}.ts. Modified for GitHub Copilot; see NOTICE.
import { realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { runCmd, repoRoot, textResult, failResult, cwdOf, stripAnsi } from "./core.mjs";

export const AST_GREP_PKG = "@ast-grep/cli@0.51.0";
export const CLI_LANGUAGES = ["bash", "c", "cpp", "csharp", "css", "elixir", "go", "haskell", "html", "java", "javascript", "json", "kotlin", "lua", "nix", "php", "python", "ruby", "rust", "scala", "solidity", "swift", "typescript", "tsx", "yaml"];
const MAX_OUTPUT = 1024 * 1024;
const MAX_MATCHES = 500;
const TIMEOUT = 300_000;

let resolved;
// Prefer an installed ast-grep; `sg` only counts when it really is ast-grep (Linux has a setgid `sg`).
export async function resolveAstGrep({ refresh = false } = {}) {
    if (resolved && !refresh) return resolved;
    if (process.env.OMCS_AST_GREP_BIN) {
        const r = await runCmd(process.env.OMCS_AST_GREP_BIN, ["--version"]);
        resolved = r.ok ? { cmd: process.env.OMCS_AST_GREP_BIN, pre: [], via: `OMCS_AST_GREP_BIN (${r.stdout.trim()})` } : { error: `OMCS_AST_GREP_BIN=${process.env.OMCS_AST_GREP_BIN} does not run: ${r.error}` };
        return resolved;
    }
    for (const bin of ["ast-grep", "sg"]) {
        const r = await runCmd(bin, ["--version"]);
        if (r.ok && /ast-grep/i.test(r.stdout + r.stderr)) return (resolved = { cmd: bin, pre: [], via: `${bin} on PATH (${r.stdout.trim()})` });
    }
    const npx = await runCmd("npx", ["--version"]);
    if (npx.ok) return (resolved = { cmd: "npx", pre: ["-y", "-p", AST_GREP_PKG, "ast-grep"], via: `npx ${AST_GREP_PKG} (downloaded on first use)` });
    return (resolved = { error: "ast-grep is not installed and npx is unavailable. Install ast-grep (https://ast-grep.github.io/guide/quick-start.html) or Node.js." });
}

async function scopedPaths(paths, cwd) {
    // Compare canonical paths (macOS /var vs /private/var, symlinked checkouts).
    const real = (p) => {
        try {
            return realpathSync(p);
        } catch {
            return p;
        }
    };
    const base = real(cwd);
    const root = real((await repoRoot(cwd)) ?? cwd);
    const list = Array.isArray(paths) && paths.length ? paths.map(String) : ["."];
    for (const p of list) {
        const abs = real(resolve(base, p));
        const rel = relative(root, abs);
        if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path ${p} is outside the repository/working directory ${root}`);
    }
    return list;
}

export async function runSg({ pattern, lang, rewrite, updateAll, context, globs, paths }, cwd) {
    const bin = await resolveAstGrep();
    if (bin.error) return { error: bin.error, matches: [] };
    // ast-grep ignores --update-all when --json is set, so matches are collected with --json
    // and changes are applied by a second, non-JSON run.
    const common = ["run", "-p", pattern, "--lang", lang];
    if (rewrite !== undefined) common.push("-r", rewrite);
    const scope = [];
    for (const g of Array.isArray(globs) ? globs : []) scope.push("--globs", String(g));
    scope.push(...(await scopedPaths(paths, cwd)));
    const args = [...common, "--json=compact", ...(context > 0 ? ["-C", String(context)] : []), ...scope];
    const r = await runCmd(bin.cmd, [...bin.pre, ...args], { cwd, timeout: TIMEOUT, maxBuffer: 64 * 1024 * 1024 });
    // ast-grep exits 1 when nothing matched.
    if (!r.ok && !r.stdout.trim()) {
        if (r.code === 1 && !r.stderr.trim()) return { matches: [], totalMatches: 0, via: bin.via };
        return { error: (r.stderr || r.error || "ast-grep failed").trim().slice(0, 2000), matches: [] };
    }
    let out = r.stdout;
    const truncatedOutput = out.length >= MAX_OUTPUT;
    let matches;
    try {
        matches = JSON.parse(out.trim() || "[]");
    } catch {
        if (!truncatedOutput) return { error: `could not parse ast-grep output: ${out.slice(0, 300)}`, matches: [] };
        out = out.slice(0, MAX_OUTPUT);
        const cut = out.lastIndexOf("},{");
        try {
            matches = JSON.parse(`${out.slice(0, cut + 1)}]`);
        } catch {
            return { error: "ast-grep output too large to parse; narrow paths/globs", matches: [] };
        }
    }
    const totalMatches = matches.length;
    const truncated = totalMatches > MAX_MATCHES || truncatedOutput;
    let applied;
    if (rewrite !== undefined && updateAll && totalMatches) {
        const w = await runCmd(bin.cmd, [...bin.pre, ...common, "--update-all", ...scope], { cwd, timeout: TIMEOUT, maxBuffer: 16 * 1024 * 1024 });
        const n = /Applied (\d+) changes?/i.exec(stripAnsi(`${w.stdout}\n${w.stderr}`))?.[1];
        if (!w.ok || n === undefined) return { error: `ast-grep apply failed: ${(stripAnsi(w.stderr || w.stdout || w.error || "") || "no confirmation output").trim().slice(0, 2000)}`, matches: [] };
        applied = Number(n);
    }
    return {
        applied, matches: matches.slice(0, MAX_MATCHES), totalMatches, truncated, truncatedReason: truncatedOutput ? "max output bytes" : "max matches", via: bin.via };
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}...` : s).replace(/\n/g, "\\n");
const byFile = (matches) => {
    const m = new Map();
    for (const x of matches) m.set(x.file, [...(m.get(x.file) ?? []), x]);
    return m;
};

export function formatSearch(res) {
    if (res.error) return `Error: ${res.error}`;
    if (!res.matches.length) return "No matches found.";
    const lines = [];
    const files = byFile(res.matches);
    for (const [file, ms] of files) {
        lines.push(`\n${file}:`);
        for (const m of ms) lines.push(`  ${m.range.start.line + 1}: ${clip(m.text ?? "", 100)}`);
    }
    lines.push(`\nFound ${res.totalMatches} matches in ${files.size} files${res.truncated ? ` (output truncated: ${res.truncatedReason})` : ""}`);
    return lines.join("\n");
}

export function formatReplace(res, dryRun) {
    if (res.error) return `Error: ${res.error}`;
    if (!res.matches.length) return "No matches found for replacement.";
    const lines = [];
    const files = byFile(res.matches);
    for (const [file, ms] of files) {
        lines.push(`\n${file}:`);
        for (const m of ms) lines.push(`  ${m.range.start.line + 1}: "${clip(m.text ?? "", 60)}" -> "${m.replacement !== undefined ? clip(m.replacement, 60) : "[no replacement]"}"`);
    }
    lines.push(dryRun ? `\n[DRY RUN] ${res.totalMatches} replacements in ${files.size} files` : `\n[APPLIED] ${res.applied ?? res.totalMatches} changes written in ${files.size} files (ast-grep confirmed)`);
    if (dryRun) lines.push("\nTo apply changes, call omcs_ast_grep_replace again with dryRun=false.");
    return lines.join("\n");
}

const common = {
    pattern: { type: "string", description: "AST pattern with meta-variables ($VAR, $$$). Must be a complete AST node." },
    lang: { type: "string", enum: CLI_LANGUAGES, description: "Target language" },
    paths: { type: "array", items: { type: "string" }, description: "Paths to search, inside the repository (default ['.'])" },
    globs: { type: "array", items: { type: "string" }, description: "Include/exclude globs (prefix ! to exclude)" },
};

function validate(args) {
    if (typeof args?.pattern !== "string" || !args.pattern.trim()) return "pattern is required";
    if (!CLI_LANGUAGES.includes(args?.lang)) return `lang must be one of ${CLI_LANGUAGES.join(", ")}`;
    return undefined;
}

export const astGrepTools = [
    {
        name: "omcs_ast_grep_search",
        description:
            "oh-my-copilot-slim: structural code search with ast-grep (AST patterns, not text). Use for function/class shapes, call patterns, or syntax-aware matches across many files. Example: pattern 'console.log($MSG)', lang 'typescript'.",
        parameters: { type: "object", properties: { ...common, context: { type: "number", description: "Context lines around each match" } }, required: ["pattern", "lang"] },
        skipPermission: true,
        handler: async (args, invocation) => {
            const bad = validate(args);
            if (bad) return failResult(bad);
            try {
                return textResult(formatSearch(await runSg({ ...args, rewrite: undefined }, cwdOf(invocation))));
            } catch (err) {
                return failResult(String(err?.message ?? err));
            }
        },
    },
    {
        name: "omcs_ast_grep_replace",
        description:
            "oh-my-copilot-slim: structural rewrite with ast-grep. Defaults to a DRY RUN that only previews replacements; pass dryRun=false to write the files (this edits files directly, so preview first). Example: pattern 'console.log($MSG)', rewrite 'logger.info($MSG)'.",
        parameters: {
            type: "object",
            properties: {
                ...common,
                rewrite: { type: "string", description: "Replacement pattern (can use $VAR from pattern)" },
                dryRun: { type: "boolean", description: "Preview changes without applying (default: true)" },
            },
            required: ["pattern", "rewrite", "lang"],
        },
        handler: async (args, invocation) => {
            const bad = validate(args) ?? (typeof args?.rewrite !== "string" ? "rewrite is required" : undefined);
            if (bad) return failResult(bad);
            const dryRun = args.dryRun !== false;
            try {
                return textResult(formatReplace(await runSg({ ...args, updateAll: !dryRun }, cwdOf(invocation)), dryRun));
            } catch (err) {
                return failResult(String(err?.message ?? err));
            }
        },
    },
];
