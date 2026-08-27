import { isOfficePreviewRef } from "@stella/contracts/office-preview";
import { isFileChangeRecordArray, isProducedFileRecordArray, } from "@stella/contracts/file-changes";
import { kindForPath, basenameOf, extensionOf, fileArtifactPayloadForPath, isDeclaredOutputPath, isDeveloperResourceExtension, isNoiseProducedPath, pickPrimaryEditedPath, } from "@/features/workspace-display/path-to-viewer";
import { isToolRequest, isToolResult } from "./event-transforms";
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
const normalizePosixPath = (candidate) => {
    const trimmed = candidate.trim();
    if (!trimmed)
        return trimmed;
    const leadingSlash = trimmed.startsWith("/");
    const segments = [];
    for (const part of trimmed.split("/")) {
        if (!part || part === ".")
            continue;
        if (part === "..") {
            if (segments.length > 0)
                segments.pop();
            continue;
        }
        segments.push(part);
    }
    return `${leadingSlash ? "/" : ""}${segments.join("/")}`;
};
const resolvePathAgainstCwd = (candidate, cwd) => {
    const trimmed = asNonEmptyString(candidate);
    const base = asNonEmptyString(cwd);
    if (!trimmed || !base || !base.startsWith("/"))
        return null;
    if (trimmed.startsWith("/"))
        return normalizePosixPath(trimmed);
    return normalizePosixPath(`${base.replace(/\/+$/g, "")}/${trimmed}`);
};
const resolveRelativePathFromKnownAbsolute = (candidate, absoluteCandidates) => {
    const trimmed = asNonEmptyString(candidate);
    if (!trimmed || trimmed.startsWith("/"))
        return null;

    if (trimmed.startsWith("../"))
        return null;
    const suffix = normalizePosixPath(trimmed).replace(/^\/+/, "");
    if (!suffix)
        return null;
    const matches = absoluteCandidates.filter((existing) => existing === suffix || existing.endsWith(`/${suffix}`));
    return matches.length === 1 ? matches[0] : null;
};

const isDelegatedToolResult = (event) => {
    if (!isToolResult(event))
        return false;
    const agentType = event.payload.agentType;
    return (typeof agentType === "string" &&
        agentType.trim().length > 0 &&
        agentType !== "orchestrator");
};
const fileChangesForResult = (event) => {
    if (!isToolResult(event) || isDelegatedToolResult(event))
        return [];
    const candidate = event.payload
        ?.fileChanges;
    return isFileChangeRecordArray(candidate) ? candidate : [];
};

const postChangePathForRecord = (record) => record.kind.type === "update" && record.kind.move_path
    ? record.kind.move_path
    : record.path;
const producedFilesForResult = (event) => {
    if (!isToolResult(event) || isDelegatedToolResult(event))
        return [];
    const candidate = event.payload
        ?.producedFiles;
    if (!isProducedFileRecordArray(candidate))
        return [];

    return candidate.filter((record) => !isNoiseProducedPath(postChangePathForRecord(record)));
};
const officeRefForResult = (event) => {
    if (!isToolResult(event))
        return null;
    const ref = event.payload
        .officePreviewRef;
    return isOfficePreviewRef(ref) ? ref : null;
};

const resolveFileChange = (record, timestamp) => {
    const kindType = record.kind.type;
    if (kindType === "delete")
        return null;
    const path = kindType === "update" && record.kind.move_path
        ? record.kind.move_path
        : record.path;
    const trimmed = asNonEmptyString(path);
    if (!trimmed)
        return null;
    return { path: trimmed, kind: kindType, timestamp };
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
const fileChangeHtmlOutputPayload = (toolEvents) => {
    let latest = null;
    for (const event of toolEvents) {

        if (!isToolResult(event))
            continue;
        if (event.payload.error)
            continue;
        for (const record of [
            ...fileChangesForResult(event),
            ...producedFilesForResult(event),
        ]) {
            const resolved = resolveFileChange(record, event.timestamp);
            if (!resolved)
                continue;
            const match = HTML_OUTPUT_PATH_RE.exec(resolved.path);
            if (!match)
                continue;
            if (!latest || resolved.timestamp >= latest.createdAt) {
                latest = {
                    filePath: resolved.path,
                    slug: match[1],
                    createdAt: resolved.timestamp,
                };
            }
        }
    }
    if (!latest)
        return null;
    return {
        kind: "canvas-html",
        filePath: latest.filePath,
        title: titleFromHtmlSlug(latest.slug),
        slug: latest.slug,
        createdAt: latest.createdAt,
    };
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
            if (options?.produced !== true)
                return null;
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
const patchInputForToolCall = (toolEvents, toolCallId) => {
    if (!toolCallId)
        return undefined;
    const request = toolEvents.find((event) => isToolRequest(event) &&
        event.payload.toolName === "apply_patch" &&
        event.requestId === toolCallId);
    const args = request && isToolRequest(request) ? request.payload.args : null;
    const input = args?.input ?? args?.patch;
    return typeof input === "string" && input.trim().length > 0
        ? input
        : undefined;
};
const requestIdForEvent = (event) => {
    if (typeof event.requestId === "string" && event.requestId.trim()) {
        return event.requestId;
    }
    const payloadRequestId = event.payload?.requestId;
    return typeof payloadRequestId === "string" && payloadRequestId.trim()
        ? payloadRequestId
        : undefined;
};

const MARKDOWN_LINK_RE = /\[[^\]]*?\]\(\s*(?:<([^>]+)>|([^()<>\s]+))\s*\)/g;
const NON_FILE_URL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
export const extractMarkdownLinkPaths = (assistantText) => {
    if (!assistantText)
        return [];
    const out = [];
    for (const match of assistantText.matchAll(MARKDOWN_LINK_RE)) {
        const raw = match[1] ?? match[2];
        if (!raw)
            continue;
        let decoded;
        try {
            decoded = decodeURI(raw);
        }
        catch {
            decoded = raw;
        }
        const trimmed = decoded.trim();
        if (!trimmed)
            continue;
        if (NON_FILE_URL_RE.test(trimmed))
            continue;
        out.push(trimmed);
    }
    return out;
};
const resolveReferencedMarkdownPath = (rawLinkPath, turnCwd, absoluteCandidates) => {
    const trimmed = asNonEmptyString(rawLinkPath);
    if (!trimmed)
        return null;
    if (trimmed.startsWith("/"))
        return normalizePosixPath(trimmed);
    return (resolvePathAgainstCwd(trimmed, turnCwd) ??
        resolveRelativePathFromKnownAbsolute(trimmed, absoluteCandidates) ??
        trimmed);
};

export const collectTurnSourceDiffPayloads = (toolEvents, options) => {
    if (options?.developerResourcesEnabled !== true)
        return [];
    if (toolEvents.length === 0)
        return [];
    const seen = new Set();
    const payloads = [];
    for (const event of toolEvents) {
        const records = fileChangesForResult(event);
        for (const record of records) {
            const resolved = resolveFileChange(record, event.timestamp);
            if (!resolved)
                continue;
            if (!isDeveloperResourceExtension(extensionOf(resolved.path)))
                continue;
            if (seen.has(resolved.path))
                continue;
            seen.add(resolved.path);
            const patch = isToolResult(event) && event.payload.toolName === "apply_patch"
                ? patchInputForToolCall(toolEvents, requestIdForEvent(event))
                : undefined;
            payloads.push({
                kind: "source-diff",
                filePath: resolved.path,
                title: basenameOf(resolved.path),
                ...(patch ? { patch } : {}),
                createdAt: resolved.timestamp,
            });
        }
    }
    return payloads;
};
export const deriveTurnResource = (toolEvents, assistantText = "", turnCwd, options) => {
    if (toolEvents.length === 0 && !assistantText)
        return null;

    const htmlPayload = orchestratorHtmlPayload(toolEvents) ??
        fileChangeHtmlOutputPayload(toolEvents);
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

    const editedPaths = [];
    const editedSeen = new Set();
    for (const event of toolEvents) {
        if (isOrchestratorInlineImageGenResult(event))
            continue;
        const records = fileChangesForResult(event);
        for (const record of records) {
            const resolved = resolveFileChange(record, event.timestamp);
            if (!resolved)
                continue;
            if (editedSeen.has(resolved.path))
                continue;
            editedSeen.add(resolved.path);
            editedPaths.push(resolved.path);
            if (!payloadByPath.has(resolved.path)) {
                const patch = isToolResult(event) && event.payload.toolName === "apply_patch"
                    ? patchInputForToolCall(toolEvents, requestIdForEvent(event))
                    : undefined;
                const inferred = buildPayloadFromBarePath(resolved.path, resolved.timestamp, {
                    developerResourcesEnabled: options?.developerResourcesEnabled,
                    ...(patch ? { patch } : {}),
                });
                if (inferred) {
                    payloadByPath.set(resolved.path, inferred);
                }
            }
        }
    }

    const producedPaths = [];
    const producedSeen = new Set();
    for (const event of toolEvents) {
        if (isOrchestratorInlineImageGenResult(event))
            continue;
        const records = producedFilesForResult(event);
        for (const record of records) {
            const resolved = resolveFileChange(record, event.timestamp);
            if (!resolved)
                continue;
            if (producedSeen.has(resolved.path) || editedSeen.has(resolved.path))
                continue;
            producedSeen.add(resolved.path);
            producedPaths.push(resolved.path);
            if (!payloadByPath.has(resolved.path)) {
                const inferred = buildPayloadFromBarePath(resolved.path, resolved.timestamp, {
                    produced: true,
                    developerResourcesEnabled: options?.developerResourcesEnabled,
                });
                if (inferred) {
                    payloadByPath.set(resolved.path, inferred);
                }
            }
        }
    }

    const referencedPaths = [];
    const referencedSeen = new Set();
    const absoluteCandidates = [
        ...editedPaths,
        ...producedPaths,
        ...referencedFromOffice.keys(),
    ]
        .filter((candidate) => candidate.startsWith("/"))
        .map(normalizePosixPath);
    const pushReferenced = (path) => {
        if (!path || referencedSeen.has(path) || editedSeen.has(path))
            return;
        referencedSeen.add(path);
        referencedPaths.push(path);
    };
    for (const sourcePath of referencedFromOffice.keys())
        pushReferenced(sourcePath);
    for (const linkPath of extractMarkdownLinkPaths(assistantText)) {
        pushReferenced(resolveReferencedMarkdownPath(linkPath, turnCwd, absoluteCandidates));
    }

    const rankedProducedPaths = [
        ...producedPaths.filter(isDeclaredOutputPath),
        ...producedPaths.filter((path) => !isDeclaredOutputPath(path)),
    ];
    const candidatePaths = [
        ...editedPaths,
        ...rankedProducedPaths,
        ...referencedPaths,
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
