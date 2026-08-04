import { getEventText, } from "@/features/chat/lib/event-transforms";
import { LEADING_TIME_TAG_RE, TRAILING_TIME_TAG_RE, } from "@/shared/lib/message-timestamp";
export const getAttachments = (event) => {
    const fromPayload = event.payload?.attachments ?? [];
    const fromEnvelope = event.channelEnvelope?.attachments ?? [];
    if (fromEnvelope.length === 0) {
        return fromPayload;
    }
    const deduped = new Map();
    for (const attachment of [...fromPayload, ...fromEnvelope]) {
        const key = [
            attachment.id ?? "",
            attachment.url ?? "",
            attachment.name ?? "",
            attachment.mimeType ?? "",
            attachment.kind ?? "",
        ].join("|");
        if (!deduped.has(key)) {
            deduped.set(key, attachment);
        }
    }
    return Array.from(deduped.values());
};
export const getChannelEnvelope = (event) => event.channelEnvelope;
const isChannelMessageEvent = (event) => {
    if (event.channelEnvelope && typeof event.channelEnvelope === "object") {
        return true;
    }
    if (!event.payload || typeof event.payload !== "object") {
        return false;
    }
    const source = event.payload.source;
    return typeof source === "string" && source.trim().toLowerCase().startsWith("channel:");
};
export const getDisplayMessageText = (event) => {
    const text = getEventText(event).replace(TRAILING_TIME_TAG_RE, "");
    if (!isChannelMessageEvent(event)) {
        return text;
    }
    return text.replace(LEADING_TIME_TAG_RE, "");
};
export const getDisplayUserText = (event) => {
    const text = getEventText(event).replace(TRAILING_TIME_TAG_RE, "");
    if (!isChannelMessageEvent(event)) {
        return text;
    }
    return text.replace(LEADING_TIME_TAG_RE, "");
};
