// Enhanced web fetch: llms.txt preference, main-content extraction, metadata, optional binary save.
// Behaviour adapted from alvinunreal/oh-my-opencode-slim (MIT), src/tools/smartfetch/*.ts.
// Reimplemented without third-party dependencies (upstream uses Readability/jsdom/turndown);
// HTML extraction here is a heuristic. Modified for GitHub Copilot; see NOTICE.
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { textResult, failResult } from "./core.mjs";

export const DOCS_HOST_SUFFIXES = [".readthedocs.io", ".readthedocs.org", ".gitbook.io", ".netlify.app", ".vercel.app", "docs.rs"];
export const DOCS_HOST_PREFIXES = ["docs.", "developer.", "dev.", "wiki."];
const MAX_REDIRECTS = 10;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_BINARY_BYTES = 2 * 1024 * 1024;
const MAX_BINARY_SAVE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_S = 30;
const MAX_TIMEOUT_S = 120;
const LLMS_PROBE_MS = 8000;
const MAX_OUTPUT_CHARS = 200_000;
const USER_AGENT = "oh-my-copilot-slim-smartfetch/0.3";
const BINARY_PREFIXES = ["image/", "audio/", "video/", "application/pdf", "application/zip", "application/octet-stream", "application/gzip", "application/x-tar"];
export const BINARY_DIR = process.env.OMCS_SMARTFETCH_DIR || join(tmpdir(), "oh-my-copilot-slim-smartfetch");

export const isDocsLikeUrl = (url) => {
    const h = url.hostname.toLowerCase();
    return DOCS_HOST_SUFFIXES.some((s) => h.endsWith(s)) || DOCS_HOST_PREFIXES.some((p) => h.startsWith(p));
};

async function readLimited(res, limit) {
    const chunks = [];
    let size = 0;
    let truncated = false;
    if (!res.body) return { data: Buffer.alloc(0), truncated };
    const reader = res.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
            chunks.push(Buffer.from(value.subarray(0, value.byteLength - (size - limit))));
            truncated = true;
            await reader.cancel().catch(() => {});
            break;
        }
        chunks.push(Buffer.from(value));
    }
    return { data: Buffer.concat(chunks), truncated };
}

// Manual redirects so the chain is reported and capped.
export async function fetchWithRedirects(url, { signal, headers = {}, sameHostOnly = false } = {}) {
    const chain = [];
    let current = url;
    for (let i = 0; i <= MAX_REDIRECTS; i++) {
        const res = await fetch(current, { redirect: "manual", signal, headers: { "User-Agent": USER_AGENT, "Accept-Language": "en;q=0.8,*;q=0.5", ...headers } });
        if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
            const next = new URL(res.headers.get("location"), current).toString();
            await res.body?.cancel().catch(() => {});
            if (sameHostOnly && new URL(next).host !== new URL(url).host) return { blockedRedirect: next, chain };
            chain.push(next);
            current = next;
            continue;
        }
        return { response: res, finalUrl: current, chain };
    }
    throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
}

function charsetOf(contentType) {
    const m = /charset=\s*"?([\w-]+)/i.exec(contentType ?? "");
    return m?.[1]?.toLowerCase();
}

function decode(buf, contentType) {
    let cs = charsetOf(contentType);
    if (!cs && /html/i.test(contentType ?? "")) cs = /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString("latin1"))?.[1]?.toLowerCase();
    try {
        return { text: new TextDecoder(cs || "utf-8").decode(buf), charset: cs || "utf-8" };
    } catch {
        return { text: new TextDecoder("utf-8").decode(buf), charset: "utf-8", fallback: true };
    }
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
export function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
        if (e[0] === "#") {
            const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
        }
        return ENTITIES[e.toLowerCase()] ?? m;
    });
}

const attr = (tag, name) => decodeEntities(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(2).find((x) => x !== undefined) ?? "");

function metaContent(html, key) {
    for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
        const t = m[0];
        if ([attr(t, "name"), attr(t, "property")].some((v) => v.toLowerCase() === key)) return attr(t, "content") || undefined;
    }
    return undefined;
}

// Pick the main content region: <main>, then <article>, then [role=main], else <body>.
function absUrl(href, base) {
    if (!href) return undefined;
    try {
        return new URL(href, base).toString();
    } catch {
        return href;
    }
}

function mainRegion(html) {
    for (const re of [/<main\b[^>]*>([\s\S]*?)<\/main>/i, /<article\b[^>]*>([\s\S]*?)<\/article>/i, /<(div|section)\b[^>]*role=["']?main["']?[^>]*>([\s\S]*)<\/\1>/i]) {
        const m = re.exec(html);
        const body = m?.[m.length - 1];
        if (body && body.replace(/<[^>]+>/g, "").trim().split(/\s+/).length >= 30) return { html: body, extracted: true };
    }
    return { html: /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html, extracted: false };
}

const BOILERPLATE = /<(script|style|noscript|template|svg|iframe|canvas|form|button|select)\b[\s\S]*?<\/\1>/gi;
const CHROME = /<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi;

export function htmlToMarkdown(fragment, baseUrl) {
    let s = fragment.replace(/<!--[\s\S]*?-->/g, "").replace(BOILERPLATE, "");
    const pres = [];
    s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner) => {
        const lang = /class=["'][^"']*(?:language|lang)-([\w+-]+)/i.exec(inner)?.[1] ?? "";
        pres.push(`\n\n\`\`\`${lang}\n${decodeEntities(inner.replace(/<[^>]+>/g, "")).replace(/\n+$/, "")}\n\`\`\`\n\n`);
        return `\u0000PRE${pres.length - 1}\u0000`;
    });
    const abs = (href) => {
        try {
            return new URL(href, baseUrl).toString();
        } catch {
            return href;
        }
    };
    s = s
        .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "").trim()}\n\n`)
        .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => `\`${t.replace(/<[^>]+>/g, "")}\``)
        .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, a, t) => {
            const text = t.replace(/<[^>]+>/g, "").trim();
            const href = attr(`<a ${a}>`, "href");
            return text && href && !href.startsWith("javascript:") && !href.startsWith("#") ? `[${text}](${abs(href)})` : text;
        })
        .replace(/<img\b[^>]*>/gi, (t) => (attr(t, "alt") ? `![${attr(t, "alt")}](${abs(attr(t, "src"))})` : ""))
        .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
        .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
        .replace(/<li\b[^>]*>/gi, "\n- ")
        .replace(/<\/(li|ul|ol)>/gi, "\n")
        .replace(/<blockquote\b[^>]*>/gi, "\n> ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/?(tr)\b[^>]*>/gi, "\n")
        .replace(/<\/(td|th)>/gi, " | ")
        .replace(/<\/?(p|div|section|table|thead|tbody|dl|dt|dd|figure|figcaption|ul|ol|hr)\b[^>]*>/gi, "\n\n")
        .replace(/<[^>]+>/g, "");
    s = decodeEntities(s)
        .replace(/[ \t\f\v\u00a0]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/\u0000PRE(\d+)\u0000/g, (_, i) => pres[Number(i)]);
    return s.replace(/\n{3,}/g, "\n\n").trim();
}

const markdownToText = (md) =>
    md
        .replace(/```[\w+-]*\n/g, "")
        .replace(/```/g, "")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/^#{1,6} /gm, "")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/`([^`]+)`/g, "$1");

export const wordCount = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);

export function qualitySignals({ text, raw, words, sourceKind, extractedMain }) {
    const out = [];
    if (words > 0 && words < 60) out.push("very_short_content");
    if (/(subscribe to continue|subscription required|sign in to continue|log in to continue|create an account to continue|members only|premium content|paywall)/i.test(text)) out.push("possible_paywall");
    if (sourceKind === "html" && !extractedMain && Buffer.byteLength(raw) / Math.max(Buffer.byteLength(text), 1) >= 10 && words < 1200) out.push("high_boilerplate_ratio");
    return out;
}

export function extractHtml(html, url, { extractMain = true } = {}) {
    const title = decodeEntities(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "") || metaContent(html, "og:title");
    const canonicalTag = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).find((t) => /\brel=["']?canonical/i.test(t));
    const meta = {
        title: title || undefined,
        description: metaContent(html, "description") ?? metaContent(html, "og:description"),
        canonical_url: canonicalTag ? absUrl(attr(canonicalTag, "href"), url) : undefined,
        site_name: metaContent(html, "og:site_name"),
        published: metaContent(html, "article:published_time"),
        lang: /<html\b[^>]*\blang=["']?([\w-]+)/i.exec(html)?.[1],
    };
    let region = { html, extracted: false };
    if (extractMain) {
        region = mainRegion(html);
        if (!region.extracted) region = { html: region.html.replace(CHROME, ""), extracted: false };
    }
    const markdown = htmlToMarkdown(region.html, url);
    const headings = [...markdown.matchAll(/^(#{1,3}) (.+)$/gm)].slice(0, 30).map((m) => `${m[1]} ${m[2]}`);
    return { markdown, text: markdownToText(markdown), meta, headings, extractedMain: region.extracted };
}

export function frontmatter(meta) {
    const lines = Object.entries(meta)
        .filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length))
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? `\n${v.map((x) => `  - ${JSON.stringify(x)}`).join("\n")}` : JSON.stringify(v)}`);
    return lines.length ? `---\n${lines.join("\n")}\n---\n\n` : "";
}

async function probeLlms(url, signal) {
    let lastError;
    for (const candidate of [`${url.origin}/llms-full.txt`, `${url.origin}/llms.txt`]) {
        try {
            const r = await fetchWithRedirects(candidate, { signal, headers: { Accept: "text/plain, text/markdown;q=0.9, */*;q=0.1" }, sameHostOnly: true });
            if (r.blockedRedirect) {
                lastError = `llms.txt probe blocked by cross-host redirect: ${r.blockedRedirect}`;
                continue;
            }
            if (!r.response.ok) {
                await r.response.body?.cancel().catch(() => {});
                continue;
            }
            const ct = r.response.headers.get("content-type") ?? "";
            const body = await readLimited(r.response, MAX_RESPONSE_BYTES);
            const { text } = decode(body.data, ct);
            const path = new URL(r.finalUrl).pathname.toLowerCase();
            if (!path.endsWith("/llms.txt") && !path.endsWith("/llms-full.txt")) {
                lastError = `llms.txt probe resolved to non-llms path: ${r.finalUrl}`;
                continue;
            }
            if (/html|xhtml/i.test(ct) || /^\s*(<!doctype html|<html\b)/i.test(text) || /<title>\s*(log in|sign in|login)\b/i.test(text)) {
                lastError = `llms.txt probe returned HTML/login content: ${r.finalUrl}`;
                continue;
            }
            if (text.trim()) return { url: r.finalUrl, text: text.replace(/\n{3,}/g, "\n\n").trim(), truncated: body.truncated };
        } catch (err) {
            lastError = `llms.txt probe failed: ${err?.message ?? err}`;
        }
    }
    return { error: lastError };
}

async function saveBinary(buf, url, contentType, disposition) {
    await mkdir(BINARY_DIR, { recursive: true });
    const fromHeader = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(disposition ?? "")?.[1];
    const raw = decodeURIComponent(fromHeader ?? basename(new URL(url).pathname) ?? "") || "download";
    const safe = raw.replace(/[^\w.-]+/g, "_").replace(/^\.+/, "").slice(0, 100) || "download";
    const ext = /\.[\w]{1,8}$/.test(safe) ? "" : `.${(contentType.split("/")[1] ?? "bin").split(/[;+]/)[0]}`;
    const file = join(BINARY_DIR, `${createHash("sha256").update(buf).digest("hex").slice(0, 12)}-${safe}${ext}`);
    await writeFile(file, buf);
    return file;
}

function render(meta, body, format) {
    if (body.length > MAX_OUTPUT_CHARS) {
        body = `${body.slice(0, MAX_OUTPUT_CHARS)}${format === "html" ? "\n<!-- [..content truncated..] -->" : "\n\n[..content truncated..]"}`;
        meta.output_truncated = true;
    }
    return `${meta ? frontmatter(meta) : ""}${body}`;
}

export async function smartfetch(args) {
    let url;
    try {
        url = new URL(String(args?.url ?? ""));
    } catch {
        throw new Error("url must be an absolute http(s) URL");
    }
    let upgraded = false;
    if (url.protocol === "http:" && !/^(localhost|127\.|\[::1\])/.test(url.host)) {
        url = new URL(url.toString().replace(/^http:/, "https:"));
        upgraded = true;
    }
    if (!/^https?:$/.test(url.protocol)) throw new Error("only http(s) URLs are supported");
    const format = ["text", "markdown", "html"].includes(args?.format) ? args.format : "markdown";
    const timeoutS = Math.min(Math.max(Number(args?.timeout) || DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S);
    const extractMain = args?.extract_main !== false;
    const preferLlms = ["auto", "always", "never"].includes(args?.prefer_llms_txt) ? args.prefer_llms_txt : "auto";
    const includeMeta = args?.include_metadata !== false;
    const saveBin = args?.save_binary === true;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutS}s`)), timeoutS * 1000);
    const base = { requested_url: args.url, upgraded_to_https: upgraded || undefined };
    try {
        let llmsError;
        if (preferLlms === "always" || (preferLlms === "auto" && isDocsLikeUrl(url))) {
            const pc = new AbortController();
            const pt = setTimeout(() => pc.abort(), LLMS_PROBE_MS);
            const onAbort = () => pc.abort();
            ctrl.signal.addEventListener("abort", onAbort);
            const llms = await probeLlms(url, pc.signal).finally(() => {
                clearTimeout(pt);
                ctrl.signal.removeEventListener("abort", onAbort);
            });
            if (llms.text) {
                const meta = includeMeta ? { ...base, final_url: llms.url, source_kind: "llms_txt", used_llms_txt: true, truncated: llms.truncated || undefined, word_count: wordCount(llms.text) } : undefined;
                return render(meta, llms.text, format);
            }
            llmsError = llms.error ?? "no llms.txt/llms-full.txt found";
            if (preferLlms === "always") return render(includeMeta ? { ...base, used_llms_txt: false, llms_probe_error: llmsError } : undefined, `No usable llms.txt was found for ${url.origin} (${llmsError}). Re-run with prefer_llms_txt=auto or never to fetch the page itself.`, format);
        }
        let r;
        try {
            r = await fetchWithRedirects(url.toString(), { signal: ctrl.signal, headers: { Accept: format === "html" ? "text/html,*/*;q=0.8" : "text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.5" } });
        } catch (err) {
            if (!upgraded) throw err;
            url = new URL(url.toString().replace(/^https:/, "http:"));
            r = await fetchWithRedirects(url.toString(), { signal: ctrl.signal });
            base.upgraded_to_https = undefined;
            base.https_fallback_to_http = true;
        }
        const { response, finalUrl, chain } = r;
        const ct = response.headers.get("content-type") ?? "";
        const meta = { ...base, final_url: finalUrl !== args.url ? finalUrl : undefined, status: response.status, content_type: ct || undefined, redirect_chain: chain, last_modified: response.headers.get("last-modified") ?? undefined, llms_probe_error: llmsError };
        const isBinary = BINARY_PREFIXES.some((p) => ct.toLowerCase().startsWith(p)) && !/svg/i.test(ct);
        if (isBinary) {
            const limit = saveBin ? MAX_BINARY_SAVE_BYTES : MAX_BINARY_BYTES;
            const body = await readLimited(response, limit);
            const kind = ct.split(";")[0];
            if (body.truncated) return render(includeMeta ? { ...meta, source_kind: "binary" } : undefined, `${kind} payload exceeds the ${limit / 1024 / 1024} MiB limit; not saved.`, format);
            if (!saveBin) return render(includeMeta ? { ...meta, source_kind: "binary", bytes: body.data.length } : undefined, `${kind} content fetched (${body.data.length} bytes) but not saved. Re-run with save_binary=true to save it to ${BINARY_DIR}.`, format);
            const file = await saveBinary(body.data, finalUrl, kind, response.headers.get("content-disposition"));
            return render(includeMeta ? { ...meta, source_kind: "binary", bytes: body.data.length, saved_path: file } : undefined, `Saved ${kind} (${body.data.length} bytes) to ${file}. Use the view tool to inspect it if it is an image.`, format);
        }
        const body = await readLimited(response, MAX_RESPONSE_BYTES);
        const dec = decode(body.data, ct);
        const raw = dec.text;
        const isHtml = /html|xhtml/i.test(ct) || (!ct && /^\s*(<!doctype html|<html\b)/i.test(raw));
        let out;
        let info = { source_kind: isHtml ? "html" : /markdown/i.test(ct) ? "markdown" : "text" };
        if (isHtml) {
            const ex = extractHtml(raw, finalUrl, { extractMain });
            const content = format === "html" ? raw : format === "text" ? ex.text : ex.markdown;
            out = content;
            const words = wordCount(ex.text);
            info = { ...info, ...ex.meta, extracted_main: ex.extractedMain, headings: ex.headings, word_count: words, quality_signals: qualitySignals({ text: ex.text, raw, words, sourceKind: "html", extractedMain: ex.extractedMain }) };
        } else {
            out = raw.replace(/\n{3,}/g, "\n\n").trim();
            const words = wordCount(out);
            info = { ...info, word_count: words, quality_signals: qualitySignals({ text: out, raw, words, sourceKind: info.source_kind, extractedMain: false }) };
        }
        if (!response.ok) info.http_error = `${response.status} ${response.statusText}`;
        if (body.truncated) {
            info.truncated = true;
            out += format === "html" ? "\n<!-- [..content truncated..] -->" : "\n\n[..content truncated..]";
        }
        if (dec.fallback) info.decode_fallback = true;
        info.decoded_charset = dec.charset;
        return render(includeMeta ? { ...meta, ...info } : undefined, out, format);
    } finally {
        clearTimeout(timer);
    }
}

export const smartfetchTool = {
    name: "omcs_smartfetch",
    description:
        "oh-my-copilot-slim: fetch a web page or document for research. Prefers llms.txt on documentation hosts, extracts the main content as markdown/text, returns metadata (title, canonical URL, headings, redirects, quality signals) as YAML frontmatter, and can save binary downloads (PDF/images) to a temp folder. Use for docs and reference pages; it does not run JavaScript.",
    parameters: {
        type: "object",
        properties: {
            url: { type: "string", description: "Absolute http(s) URL (http is upgraded to https when possible)" },
            format: { type: "string", enum: ["markdown", "text", "html"], description: "Output format (default markdown)" },
            timeout: { type: "number", description: "Timeout in seconds, max 120 (default 30)" },
            extract_main: { type: "boolean", description: "Extract the main content region (default true)" },
            prefer_llms_txt: { type: "string", enum: ["auto", "always", "never"], description: "auto probes llms.txt on docs-like hosts (default auto)" },
            include_metadata: { type: "boolean", description: "Prepend YAML metadata (default true)" },
            save_binary: { type: "boolean", description: `Save binary payloads (up to 10 MiB) to ${BINARY_DIR} (default false)` },
        },
        required: ["url"],
    },
    handler: async (args) => {
        try {
            return textResult(await smartfetch(args));
        } catch (err) {
            return failResult(`smartfetch failed: ${err?.message ?? err}`);
        }
    },
};
