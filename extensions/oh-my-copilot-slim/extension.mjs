// oh-my-copilot-slim extension entry point. An unofficial adaptation of
// alvinunreal/oh-my-opencode-slim (MIT) for GitHub Copilot; see NOTICE.
import { joinSession } from "@github/copilot-sdk/extension";
import { rt, cwdOf } from "./lib/core.mjs";
import { doctor } from "./lib/doctor.mjs";
import { councilRoster } from "./lib/council.mjs";
import { codegraphInit } from "./lib/codegraph.mjs";
import { astGrepTools } from "./lib/astgrep.mjs";
import { smartfetchTool } from "./lib/smartfetch.mjs";
import { acpRunTool } from "./lib/acp.mjs";
import { commands } from "./lib/commands.mjs";
import { onUserPromptSubmitted, onPreToolUse, onPostToolUse, onSubagentStart, onSessionStart, onUserMessageEvent, refreshRuntime } from "./lib/hooks.mjs";

const tools = [
    {
        name: "omcs_doctor",
        description:
            "oh-my-copilot-slim: check the agent-team preset against this Copilot runtime (agents, preset models and fallbacks, reasoning effort, live preset override, prompt overrides, hooks, commands, MCP servers, skills, ast-grep, ACP agents, image routing, CodeGraph). Use when roles, models, MCPs, or skills look wrong.",
        parameters: { type: "object", properties: {} },
        skipPermission: true,
        handler: async (_args, invocation) => doctor(cwdOf(invocation)),
    },
    {
        name: "omcs_council_roster",
        description:
            "oh-my-copilot-slim: return the configured council seats (name, model, reasoning effort, availability) and the Council Mode procedure for an explicitly requested council run, or explain that none are configured.",
        parameters: { type: "object", properties: {} },
        skipPermission: true,
        handler: async (_args, invocation) => councilRoster(cwdOf(invocation)),
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
    ...astGrepTools,
    smartfetchTool,
    acpRunTool,
];

rt.session = await joinSession({
    tools,
    commands,
    hooks: { onUserPromptSubmitted, onPreToolUse, onPostToolUse, onSubagentStart, onSessionStart },
});
rt.session.on("user.message", onUserMessageEvent);
// The extension may join after sessionStart fired (or on resume); apply overrides now too.
void refreshRuntime(process.cwd()).catch(() => {});
