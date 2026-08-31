import { isOfficePreviewRef } from "@stella/contracts/office-preview";
import { extractLocalFileLinkPaths } from "@stella/contracts/local-file-links";
import { kindForPath, basenameOf, extensionOf, fileArtifactPayloadForPath, isDeveloperResourceExtension, pickPrimaryEditedPath, } from "@/features/workspace-display/path-to-viewer";
import { isToolResult } from "./event-transforms";
const asNonEmptyString = (value) => {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};
const requestedSizeFromRecord = (value) => {
    if (!value || typeof value !== "object")
        return null;
    const record = value;
    const width = typeof record.width === "number" && Number.isFinite(record.width)
        ? Math.floor(record.width)
        : null;
    const height = typeof record.height === "number" && Number.isFinite(record.height)
        ? Math.floor(record.height)
        : null;
    return width !== null && height !== null && width > 0 && height > 0
        ? { width, height }
        : null;
};
const officeRefForResult = (event) => {
    if (!isToolResult(event))
        return null;
    const ref = event.payload
        .officePreviewRef;
    return isOfficePreviewRef(ref) ? ref : null;
};


const imageGenPayloadsByPath = (toolEvents) => {
    const byPath = new Map();
    for (const event of toolEvents) {
        if (!isToolResult(event))
            continue;
        if (event.payload.toolName !== "image_gen" || event.payload.error)
            continue;
        const result = event.payload.result;
        if (!result || typeof result !== "object")
            continue;
        const record = result;
        const rawPaths = record.filePaths;
        if (!Array.isArray(rawPaths))
            continue;
        const filePaths = rawPaths.filter((filePath) => typeof filePath === "string" && filePath.trim().length > 0);
        if (filePaths.length === 0)
            continue;
        const payload = {
            kind: "media",
            asset: { kind: "image", filePaths },
            createdAt: event.timestamp,
            ...(typeof record.jobId === "string" ? { jobId: record.jobId } : {}),
            ...(typeof record.capability === "string"
                ? { capability: record.capability }
                : {}),
            ...(typeof record.prompt === "string" ? { prompt: record.prompt } : {}),
            ...(typeof record.aspectRatio === "string"
                ? { aspectRatio: record.aspectRatio }
                : {}),
            ...(requestedSizeFromRecord(record.requestedSize)
                ? { requestedSize: requestedSizeFromRecord(record.requestedSize) }
                : {}),
            ...(event.payload.agentType ===
                "orchestrator"
                ? { presentation: "inline-image" }
                : {}),
        };
        for (const filePath of filePaths) {
            if (!byPath.has(filePath))
                byPath.set(filePath, payload);
        }
    }
    return byPath;
};

const orchestratorHtmlPayload = (toolEvents) => {
    for (let index = toolEvents.length - 1; index >= 0; index -= 1) {
        const event = toolEvents[index];
        if (!isToolResult(event))
            continue;
        if (event.payload.toolName !== "html" || event.payload.error)
            continue;
        if (event.payload.agentType !== "orchestrator") {
            continue;
        }
        const candidate = event.payload.details && typeof event.payload.details === "object"
            ? event.payload.details
            : event.payload.result;
        if (!candidate || typeof candidate !== "object")
            continue;
        const record = candidate;
        const filePath = asNonEmptyString(record.filePath);
        if (!filePath)
            continue;
        const title = asNonEmptyString(record.title) ?? undefined;
        const slug = asNonEmptyString(record.slug) ?? undefined;
        const createdAtNum = typeof record.createdAt === "number" && Number.isFinite(record.createdAt)
            ? record.createdAt
            : event.timestamp;
        return {
            kind: "canvas-html",
            filePath,
            ...(title ? { title } : {}),
            ...(slug ? { slug } : {}),
            createdAt: createdAtNum,
        };
    }
    return null;
};

const HTML_OUTPUT_PATH_RE = /(?:^|\/)(?:\.stella|state)\/outputs\/(?:.+\/)?([^/]+)\.html$/;
const titleFromHtmlSlug = (slug) => {
    const trimmed = slug.trim();
    if (!trimmed)
        return "Canvas";
    return trimmed
        .split("-")
        .filter((segment) => segment.length > 0)
        .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
        .join(" ");
};
const normalizeNumImages = (value) => {
    if (typeof value !== "number" || !Number.isFinite(value))
        return null;
    const rounded = Math.floor(value);
    return rounded >= 1 ? Math.min(rounded, 4) : null;
};
const orchestratorImageGenRecord = (event) => {
    if (!isToolResult(event))
        return null;
    if (event.payload.toolName !== "image_gen" || event.payload.error)
        return null;
    if (event.payload.agentType !== "orchestrator") {
        return null;
    }
    const candidate = event.payload.details && typeof event.payload.details === "object"
        ? event.payload.details
        : event.payload.result;
    if (!candidate || typeof candidate !== "object")
        return null;
    return candidate;
};
const isOrchestratorInlineImageGenResult = (event) => orchestratorImageGenRecord(event) !== null;

export const deriveTurnInlineImagePayloads = (toolEvents) => {
    const payloads = [];
    for (const event of toolEvents) {
        const record = orchestratorImageGenRecord(event);
        if (!record)
            continue;
        const jobId = asNonEmptyString(record.jobId);
        const rawPaths = record.filePaths;
        const filePaths = Array.isArray(rawPaths)
            ? rawPaths.filter((filePath) => typeof filePath === "string" && filePath.trim().length > 0)
            : [];
        const numImages = normalizeNumImages(record.numImages) ??
            normalizeNumImages(record.num_images);
        if (!jobId && filePaths.length === 0)
            continue;
        payloads.push({
            kind: "media",
            asset: { kind: "image", filePaths },
            ...(jobId ? { jobId } : {}),
            ...(typeof record.capability === "string"
                ? { capability: record.capability }
                : {}),
            ...(typeof record.prompt === "string" ? { prompt: record.prompt } : {}),
            ...(typeof record.aspectRatio === "string"
                ? { aspectRatio: record.aspectRatio }
                : {}),
            ...(requestedSizeFromRecord(record.requestedSize)
                ? { requestedSize: requestedSizeFromRecord(record.requestedSize) }
                : {}),
            ...(numImages ? { numImages } : {}),
            presentation: "inline-image",
            createdAt: event.timestamp,
        });
    }
    return payloads;
};
export const buildPayloadFromBarePath = (filePath, createdAt, options) => {

    const htmlMatch = HTML_OUTPUT_PATH_RE.exec(filePath);
    if (htmlMatch) {
        const slug = htmlMatch[1];
        return {
            kind: "canvas-html",
            filePath,
            title: titleFromHtmlSlug(slug),
            slug,
            createdAt,
        };
    }
    switch (kindForPath(filePath)) {
        case "markdown":
            return {
                kind: "markdown",
                filePath,
                title: basenameOf(filePath),
                createdAt,
            };
        case "office-document":
        case "office-spreadsheet":
        case "office-slides":
            return (fileArtifactPayloadForPath(filePath, createdAt) ?? {
                kind: "media",
                asset: {
                    kind: "download",
                    filePath,
                    label: basenameOf(filePath),
                },
                createdAt,
            });
        case "pdf":
            return { kind: "pdf", filePath };
        case "image":
            return {
                kind: "media",
                asset: { kind: "image", filePaths: [filePath] },
                createdAt,
            };
        case "video":
            return { kind: "media", asset: { kind: "video", filePath }, createdAt };
        case "audio":
            return { kind: "media", asset: { kind: "audio", filePath }, createdAt };
        case "model3d":
            return {
                kind: "media",
                asset: { kind: "model3d", filePath },
                createdAt,
            };
        default:
            if (options?.developerResourcesEnabled === true &&
                isDeveloperResourceExtension(extensionOf(filePath))) {
                return {
                    kind: "source-diff",
                    filePath,
                    title: basenameOf(filePath),
                    ...(options.patch ? { patch: options.patch } : {}),
                    createdAt,
                };
            }

            return null;
    }
};
export const extractMarkdownLinkPaths = extractLocalFileLinkPaths;

export const collectTurnSourceDiffPayloads = (toolEvents, options) => {
    if (options?.developerResourcesEnabled !== true)
        return [];
    const seen = new Set();
    const payloads = [];
    const createdAt = toolEvents[toolEvents.length - 1]?.timestamp ?? Date.now();
    for (const filePath of extractLocalFileLinkPaths(options.assistantText ?? "")) {
        if (!isDeveloperResourceExtension(extensionOf(filePath)) || seen.has(filePath))
            continue;
        seen.add(filePath);
        payloads.push({
            kind: "source-diff",
            filePath,
            title: basenameOf(filePath),
            createdAt,
        });
    }
    return payloads;
};
export const deriveTurnResource = (toolEvents, assistantText = "", turnCwd, options) => {
    if (toolEvents.length === 0 && !assistantText)
        return null;

    const htmlPayload = orchestratorHtmlPayload(toolEvents);
    if (htmlPayload)
        return htmlPayload;

    const payloadByPath = new Map();
    const imagePayloads = imageGenPayloadsByPath(toolEvents);
    for (const [filePath, payload] of imagePayloads) {
        if (!payloadByPath.has(filePath)) {
            payloadByPath.set(filePath, payload);
        }
    }
    const referencedFromOffice = new Map();
    for (const event of toolEvents) {
        const office = officeRefForResult(event);
        if (!office)
            continue;
        const path = office.sourcePath;
        if (!referencedFromOffice.has(path)) {
            referencedFromOffice.set(path, office);
        }
        if (!payloadByPath.has(path)) {
            payloadByPath.set(path, { kind: "office", previewRef: office });
        }
    }

    const candidatePaths = [
        ...imagePayloads.keys(),
        ...referencedFromOffice.keys(),
        ...extractLocalFileLinkPaths(assistantText),
    ];
    if (candidatePaths.length === 0)
        return null;
    const primary = pickPrimaryEditedPath(candidatePaths, {
        includeDeveloperResources: options?.developerResourcesEnabled,
    });
    if (!primary)
        return null;
    const directPayload = payloadByPath.get(primary);
    if (directPayload)
        return directPayload;
    const fallbackTimestamp = toolEvents[toolEvents.length - 1]?.timestamp ?? Date.now();
    return buildPayloadFromBarePath(primary, fallbackTimestamp, {
        developerResourcesEnabled: options?.developerResourcesEnabled,
    });
};
