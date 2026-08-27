/**
 * Exact virtualized row heights for plain-text chat bubbles.
 *
 * `ChatTimeline` hands LegendList a `getFixedItemSize`; for a row whose body
 * is nothing but plain text (no markdown constructs, no chips, attachments,
 * cards or artifacts) this module returns the row's precise pixel height so
 * the list never has to guess and correct. Every other row returns
 * `undefined` and keeps today's measure-after-mount behavior.
 *
 * The arithmetic is deliberately conservative: it is built from geometry read
 * off a real probe element (so it tracks theme, zoom and per-surface CSS
 * rather than hard-coded numbers), and anything it cannot account for exactly
 * bails out. Under-measuring is far worse than falling back, so when in doubt
 * this returns `undefined`.
 */
import type { EventRowViewModel } from "@/features/chat/conversation-row-types";
import {
  measurePlainTextHeight,
  measurePreWrapTextHeight,
  readTranscriptTypography,
  type TranscriptTypography,
} from "./measure";

/**
 * Every piece of row chrome the height arithmetic needs, read once from a
 * probe rendered inside the live transcript.
 */
export interface TranscriptRowMetrics {
  /** Inner width of one virtualized row (`.event-row` is `width: 100%`). */
  columnWidthPx: number;
  /** Gap between a row's parts (bubble → cards → action strip). */
  partGapPx: number;
  /** In-flow height of the hover action strip. */
  actionsHeightPx: number;

  assistant: {
    typography: TranscriptTypography;
    /** Horizontal padding on `.event-item.assistant` (the bubble's container). */
    itemPadXPx: number;
    /** Bubble padding + border, split by axis. */
    bubblePadXPx: number;
    bubblePadYPx: number;
    /** `max-width` of the bubble as a fraction of its container. */
    maxWidthRatio: number;
    /** `margin-bottom` between two markdown paragraphs. */
    paragraphGapPx: number;
  };

  user: {
    typography: TranscriptTypography;
    bubblePadXPx: number;
    bubblePadYPx: number;
    maxWidthRatio: number;
    /** `-webkit-line-clamp` on a collapsed user bubble. */
    clampLines: number;
  };

  /** Invalidation key: changes whenever any input above changes. */
  epoch: string;
}

const PROBE_TEXT = "Mg";

const px = (value: string): number => Number.parseFloat(value) || 0;

const ratioOf = (maxWidth: string): number => {
  const parsed = Number.parseFloat(maxWidth);
  if (!Number.isFinite(parsed)) return 1;
  return maxWidth.trim().endsWith("%") ? parsed / 100 : 1;
};

/**
 * Builds a hidden probe with the transcript's real class chain inside
 * `host`, reads its computed geometry, and tears it down. `host` must be
 * inside the surface that owns the `--chat-*` tokens (the LegendList scroll
 * node is), so per-surface overrides (sidebar, orb, agent thread) are picked
 * up for free.
 *
 * `columnWidthPx` is NOT taken from the probe — the probe is positioned out
 * of flow, so the caller supplies the width of a real laid-out row.
 */
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

/**
 * An assistant row qualifies only when its whole body is the text bubble.
 * Any card, artifact, receipt or voice summary adds height this module does
 * not model.
 */
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

/**
 * A user row qualifies only when it is a bare text bubble: no context chips,
 * no attachments, no quoted text, no channel envelope — and no `@` mention,
 * which `ModelMentionText` renders as an inline pill of its own metrics.
 */
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

/**
 * Exact height of one timeline row, or `undefined` to fall back to
 * measure-after-mount. Rounded UP to a whole pixel: a fractional
 * under-estimate is what produces overlap/clipping, so the arithmetic always
 * errs on the generous side by at most 1px.
 */
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
    // Only a turn's FINAL assistant message carries the action strip; a
    // mid-turn preamble reserves no height for it (see `AssistantMessageRow`).
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
  // A long user message clamps to N lines and grows a "Show more" toggle
  // whose height is not modeled here — bail rather than under-measure.
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
