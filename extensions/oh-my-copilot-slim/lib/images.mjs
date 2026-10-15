// Observer image routing: when the active model cannot read images, save image
// attachments under .slim/images/<session>/ and tell the main agent to delegate to observer.
// Independently written; behavior follows upstream oh-my-opencode-slim image_routing (see NOTICE).
import { mkdirSync, writeFileSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, basename, extname } from "node:path";
import { rt, asArray, safe, log } from "./core.mjs";

const READ_LIMIT = 20 * 1024 * 1024;
const EXT_BY_MIME = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp", "image/svg+xml": ".svg", "image/heic": ".heic", "image/tiff": ".tiff" };
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|heic|tiff?)$/i;

const isImage = (a) =>
    (a?.type === "blob" && typeof a.mimeType === "string" && a.mimeType.startsWith("image/")) ||
    (a?.type === "file" && ((typeof a.mimeType === "string" && a.mimeType.startsWith("image/")) || IMAGE_EXT.test(String(a.path ?? ""))));

// true / false from the model's capabilities, undefined when unknown (Auto, missing info).
export async function currentModelVision() {
    const s = rt.session;
    const [cur, list] = await Promise.all([safe(() => s.rpc.model.getCurrent()), safe(() => s.rpc.model.list())]);
    if (!cur.ok || !list.ok) return { vision: undefined, model: undefined };
    const id = cur.value?.modelId;
    const info = asArray(list.value, "list").concat(asArray(list.value, "models")).find((m) => m?.id === id);
    const v = info?.capabilities?.supports?.vision;
    return { vision: typeof v === "boolean" ? v : undefined, model: id };
}

const safeSegment = (s) => String(s ?? "session").replace(/[^\w.-]/g, "_").slice(0, 80) || "session";

// Returns a nudge string or undefined. Never modifies or deletes the user's attachments.
export async function routeImages({ attachments, cwd, sessionId, cfg }) {
    const images = asArray(attachments).filter(isImage);
    if (!images.length) return undefined;
    if (!cfg.hookEnabled("image-routing") || cfg.imageRouting === "direct") return undefined;
    const { vision, model } = await currentModelVision();
    if (vision !== false) return undefined;
    if (!cfg.agentEnabled("observer")) {
        log(`[oh-my-copilot-slim] ${model} cannot read images and observer is disabled; enable observer or set image_routing "direct".`, "warning");
        return undefined;
    }
    const dir = join(cwd, ".slim", "images", safeSegment(sessionId));
    const readable = [];
    const oversized = [];
    for (const a of images) {
        if (a.type === "file") {
            const st = existsSync(a.path) ? statSync(a.path) : undefined;
            if (st && st.size > READ_LIMIT) oversized.push(`${a.path} (${(st.size / 1048576).toFixed(1)} MiB)`);
            else if (st) readable.push(a.path);
            continue;
        }
        const bytes = Buffer.from(a.data, "base64");
        const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
        const stem = safeSegment(basename(a.displayName ?? "image", extname(a.displayName ?? "")));
        const path = join(dir, `${stem}-${hash}${EXT_BY_MIME[a.mimeType] ?? ".img"}`);
        try {
            mkdirSync(dir, { recursive: true });
            if (!existsSync(path)) writeFileSync(path, bytes);
        } catch (err) {
            log(`[oh-my-copilot-slim] could not save image attachment: ${err?.message ?? err}`, "warning");
            continue;
        }
        if (bytes.length > READ_LIMIT) oversized.push(`${path} (${(bytes.length / 1048576).toFixed(1)} MiB)`);
        else readable.push(path);
    }
    const sections = [];
    if (readable.length)
        sections.push(
            `The current model (${model}) cannot read images. Image(s) saved to:\n${readable.map((p) => `- ${p}`).join("\n")}\nDelegate to the observer agent with the path(s) and your goal; observer reads images with its view tool.`,
        );
    if (oversized.length) sections.push(`Too large for the view tool (20 MiB); do not delegate, ask the user to compress or crop:\n${oversized.map((p) => `- ${p}`).join("\n")}`);
    if (!sections.length) return undefined;
    log(`[oh-my-copilot-slim] image routing: ${readable.length} image(s) for observer (${model} has no vision).`, "info", true);
    return `[oh-my-copilot-slim image routing]\n${sections.join("\n")}`;
}
