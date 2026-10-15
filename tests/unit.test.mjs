// Stub-SDK unit tests for the oh-my-copilot-slim extension modules.
// Run: node --test tests/   (no network; all state lives in one mkdtemp directory)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const TMP = mkdtempSync(join(tmpdir(), "omcs-test-"));
process.env.COPILOT_HOME = join(TMP, "copilot-home");
mkdirSync(process.env.COPILOT_HOME);
process.env.OMCS_SMARTFETCH_DIR = join(TMP, "smartfetch");
after(() => rmSync(TMP, { recursive: true, force: true }));

const lib = (m) => import(new URL(`../extensions/oh-my-copilot-slim/lib/${m}.mjs`, import.meta.url));
const { rt } = await lib("core");
const { matchesCouncilTrigger, councilSeats } = await lib("council");
const { loopGuardPre, loopGuardPost, LOOP_MARKER } = await lib("hooks");
const { resolvePreset, modelChain, pickModel, foldSkillDirectives, loadConfig, persistConfigKey, runtimePreset } = await lib("config");
const { planPreset } = await lib("presets");
const { resolveRolePrompt, promptDirs, applyPromptOverrides, promptState, stripFrontmatter } = await lib("prompts");
const { routeImages } = await lib("images");
const { formatSearch, formatReplace } = await lib("astgrep");
const { smartfetch, extractHtml, isDocsLikeUrl } = await lib("smartfetch");
const { normalizeAcpAgent, selectPermissionOption, runAcp } = await lib("acp");
const { parseReflectArgs, reflectPrompt, loopPrompt, interviewPrompt } = await lib("commands");

const textOf = (r) => (typeof r === "string" ? r : r?.textResultForLlm);

test("council trigger: keywords, code stripping, slash commands", () => {
    assert.equal(matchesCouncilTrigger("Let's ask the council about this design"), true);
    assert.equal(matchesCouncilTrigger("I want a second opinion"), true);
    assert.equal(matchesCouncilTrigger("用多个模型讨论一下"), true);
    assert.equal(matchesCouncilTrigger("rename `council` variable"), false);
    assert.equal(matchesCouncilTrigger("fix this:\n```\nconst council = 1\n```"), false);
    assert.equal(matchesCouncilTrigger("/preset council-heavy"), false);
    assert.equal(matchesCouncilTrigger("refactor the parser"), false);
});

test("tool loop guard warns at 3 identical runs and blocks read tools at 5", () => {
    const call = { sessionId: "s1", toolName: "view", toolArgs: { path: "/a" } };
    const post = () => loopGuardPost({ ...call, toolResult: { textResultForLlm: "same" } });
    assert.equal(post(), undefined);
    assert.equal(post(), undefined);
    assert.ok(post().startsWith(LOOP_MARKER));
    assert.equal(loopGuardPre(call), undefined);
    post();
    post();
    assert.equal(loopGuardPre(call)?.permissionDecision, "deny");
    assert.equal(loopGuardPre({ ...call, toolArgs: { path: "/b" } }), undefined);
    loopGuardPost({ ...call, toolResult: { textResultForLlm: "changed" } });
    assert.equal(loopGuardPre(call), undefined, "a different result resets the run");
    for (let i = 0; i < 6; i++) loopGuardPost({ sessionId: "s1", toolName: "task", toolArgs: {}, toolResult: "x" });
    assert.equal(loopGuardPre({ sessionId: "s1", toolName: "task", toolArgs: {} }), undefined);
});

test("preset extends, cycles, model chains, skill directives", () => {
    const presets = { base: { fixer: { model: "github-copilot/a", skills: ["x"] } }, child: { extends: "base", fixer: { variant: "max" } }, c1: { extends: "c2" }, c2: { extends: "c1" } };
    const r = resolvePreset(presets, "child");
    assert.deepEqual(r.chain, ["child", "base"]);
    assert.deepEqual(r.roles.fixer, { model: "github-copilot/a", skills: ["x"], variant: "max" });
    assert.match(resolvePreset(presets, "c1").error, /cycle/);
    assert.match(resolvePreset(presets, "nope").error, /not found/);
    const chain = modelChain({ model: ["github-copilot/m1", { id: "m2", variant: "low" }], variant: "high" });
    assert.deepEqual(chain, [{ id: "m1", effort: "high" }, { id: "m2", effort: "low" }]);
    const avail = new Map([["m2", { id: "m2" }], ["m1", { id: "m1", policy: { state: "disabled" } }]]);
    const p = pickModel(chain, avail);
    assert.equal(p.pick.id, "m2");
    assert.equal(p.skipped.length, 1);
    assert.equal(pickModel(chain, undefined).unverified, true);
    assert.deepEqual(foldSkillDirectives({ skills: ["*"], skills_remove: ["a"] }).skills, ["*", "!a"]);
    assert.deepEqual(foldSkillDirectives({ skills: ["a", "b"], skills_add: ["c"], skills_remove: ["a"] }).skills, ["b", "c"]);
});

test("layered config: bundled defaults, user and project overrides, safety rules", () => {
    const repo = join(TMP, "repo-config");
    mkdirSync(join(repo, ".github"), { recursive: true });
    const userCfg = join(process.env.COPILOT_HOME, "oh-my-copilot-slim.json");
    writeFileSync(userCfg, JSON.stringify({ presets: { fast: { extends: "github-copilot", fixer: { model: "github-copilot/gpt-6-luna", variant: "low" } } }, preset: "fast", acpAgents: { demo: { command: "/bin/true" } } }));
    writeFileSync(join(repo, ".github", "oh-my-copilot-slim.json"), JSON.stringify({ disabled_hooks: ["phase-reminder", "bogus"], disabled_agents: ["designer"], acpAgents: { evil: { command: "/bin/sh" } }, agents: { oracle: { variant: "medium" } } }));
    const cfg = loadConfig(repo);
    assert.equal(cfg.preset, "fast");
    assert.deepEqual(cfg.presetChain, ["fast", "github-copilot"]);
    assert.equal(cfg.roles.fixer.variant, "low");
    assert.equal(cfg.roles.oracle.variant, "medium", "root agents.<role> beats the preset");
    assert.equal(cfg.roles.orchestrator.model, "github-copilot/gpt-6.1-sol");
    assert.equal(cfg.hookEnabled("phase-reminder"), false);
    assert.equal(cfg.hookEnabled("council-inject"), true);
    assert.equal(cfg.agentEnabled("designer"), false);
    assert.equal(cfg.agentEnabled("orchestrator"), true);
    assert.ok(cfg.acpAgents.demo && !cfg.acpAgents.evil, "project config cannot define ACP agents");
    assert.ok(cfg.warnings.some((w) => /bogus/.test(w)));
    assert.ok(cfg.warnings.some((w) => /acpAgents in the project config/.test(w)));
    runtimePreset.name = "github-copilot";
    assert.equal(loadConfig(repo).presetSource, "session (/preset)");
    runtimePreset.name = undefined;
    const p = join(TMP, "persist.json");
    writeFileSync(p, JSON.stringify({ keep: 1 }));
    persistConfigKey(p, "preset", "fast");
    assert.deepEqual(JSON.parse(readFileSync(p, "utf8")), { keep: 1, preset: "fast" });
    writeFileSync(p, "{ not json");
    assert.throws(() => persistConfigKey(p, "preset", "x"));
    rmSync(userCfg);
});

test("planPreset emits overrides only where the preset differs from the agent files", () => {
    const cfg = loadConfig(join(TMP, "no-repo"));
    const agents = [
        { id: "oh-my-copilot-slim:fixer", source: "plugin", model: "gpt-6-luna", reasoningEffort: "max" },
        { id: "oh-my-copilot-slim:oracle", source: "plugin", model: "claude-opus-5.5", reasoningEffort: "high" },
    ];
    const modelById = new Map([["gpt-6-luna", { id: "gpt-6-luna", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] }], ["claude-opus-5.5", { id: "claude-opus-5.5" }]]);
    assert.equal(planPreset(cfg, { agents, modelById }).settings, null, "bundled preset matches the agent files");
    cfg.roles.fixer = { model: ["github-copilot/missing", "github-copilot/claude-opus-5.5"], variant: "high" };
    cfg.agentEnabled = (r) => r !== "oracle";
    const plan = planPreset(cfg, { agents, modelById });
    assert.deepEqual(plan.settings.agents["oh-my-copilot-slim:fixer"], { model: "claude-opus-5.5", effortLevel: "high" });
    assert.deepEqual(plan.settings.disabledSubagents, ["oh-my-copilot-slim:oracle"]);
});

test("prompt overrides: nearest directory and preset subdir win; append is separate", async () => {
    const repo = join(TMP, "repo-prompts");
    const base = join(repo, ".github", "oh-my-copilot-slim");
    mkdirSync(join(base, "fast"), { recursive: true });
    writeFileSync(join(base, "fixer.md"), "generic");
    writeFileSync(join(base, "fast", "fixer.md"), "preset-specific");
    writeFileSync(join(base, "fixer_append.md"), "extra");
    const dirs = await promptDirs(repo, "fast");
    const r = resolveRolePrompt({}, dirs, "fixer");
    assert.equal(r.file.text, "preset-specific");
    assert.equal(r.append.text, "extra");
    assert.equal(resolveRolePrompt({ prompt: "inline" }, dirs, "fixer").notes.length, 1);
    assert.equal(resolveRolePrompt({}, dirs, "oracle").any, false);
    assert.ok((await promptDirs(repo, "../evil")).every((d) => !d.path.includes("evil")));
});

test("append override keeps the authored prompt even when agent.list omits it", async () => {
    const repo = join(TMP, "repo-append");
    mkdirSync(join(repo, ".github", "oh-my-copilot-slim"), { recursive: true });
    writeFileSync(join(repo, ".github", "oh-my-copilot-slim", "oracle_append.md"), "EXTRA");
    const agentFile = join(TMP, "oracle.agent.md");
    writeFileSync(agentFile, "---\nname: oracle\n---\n\nAUTHORED body\n");
    assert.equal(stripFrontmatter("---\na: 1\n---\nbody"), "body");
    const calls = [];
    let agents = [{ id: "oh-my-copilot-slim:oracle", path: agentFile }, { id: "oh-my-copilot-slim:fixer" }];
    writeFileSync(join(repo, ".github", "oh-my-copilot-slim", "fixer_append.md"), "FIXER-EXTRA");
    const prev = rt.session;
    rt.session = { rpc: { agent: { list: async () => ({ agents }), setPrompt: async (p) => calls.push(p) } } };
    try {
        await applyPromptOverrides(repo);
        assert.equal(calls.length, 1, "fixer has no readable authored prompt, so setPrompt must not be called");
        assert.match(calls[0].prompt, /^AUTHORED body\n*\s*EXTRA$/);
        assert.equal(promptState.fallbackAppend.get("fixer"), "FIXER-EXTRA");
    } finally {
        rt.session = prev;
    }
});

test("image routing saves blobs for observer only when the model lacks vision", async () => {
    const cwd = join(TMP, "repo-images");
    mkdirSync(cwd);
    const cfg = loadConfig(cwd);
    const modelList = (vision) => async () => ({ models: [{ id: "m", capabilities: { supports: { vision } } }] });
    rt.session = { rpc: { model: { getCurrent: async () => ({ modelId: "m" }), list: modelList(false) } }, log: async () => {} };
    const attachments = [{ type: "blob", mimeType: "image/png", data: Buffer.from("png-bytes").toString("base64"), displayName: "shot.png" }, { type: "file", path: "/tmp/notes.txt" }];
    const nudge = await routeImages({ attachments, cwd, sessionId: "sess/1", cfg });
    assert.match(nudge, /observer/);
    const saved = /- (.*\.png)/.exec(nudge)[1];
    assert.ok(saved.startsWith(join(cwd, ".slim", "images", "sess_1")) && existsSync(saved));
    assert.equal(await routeImages({ attachments, cwd, sessionId: "s", cfg: { ...cfg, imageRouting: "direct" } }), undefined);
    rt.session.rpc.model.list = modelList(true);
    assert.equal(await routeImages({ attachments, cwd, sessionId: "s", cfg }), undefined);
    rt.session = undefined;
});

test("ast-grep result formatting", () => {
    const m = { file: "a.ts", range: { start: { line: 0, column: 2 }, end: { line: 0, column: 10 } }, lines: "foo(bar)", text: "foo(bar)", replacement: "baz(bar)" };
    assert.match(formatSearch({ matches: [m], totalMatches: 1, truncated: false }), /a\.ts:\n  1: foo\(bar\)/);
    assert.match(formatSearch({ matches: [], totalMatches: 0 }), /No matches/);
    assert.match(formatReplace({ matches: [m], totalMatches: 1 }, true), /DRY RUN/);
});

test("command prompt builders", () => {
    assert.deepEqual(parseReflectArgs("--sessions --last 500 auth flow"), { sessions: true, last: 100, focus: "auth flow" });
    assert.match(reflectPrompt(parseReflectArgs("--sessions")), /last 50 sessions/);
    const lp = loopPrompt("fix lint, max 3 tries", ".slim/loop-history/x");
    assert.match(lp, /fix lint, max 3 tries/);
    assert.match(lp, /\.slim\/loop-history\/x\/history-/);
    assert.match(interviewPrompt("todo app", { interview: { outputDir: "specs" } }), /`specs\/<slug>\.md`/);
    assert.match(interviewPrompt("", { interview: {} }), /asking the user/);
});

test("council seats normalize models and efforts", () => {
    const seats = councilSeats({ council: { councillors: [{ model: "github-copilot/gpt-6.1-sol", variant: "high" }, { name: "b", model: "claude-opus-5.5" }, { name: "bad" }] } });
    assert.deepEqual(seats, [{ name: "seat-1", model: "gpt-6.1-sol", reasoningEffort: "high" }, { name: "b", model: "claude-opus-5.5", reasoningEffort: undefined }]);
});

test("smartfetch: llms.txt preference, main-content extraction, binary save", async () => {
    const page = `<!doctype html><html><head><title>Doc Page</title><meta name="description" content="About things"><link rel="canonical" href="/canon"></head>
<body><nav>NAVIGATION JUNK</nav><main><h1>Hello</h1><p>Some <a href="/x">link</a> text with <code>code()</code>.</p><pre><code>let a = 1;</code></pre><ul><li>one</li><li>two</li></ul></main><footer>FOOTER JUNK</footer></body></html>`;
    const server = createServer((req, res) => {
        if (req.url === "/llms.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("# Site\n\n> llms summary\n");
        if (req.url === "/page") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
        if (req.url === "/redirect") return res.writeHead(302, { location: "/page" }).end();
        if (req.url === "/bin") return res.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.from([0, 1, 2, 3]));
        res.writeHead(404).end("nope");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const text = textOf(await smartfetch({ url: `${base}/redirect`, prefer_llms_txt: "never" }));
        assert.match(text, /# Hello/);
        assert.match(text, /\[link\]\(http:\/\/127\.0\.0\.1:\d+\/x\)/);
        assert.match(text, /```[\s\S]*let a = 1;/);
        assert.doesNotMatch(text, /NAVIGATION JUNK|FOOTER JUNK/);
        assert.match(text, /Doc Page/);
        assert.match(text, /canonical_url: "http:\/\/127\.0\.0\.1:\d+\/canon"/);
        assert.match(textOf(await smartfetch({ url: `${base}/page`, prefer_llms_txt: "always" })), /llms summary/);
        const binText = textOf(await smartfetch({ url: `${base}/bin`, save_binary: true }));
        const savedPath = /(\/\S+\/smartfetch\/[^\s`'")]+)/.exec(binText)?.[1];
        assert.ok(savedPath && existsSync(savedPath), binText);
        rmSync(savedPath);
        assert.match(textOf(await smartfetch({ url: `${base}/missing` })), /404/);
    } finally {
        server.close();
    }
    assert.equal(isDocsLikeUrl(new URL("https://docs.example.com/x")), true);
    assert.equal(isDocsLikeUrl(new URL("https://example.com/blog")), false);
    assert.match(extractHtml("<html><body><article><p>Body</p></article></body></html>", "https://e.com").markdown, /Body/);
});

test("ACP: config validation, permission option choice, stub agent round trip", async () => {
    assert.match(normalizeAcpAgent("x", { args: [] }).error, /command is required/);
    assert.match(normalizeAcpAgent("x", { command: "a", cwd: "rel" }).error, /absolute/);
    assert.equal(normalizeAcpAgent("x", { command: "a" }).config.permissionMode, "ask");
    const opts = { options: [{ optionId: "y", kind: "allow_once" }, { optionId: "n", kind: "reject_once" }] };
    assert.equal(selectPermissionOption(opts, "allow"), "y");
    assert.equal(selectPermissionOption(opts, "reject"), "n");
    const stub = join(TMP, "acp-stub.mjs");
    writeFileSync(
        stub,
        `import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
let promptId;
createInterface({ input: process.stdin }).on("line", (l) => {
  const m = JSON.parse(l);
  if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, authMethods: [] } });
  else if (m.method === "session/new") send({ id: m.id, result: { sessionId: "s1" } });
  else if (m.method === "session/prompt") {
    promptId = m.id;
    send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", status: "completed" } } });
    send({ id: 900, method: "session/request_permission", params: { toolCall: { title: "Edit file" }, options: [{ optionId: "ok", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }] } });
  } else if (m.id === 900) {
    send({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "permission=" + m.result.outcome.optionId } } } });
    send({ id: promptId, result: { stopReason: "end_turn" } });
  }
});`,
    );
    const cfg = normalizeAcpAgent("stub", { command: process.execPath, args: [stub], timeoutMs: 10000 }).config;
    const declined = await runAcp("stub", cfg, { prompt: "hi", cwd: TMP, ask: async () => false });
    assert.equal(declined.text, "permission=no");
    assert.deepEqual(declined.tools, ["✓ Read file"]);
    assert.equal((await runAcp("stub", cfg, { prompt: "hi", cwd: TMP })).text, "permission=no", "no confirmation UI means reject");
    assert.equal((await runAcp("stub", cfg, { prompt: "hi", cwd: TMP, ask: async () => true })).text, "permission=ok");
    await assert.rejects(runAcp("dead", { ...cfg, args: ["-e", "process.exit(3)"] }, { prompt: "x", cwd: TMP }), /exited before replying/);
});
