const MODEL_MENTION_PATTERN = /(^|[\s([{])@([A-Za-z0-9][A-Za-z0-9-]*)(?=$|[\s)\]},.!?;])/g;

export function normalizeDelegatedModelMention(mention) {
    const trimmed = mention.trim();
    if (!trimmed || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(trimmed)) {
        return null;
    }
    const lower = trimmed.toLowerCase();
    if (lower === "stella")
        return "stella";
    if (lower === "xai" || lower === "grok")
        return "xai/grok-4.5";
    if (lower === "chatgpt")
        return "codex";
    if (lower === "codex" || lower === "codex-cli")
        return "codex";
    if (lower === "claude" || lower === "claude-code")
        return "claude-code";
    return null;
}

export function findDelegatedModelMention(text) {
    const first = findDelegatedModelMentions(text)[0];
    return first
        ? {
            mention: first.mention,
            spawnModel: first.spawnModel,
        }
        : null;
}

export function findDelegatedModelMentions(text) {
    MODEL_MENTION_PATTERN.lastIndex = 0;
    const mentions = [];
    let match;
    while ((match = MODEL_MENTION_PATTERN.exec(text)) !== null) {
        const mention = match[2].replace(/[.,!?;]+$/, "");
        const spawnModel = normalizeDelegatedModelMention(mention);
        if (!spawnModel)
            continue;
        const start = match.index + match[1].length;
        mentions.push({
            mention,
            spawnModel,
            start,
            end: start + mention.length + 1,
        });
    }
    return mentions;
}
