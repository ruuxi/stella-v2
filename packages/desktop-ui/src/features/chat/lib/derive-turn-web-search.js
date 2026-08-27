import { AGENT_IDS } from "@stella/contracts/agent-runtime";

const MAX_WEB_SEARCH_IMAGE_CARDS = 4;
const isHttpUrl = (value) => typeof value === "string" && /^https?:\/\//i.test(value.trim());

const imageDedupeKey = (image) => {
    try {
        const parsed = new URL(image);
        const path = parsed.pathname.replace(/\/+$/, "");
        return `${parsed.hostname.toLowerCase()}${path.toLowerCase()}`;
    }
    catch {
        return image.toLowerCase();
    }
};
const readResultsArray = (payload) => {
    if (!payload)
        return null;
    if (Array.isArray(payload.results)) {
        return payload.results;
    }
    const result = payload.result;
    if (result && typeof result === "object" && !Array.isArray(result)) {
        const nested = result.results;
        if (Array.isArray(nested))
            return nested;
    }
    return null;
};

export const deriveTurnWebSearchResults = (events) => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (!event || event.type !== "tool_result")
            continue;
        const payload = event.payload;
        if (!payload || payload.toolName !== "web")
            continue;
        if (typeof payload.error === "string" && payload.error)
            continue;
        if (payload.mode !== undefined && payload.mode !== "search")
            continue;

        const agentType = typeof payload.agentType === "string" ? payload.agentType : undefined;
        if (agentType !== undefined && agentType !== AGENT_IDS.ORCHESTRATOR) {
            continue;
        }
        const results = readResultsArray(payload);
        if (!results)
            continue;
        const seenUrls = new Set();
        const seenImages = new Set();
        const hits = [];
        for (const hit of results) {
            if (!hit || typeof hit !== "object")
                continue;
            const url = typeof hit.url === "string" ? hit.url.trim() : "";
            const image = typeof hit.image === "string" ? hit.image.trim() : "";
            if (!isHttpUrl(url) || !isHttpUrl(image))
                continue;
            const imageKey = imageDedupeKey(image);
            if (seenUrls.has(url) || seenImages.has(imageKey))
                continue;
            seenUrls.add(url);
            seenImages.add(imageKey);
            const favicon = typeof hit.favicon === "string" && isHttpUrl(hit.favicon)
                ? hit.favicon.trim()
                : undefined;
            hits.push({
                title: typeof hit.title === "string" ? hit.title.trim() : "",
                url,
                image,
                ...(favicon ? { favicon } : {}),
            });
            if (hits.length >= MAX_WEB_SEARCH_IMAGE_CARDS)
                break;
        }

        return hits;
    }
    return [];
};
