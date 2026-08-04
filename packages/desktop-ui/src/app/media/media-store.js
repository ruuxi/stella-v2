/**
 * Persistent media studio state — history + form state backed by the shared
 * UI state store.
 */
import { uiState } from "@/platform/ui-state";
/* ── Keys ── */
const HISTORY_KEY = "stella-media-history";
const FORM_KEY = "stella-media-form";
const MAX_HISTORY = 100;
/* ── History ── */
export function loadHistory() {
    try {
        return JSON.parse(uiState.getItem(HISTORY_KEY) || "[]");
    }
    catch {
        return [];
    }
}
export function saveHistory(entries) {
    uiState.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, MAX_HISTORY)));
}
export function addHistoryEntry(entry) {
    const entries = [entry, ...loadHistory().filter((e) => e.id !== entry.id)];
    saveHistory(entries);
    return entries;
}
export function updateHistoryEntry(id, patch) {
    const entries = loadHistory().map((e) => e.id === id ? { ...e, ...patch } : e);
    saveHistory(entries);
    return entries;
}
/* ── Form state ── */
const DEFAULT_FORM = {
    category: "image",
    capabilityId: null,
    prompt: "",
    aspectRatio: null,
    profile: null,
    extraValues: {},
};
export function loadFormState() {
    try {
        const raw = uiState.getItem(FORM_KEY);
        if (!raw)
            return DEFAULT_FORM;
        return { ...DEFAULT_FORM, ...JSON.parse(raw) };
    }
    catch {
        return DEFAULT_FORM;
    }
}
export function saveFormState(state) {
    uiState.setItem(FORM_KEY, JSON.stringify(state));
}
/* ── Output extraction ── */
export function extractOutput(output) {
    if (!output || typeof output !== "object")
        return { kind: "unknown" };
    const o = output;
    if (Array.isArray(o.images) && o.images.length > 0) {
        const imageEntries = o.images;
        const urls = imageEntries
            .map((img) => img.url)
            .filter((u) => Boolean(u));
        const mimeTypes = imageEntries
            .filter((img) => Boolean(img.url))
            .map((img) => img.mimeType ?? img.content_type);
        if (urls.length > 0)
            return { kind: "image", urls, mimeTypes };
    }
    if (o.video && typeof o.video === "object") {
        const url = o.video.url;
        if (url)
            return { kind: "video", url };
    }
    for (const key of ["audio_file", "audio"]) {
        const src = o[key];
        if (src && typeof src === "object") {
            const url = src.url;
            if (url)
                return { kind: "audio", url };
        }
    }
    if (typeof o.text === "string")
        return { kind: "text", text: o.text };
    if (o.model_mesh && typeof o.model_mesh === "object") {
        const url = o.model_mesh.url;
        if (url)
            return { kind: "download", url, label: "Download 3D model" };
    }
    for (const val of Object.values(o)) {
        if (val &&
            typeof val === "object" &&
            "url" in val) {
            const url = val.url;
            if (url)
                return { kind: "download", url, label: "Download result" };
        }
    }
    return { kind: "unknown" };
}
/* ── Save output files to desktop/state ── */
export async function saveOutputToStella(output, jobId) {
    const saveApi = window.electronAPI?.media?.saveOutput;
    if (!saveApi)
        return output;
    const ext = (url, mimeType) => {
        const normalizedMime = mimeType?.split(";")[0]?.trim().toLowerCase();
        if (normalizedMime === "image/jpeg")
            return "jpg";
        if (normalizedMime === "image/png")
            return "png";
        if (normalizedMime === "image/gif")
            return "gif";
        if (normalizedMime === "image/webp")
            return "webp";
        const m = url.match(/\.(\w{2,5})(?:[?#]|$)/);
        if (m)
            return m[1];
        if (output.kind === "image")
            return "png";
        if (output.kind === "video")
            return "mp4";
        if (output.kind === "audio")
            return "mp3";
        return "bin";
    };
    try {
        switch (output.kind) {
            case "image": {
                const results = await Promise.all(output.urls.map((url, i) => saveApi(url, `${jobId}_${i}.${ext(url, output.mimeTypes?.[i])}`, "image")));
                const localPaths = results
                    .filter((r) => r.ok && r.path)
                    .map((r) => r.path);
                return { ...output, localPaths };
            }
            case "video":
            case "audio":
            case "download": {
                const result = await saveApi(output.url, `${jobId}.${ext(output.url)}`);
                return result.ok && result.path
                    ? { ...output, localPath: result.path }
                    : output;
            }
            default:
                return output;
        }
    }
    catch {
        return output;
    }
}
/* ── Thumbnail generation ── */
const THUMB_SIZE = 80;
/** Downscale an image URL to a tiny JPEG data URL for the shared UI state store. */
export function generateThumb(url) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
            const scale = Math.min(THUMB_SIZE / img.naturalWidth, THUMB_SIZE / img.naturalHeight, 1);
            const w = Math.round(img.naturalWidth * scale);
            const h = Math.round(img.naturalHeight * scale);
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            canvas.getContext("2d").drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL("image/jpeg", 0.6));
        };
        img.onerror = () => resolve(null);
        img.src = url;
    });
}
/* ── Open outputs folder ── */
export async function openOutputsFolder() {
    const dir = await window.electronAPI?.media?.getStellaMediaDir();
    if (!dir)
        return;
    // showItemInFolder needs a file, but we want the folder — create a
    // placeholder reference so the OS opens the directory.
    const folderPath = `${dir}${dir.includes("\\") ? "\\" : "/"}outputs`;
    window.electronAPI?.system?.showItemInFolder(folderPath);
}
