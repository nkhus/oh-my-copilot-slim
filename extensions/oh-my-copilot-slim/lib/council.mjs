// Council seats, roster tool, and the keyword-triggered Council Mode procedure.
// Trigger list and procedure adapted from alvinunreal/oh-my-opencode-slim (MIT),
// src/hooks/council-inject/index.ts. Modified for GitHub Copilot; see NOTICE.
import { rt, CONFIG_FILE, asArray, safe, nativeModel, effortOf } from "./core.mjs";
import { loadConfig } from "./config.mjs";

const COUNCIL_TRIGGER_PATTERN =
    /\b(?:councillors?|councils?|consensus|second opinions?|roundtable|multiple opinions|multiple models|several models|multi-model|multi-?agents?|multiagent|panels?|deliberat\w*|diverse perspectives|sounding board)\b|议会|議會|評議会|協議会|顾问团|顧問團|圆桌|圓桌|円卓|共识|共識|合意|第二意见|第二意見|セカンドオピニオン|多方意见|多模型|多个模型|多個模型|几个模型|幾個模型|别的模型|別的模型|其他模型|多代理|多智能体|マルチエージェント|複数のモデル|평의회|위원회|원탁|합의|세컨드 오피니언|여러 모델|멀티에이전트|شورا|انجمن|میزگرد|اجماع|نظر دوم|چند مدل|چندعامله/i;
const CODE_FENCE_PATTERN = /```[\s\S]*?```/g;
const INLINE_CODE_PATTERN = /`[^`\n]*`/g;
const SLASH_COMMAND_LEAD_PATTERN = /^\s*\/[a-zA-Z][\w-]*(?:\s|$)/;

export function matchesCouncilTrigger(text) {
    if (typeof text !== "string") return false;
    const clean = text.replace(CODE_FENCE_PATTERN, " ").replace(INLINE_CODE_PATTERN, " ");
    if (SLASH_COMMAND_LEAD_PATTERN.test(clean)) return false;
    return COUNCIL_TRIGGER_PATTERN.test(clean);
}

const COUNCIL_STEPS = [
    "Call omcs_council_roster. If it reports no seats, tell the user council is not configured and offer oracle instead; never invent seats.",
    "Embed a brief summary of needed context into each seat prompt (seats receive only their prompt).",
    "Dispatch the question to every seat in parallel: one `task` call per seat with the councillor agent, that seat's `model` and (if set) `reasoning_effort`, named after the seat.",
    "Collect all responses (read_agent for background seats); retry an empty seat once; mark failed or substituted seats; do not wait on stragglers.",
    "Call `task` with the council agent, prompt = question + all seat responses labeled by seat name and model (do not summarize them), and present its report.",
];
const procedure = (steps) =>
    ["## Council Mode", "", "When the conversation calls for multi-model consensus, run this procedure:", ...steps.map((t, i) => `${i + 1}. ${t}`)].join("\n");
export const COUNCIL_PROCEDURE = procedure(COUNCIL_STEPS);

export function councilSeats(cfg) {
    const raw = Array.isArray(cfg.council?.councillors) ? cfg.council.councillors : [];
    return raw
        .filter((s) => s && typeof s.model === "string")
        .map((s, i) => ({ name: typeof s.name === "string" && s.name ? s.name : `seat-${i + 1}`, model: nativeModel(s.model), reasoningEffort: effortOf(s) }));
}

export async function councilRoster(cwd) {
    const cfg = loadConfig(cwd);
    if (!cfg.agentEnabled("council")) return "Council is DISABLED (council is listed in disabled_agents). Offer oracle as a single-model alternative.";
    const seats = councilSeats(cfg);
    if (!seats.length) {
        return [
            "Council is NOT CONFIGURED: no council seats are defined, so no councillors will be dispatched.",
            `To enable it, add seats to .github/${CONFIG_FILE} (project) or $COPILOT_HOME/${CONFIG_FILE} (user), e.g.:`,
            '{ "council": { "councillors": [ { "name": "alpha", "model": "claude-opus-5.5", "variant": "high" }, { "name": "beta", "model": "gpt-6.1-sol" } ] } }',
            "Each seat costs one model call per council run. Offer oracle as a single-model alternative.",
        ].join("\n");
    }
    const models = await safe(() => rt.session.rpc.model.list());
    const ids = new Set(models.ok ? asArray(models.value, "list").concat(asArray(models.value, "models")).map((m) => m?.id) : []);
    const rows = seats.map((s) => {
        const status = !models.ok ? "availability unverified" : ids.has(s.model) ? "available" : "NOT AVAILABLE (dispatch would fall back to the session model; report this seat as substituted)";
        return `- ${s.name}: model=${s.model}${s.reasoningEffort ? ` reasoning_effort=${s.reasoningEffort}` : ""} - ${status}`;
    });
    return [`Council seats (${seats.length}):`, ...rows, "", procedure(COUNCIL_STEPS.slice(1))].join("\n");
}
