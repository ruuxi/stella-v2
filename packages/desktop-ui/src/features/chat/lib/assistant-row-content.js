export const assistantRowHasVisibleContent = (row) => row.text.trim().length > 0 ||
    Boolean(row.officePreviewRef) ||
    Boolean(row.resourcePayload) ||
    (row.inlineImagePayloads?.length ?? 0) > 0 ||
    (row.webSearchResults?.length ?? 0) > 0 ||
    (row.mapArtifacts?.length ?? 0) > 0 ||
    (row.sourceDiffPayloads?.length ?? 0) > 0 ||
    Boolean(row.customSlot) ||
    Boolean(row.voiceSession) ||
    (row.backgroundWork?.threadIds.length ?? 0) > 0 ||
    (row.agentCompletion?.sections.length ?? 0) > 0;

export const eventRowRendersContent = (row) => row.kind !== "assistant" ||
    assistantRowHasVisibleContent(row);
