import type { EventRowViewModel } from "@/features/chat/conversation-row-types";
import {
  measurePlainTextHeight,
  measurePreWrapTextHeight,
  readTranscriptTypography,
  type TranscriptTypography,
} from "./measure";

export interface TranscriptRowMetrics {

  columnWidthPx: number;

  partGapPx: number;

  actionsHeightPx: number;

  assistant: {
    typography: TranscriptTypography;

    itemPadXPx: number;

    bubblePadXPx: number;
    bubblePadYPx: number;

    maxWidthRatio: number;

    paragraphGapPx: number;
  };

  user: {
    typography: TranscriptTypography;
    bubblePadXPx: number;
    bubblePadYPx: number;
    maxWidthRatio: number;

    clampLines: number;
  };

  epoch: string;
}

const PROBE_TEXT = "Mg";

const px = (value: string): number => Number.parseFloat(value) || 0;

const ratioOf = (maxWidth: string): number => {
  const parsed = Number.parseFloat(maxWidth);
  if (!Number.isFinite(parsed)) return 1;
  return maxWidth.trim().endsWith("%") ? parsed / 100 : 1;
};

export function measureTranscriptRowMetrics(
  host: HTMLElement,
  columnWidthPx: number,
): TranscriptRowMetrics | null {
  if (typeof getComputedStyle !== "function") return null;
  if (!(columnWidthPx > 0)) return null;

  const probe = host.ownerDocument.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:absolute;left:-99999px;top:0;width:600px;visibility:hidden;pointer-events:none;contain:layout style;";
  probe.innerHTML = `
    <div class="event-row event-row--assistant" data-pretext-probe="assistant">
      <div class="event-item assistant">
        <div class="assistant-message-text chat-bubble-text" data-pretext-probe="assistant-bubble">
          <div><div class="markdown"><p data-pretext-probe="assistant-p">${PROBE_TEXT}</p></div></div>
        </div>
        <div class="message-actions message-actions--start" data-pretext-probe="actions"></div>
      </div>
    </div>
    <div class="event-row event-row--user">
      <div class="event-item user chat-bubble-text" data-pretext-probe="user-bubble">
        <div class="event-user-body" data-pretext-probe="user-body">
          <div class="event-body" data-pretext-probe="user-text">${PROBE_TEXT}</div>
        </div>
      </div>
    </div>`;
  host.appendChild(probe);

  try {
    const pick = (name: string): HTMLElement | null =>
      probe.querySelector<HTMLElement>(`[data-pretext-probe="${name}"]`);

    const assistantRow = pick("assistant");
    const assistantItem = probe.querySelector<HTMLElement>(
      ".event-item.assistant",
    );
    const assistantBubble = pick("assistant-bubble");
    const assistantP = pick("assistant-p");
    const actions = pick("actions");
    const userBubble = pick("user-bubble");
    const userBody = pick("user-body");
    const userText = pick("user-text");
    if (
      !assistantRow ||
      !assistantItem ||
      !assistantBubble ||
      !assistantP ||
      !actions ||
      !userBubble ||
      !userBody ||
      !userText
    ) {
      return null;
    }

    const rowStyle = getComputedStyle(assistantRow);
    const itemStyle = getComputedStyle(assistantItem);
    const bubbleStyle = getComputedStyle(assistantBubble);
    const paragraphStyle = getComputedStyle(assistantP);
    const actionsStyle = getComputedStyle(actions);
    const userBubbleStyle = getComputedStyle(userBubble);
    const userBodyStyle = getComputedStyle(userBody);

    const markdown = probe.querySelector<HTMLElement>(".markdown");
    if (!markdown) return null;

    const clampRaw = userBodyStyle
      .getPropertyValue("--user-message-clamp-lines")
      .trim();
    const clampLines = Number.parseInt(clampRaw, 10);

    const assistantTypography = readTranscriptTypography(markdown);
    const userTypography = readTranscriptTypography(userText);

    const metrics: TranscriptRowMetrics = {
      columnWidthPx,
      partGapPx: px(rowStyle.rowGap),
      actionsHeightPx: px(actionsStyle.height),
      assistant: {
        typography: assistantTypography,
        itemPadXPx: px(itemStyle.paddingLeft) + px(itemStyle.paddingRight),
        bubblePadXPx:
          px(bubbleStyle.paddingLeft) +
          px(bubbleStyle.paddingRight) +
          px(bubbleStyle.borderLeftWidth) +
          px(bubbleStyle.borderRightWidth),
        bubblePadYPx:
          px(bubbleStyle.paddingTop) +
          px(bubbleStyle.paddingBottom) +
          px(bubbleStyle.borderTopWidth) +
          px(bubbleStyle.borderBottomWidth),
        maxWidthRatio: ratioOf(bubbleStyle.maxWidth),
        paragraphGapPx: px(paragraphStyle.marginBottom),
      },
      user: {
        typography: userTypography,
        bubblePadXPx:
          px(userBubbleStyle.paddingLeft) +
          px(userBubbleStyle.paddingRight) +
          px(userBubbleStyle.borderLeftWidth) +
          px(userBubbleStyle.borderRightWidth),
        bubblePadYPx:
          px(userBubbleStyle.paddingTop) +
          px(userBubbleStyle.paddingBottom) +
          px(userBubbleStyle.borderTopWidth) +
          px(userBubbleStyle.borderBottomWidth),
        maxWidthRatio: ratioOf(userBubbleStyle.maxWidth),
        clampLines: Number.isFinite(clampLines) && clampLines > 0 ? clampLines : 0,
      },
      epoch: "",
    };
    metrics.epoch = [
      columnWidthPx,
      metrics.partGapPx,
      metrics.actionsHeightPx,
      assistantTypography.epoch,
      metrics.assistant.itemPadXPx,
      metrics.assistant.bubblePadXPx,
      metrics.assistant.bubblePadYPx,
      metrics.assistant.maxWidthRatio,
      metrics.assistant.paragraphGapPx,
      userTypography.epoch,
      metrics.user.bubblePadXPx,
      metrics.user.bubblePadYPx,
      metrics.user.maxWidthRatio,
      metrics.user.clampLines,
    ].join("/");
    return metrics;
  } finally {
    probe.remove();
  }
}

const assistantRowIsTextOnly = (row: EventRowViewModel): boolean =>
  row.kind === "assistant" &&
  !row.officePreviewRef &&
  !row.resourcePayload &&
  !row.voiceSession &&
  !row.backgroundWork &&
  !row.customSlot &&
  !row.agentCompletion &&
  (row.inlineImagePayloads?.length ?? 0) === 0 &&
  (row.webSearchResults?.length ?? 0) === 0 &&
  (row.mapArtifacts?.length ?? 0) === 0 &&
  (row.sourceDiffPayloads?.length ?? 0) === 0;

const userRowIsTextOnly = (row: EventRowViewModel): boolean =>
  row.kind === "user" &&
  (row.attachments?.length ?? 0) === 0 &&
  !row.quotedText &&
  !row.channelEnvelope &&
  !row.windowLabel &&
  !row.activityLabel &&
  (row.appSelectionLabels?.length ?? 0) === 0 &&
  (row.pastedTexts?.length ?? 0) === 0 &&
  !row.text.includes("@");

export function getFixedRowHeight(
  row: EventRowViewModel,
  metrics: TranscriptRowMetrics,
): number | undefined {
  if (row.kind === "assistant") {
    if (!assistantRowIsTextOnly(row)) return undefined;
    const text = row.text;
    if (text.trim().length === 0) return undefined;
    const containerWidth = metrics.columnWidthPx - metrics.assistant.itemPadXPx;
    const contentWidth =
      containerWidth * metrics.assistant.maxWidthRatio -
      metrics.assistant.bubblePadXPx;
    const textHeight = measurePlainTextHeight(
      text,
      metrics.assistant.typography,
      contentWidth,
      metrics.assistant.paragraphGapPx,
    );
    if (textHeight === undefined) return undefined;
    let height = textHeight + metrics.assistant.bubblePadYPx;

    if (!row.isIntraTurn) {
      height += metrics.partGapPx + metrics.actionsHeightPx;
    }
    return Math.ceil(height);
  }

  if (!userRowIsTextOnly(row)) return undefined;
  const text = row.text;
  if (text.trim().length === 0) return undefined;
  const contentWidth =
    metrics.columnWidthPx * metrics.user.maxWidthRatio -
    metrics.user.bubblePadXPx;
  const textHeight = measurePreWrapTextHeight(
    text,
    metrics.user.typography,
    contentWidth,
  );
  if (textHeight === undefined) return undefined;

  const lineHeight = metrics.user.typography.lineHeightPx;
  if (metrics.user.clampLines > 0 && lineHeight > 0) {
    const lines = Math.round(textHeight / lineHeight);
    if (lines > metrics.user.clampLines) return undefined;
  }
  return Math.ceil(
    textHeight +
      metrics.user.bubblePadYPx +
      metrics.partGapPx +
      metrics.actionsHeightPx,
  );
}
