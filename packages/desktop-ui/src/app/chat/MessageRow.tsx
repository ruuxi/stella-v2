/**
 * Linear chat row components.
 *
 * Each message renders as a single row in chronological order, with no
 * per-turn user/assistant grouping. Tool-derived artifacts (web-search
 * badge, office preview, end-resource pill, self-mod undo) attach to
 * the assistant row that immediately followed the producing tool events.
 *
 * Streaming is NOT a separate row: live stream chunks update an
 * in-memory `MessageRecord` overlay that `useConversationDisplayMessages`
 * merges into the displayed list under a stable
 * `assistant-{userMessageId}-{indexInTurn}` key. When the persisted
 * `assistant_message` lands, the overlay remains the visible text
 * source while borrowing persisted metadata/tool events; when the
 * overlay later clears, the persisted row reuses the same React key.
 * The only marker that the row is currently receiving chunks is
 * `isStreaming` below (styling). Scroll follow is driven by runtime
 * `assistantScrollFollowKey` signals and `data-scroll-follow-key` on
 * the row.
 *
 * Reasoning text is intentionally NOT rendered anywhere in this surface
 * (the underlying data still flows through state for model history).
 */
import {
  Fragment,
  memo,
  useCallback,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  describePastedText,
  pastedTextPreview,
  type PastedTextDescriptor,
} from "@/features/chat/lib/paste-context";
import { ChipPreviewPortal } from "@/app/chat/ChipPreviewPortal";
import { useHoverPreview } from "@/app/chat/use-hover-preview";
import type {
  Attachment,
  ChannelEnvelope,
} from "@/features/chat/lib/event-transforms";
import { Markdown } from "@/app/chat/Markdown";
import { StreamingTextReveal } from "@/app/chat/StreamingTextReveal";
import {
  EndResourceCard,
  SourceDiffEndResource,
} from "@/app/chat/EndResourceCard";
import { InlineGeneratedImageStrip } from "@/app/chat/InlineGeneratedImageCard";
import { WebSearchResultsStrip } from "@/app/chat/WebSearchResultsStrip";
import { MapRouteCards } from "@/app/chat/MapRouteCard";
import type { DisplayPayload } from "@stella/contracts/desktop/display-payload";
import { OfficePreviewCard } from "@/app/chat/OfficePreviewCard";
import { BackgroundWorkCard } from "@/app/chat/BackgroundWorkCard";
import { AgentCompletionCard } from "@/app/chat/AgentCompletionCard";
import { VoiceSessionCard } from "@/app/chat/VoiceSessionCard";
import { sanitizeAttachmentImageUrl } from "@/shared/lib/url-safety";
import { UserMessageBody } from "@/app/chat/UserMessageBody";
import { MessageActions } from "@/app/chat/MessageActions";
import { useUserMessageActions, useUserMessageActionsBusy, } from "@/app/chat/user-message-actions-context";
import { primaryCopyAttachment } from "@/app/chat/message-composer-restore";
import {
  ContextPill,
  FileAttachmentChip,
  ImageAttachmentChip,
  fileAttachmentTypeLabelKey,
} from "@/app/chat/ComposerContextChips";
import { useT } from "@/shared/i18n";
import { eventRowEqual } from "@/features/chat/lib/row-equality";
import { assistantRowHasVisibleContent } from "@/features/chat/lib/assistant-row-content";
import type {
  AssistantRowViewModel,
  UserRowViewModel,
} from "@/features/chat/conversation-row-types";
import type { AgentModelConfigsByThread } from "@/features/chat/hooks/use-agent-model-configs";
import { loadLocalMessageToolEventPage } from "@/features/chat/services/local-message-timeline-store";

type Translate = ReturnType<typeof useT>;

const getAttachmentLabel = (
  attachment: Attachment,
  index: number,
  t: Translate,
) => {
  if (attachment.name) return attachment.name;
  if (attachment.kind) {
    const normalized = attachment.kind.replace(/[_-]+/g, " ").trim();
    if (normalized.length > 0) {
      return normalized[0].toUpperCase() + normalized.slice(1);
    }
  }
  if (attachment.mimeType) return attachment.mimeType;
  return t("app.chat.messageRow.attachmentFallback", { index: index + 1 });
};

const IMAGE_FILE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico|tiff?|heic|heif)$/i;

/**
 * Whether a sent attachment should render as an image thumbnail. Routing
 * mistakes here previously fed PDFs into an `<img>`, producing a broken
 * image plus clipped alt text.
 */
const isImageAttachment = (attachment: Attachment, safeUrl: string): boolean => {
  if (attachment.kind === "file") return false;
  const mimeType = attachment.mimeType?.trim().toLowerCase();
  if (mimeType) return mimeType.startsWith("image/");
  if (safeUrl.startsWith("data:")) {
    return /^data:image\//i.test(safeUrl);
  }
  // Legacy remote payloads often lack a mimeType; keep the historical
  // image treatment unless the filename clearly says otherwise.
  if (attachment.name && /\.[a-z0-9]+$/i.test(attachment.name)) {
    return IMAGE_FILE_EXT_RE.test(attachment.name);
  }
  return true;
};

/** Display name for a sent non-image attachment chip. */
const getFileAttachmentName = (
  attachment: Attachment,
  t: Translate,
): string => {
  if (attachment.name) return attachment.name;
  if (attachment.kind && attachment.kind !== "file") {
    const normalized = attachment.kind.replace(/[_-]+/g, " ").trim();
    if (normalized.length > 0) {
      return normalized[0].toUpperCase() + normalized.slice(1);
    }
  }
  return t(fileAttachmentTypeLabelKey(attachment.mimeType));
};

const formatChannelKind = (kind: ChannelEnvelope["kind"], t: Translate) => {
  if (kind === "message") return t("app.chat.messageRow.channelKind.message");
  if (kind === "reaction") return t("app.chat.messageRow.channelKind.reaction");
  if (kind === "edit") return t("app.chat.messageRow.channelKind.edited");
  if (kind === "delete") return t("app.chat.messageRow.channelKind.deleted");
  return t("app.chat.messageRow.channelKind.system");
};

const formatProvider = (provider: string) =>
  provider
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");

const summarizeReactions = (
  envelope: ChannelEnvelope,
  t: Translate,
): string | null => {
  const reactions = envelope.reactions ?? [];
  if (reactions.length === 0) return null;
  const labels = reactions.slice(0, 3).map((reaction) => {
    const prefix = reaction.action === "remove" ? "-" : "+";
    return `${prefix}${reaction.emoji}`;
  });
  const suffix = reactions.length > 3 ? ` +${reactions.length - 3}` : "";
  return t("app.chat.messageRow.reactionsSummary", {
    reactions: `${labels.join(" ")}${suffix}`,
  });
};

/**
 * Window context chip inside the user bubble. The screenshot preview is
 * portaled to `document.body` (via `ChipPreviewPortal`) so it escapes the
 * scrolling chat container's clip rect — a plain absolutely-positioned
 * popover gets cropped to the message bubble / scroll viewport.
 */
function UserWindowContextChip({
  label,
  previewImageUrl,
}: {
  label: string;
  previewImageUrl?: string;
}) {
  const t = useT();
  const { triggerRef, open } = useHoverPreview<HTMLSpanElement>();
  return (
    <span className="event-window-badge-hovercard">
      <ContextPill
        kind="window"
        pillRef={triggerRef}
        label={label}
        data-has-preview={previewImageUrl ? "true" : undefined}
        tabIndex={previewImageUrl ? 0 : undefined}
      />
      {previewImageUrl && (
        <ChipPreviewPortal
          triggerRef={triggerRef}
          open={open}
          preferredPlacement="top"
          className="event-window-preview-card"
        >
          <img
            src={previewImageUrl}
            alt={t("app.chat.messageRow.windowPreviewAlt")}
            className="event-window-preview-img"
          />
        </ChipPreviewPortal>
      )}
    </span>
  );
}

/**
 * Pasted-text chip inside the user bubble. Mirrors the composer's
 * `PastedTextChip`: hovering (or focusing) reveals the pasted content in a
 * scrollable portaled card so the user can read what they attached. The
 * body comes from the bounded preview persisted on the message metadata.
 */
function UserPastedTextChip({
  descriptor,
}: {
  descriptor: PastedTextDescriptor;
}) {
  const t = useT();
  const { triggerRef, open, previewProps } = useHoverPreview<HTMLSpanElement>();
  const stats = describePastedText(descriptor);
  const preview = pastedTextPreview(descriptor);
  return (
    <span className="event-window-badge-hovercard">
      <ContextPill
        kind="pasted-text"
        pillRef={triggerRef}
        label={t("app.chat.messageRow.pastedTextLabel")}
        data-has-preview={preview ? "true" : undefined}
        tabIndex={preview ? 0 : undefined}
        title={t("app.chat.messageRow.pastedTextTitle", { stats })}
      />
      {preview && (
        <ChipPreviewPortal
          triggerRef={triggerRef}
          open={open}
          preferredPlacement="top"
          className="event-pasted-text-preview-card"
          {...previewProps}
        >
          <div className="event-pasted-text-preview-body">{preview}</div>
        </ChipPreviewPortal>
      )}
    </span>
  );
}

/**
 * Quoted / "Ask Stella" context chip inside the user bubble. Mirrors the
 * composer's selected-text chip: the quoted content is delivered to the model
 * as a dedicated hidden context message, never folded into the visible body,
 * so this chip is the display side of that decoupling. Hovering (or focusing)
 * reveals the quoted text in a scrollable portaled card.
 */
function UserQuotedTextChip({ quotedText }: { quotedText: string }) {
  const t = useT();
  const { triggerRef, open, previewProps } = useHoverPreview<HTMLSpanElement>();
  const preview = quotedText.trim();
  return (
    <span className="event-window-badge-hovercard">
      <ContextPill
        kind="selected-text"
        pillRef={triggerRef}
        label={t("app.chat.messageRow.quotedTextLabel")}
        data-has-preview={preview ? "true" : undefined}
        tabIndex={preview ? 0 : undefined}
        title={t("app.chat.messageRow.quotedTextLabel")}
      />
      {preview && (
        <ChipPreviewPortal
          triggerRef={triggerRef}
          open={open}
          preferredPlacement="top"
          className="event-pasted-text-preview-card"
          {...previewProps}
        >
          <div className="event-pasted-text-preview-body">{preview}</div>
        </ChipPreviewPortal>
      )}
    </span>
  );
}


type ContextChip = { key: string; node: ReactNode };

// The chips sit above the bubble and are capped to the same 85% of the
// message-row column that the bubble uses (`.event-item.user max-width: 85%`),
// so the overflow math matches what the user sees. `CHIP_GAP` mirrors the
// chip row's `gap: 6px`.
const BUBBLE_MAX_FRACTION = 0.85;
const CHIP_GAP = 6;

/**
 * Lays out the user-bubble context chips on a single line. When they would
 * overflow the bubble's max width, the trailing chips collapse into a
 * "+N" pill; hovering / focusing it reveals the rest in a portaled popover
 * (portaled so it escapes the scrolling chat container's clip rect).
 */
function UserContextChips({ chips }: { chips: ContextChip[] }) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  // The "+N" trigger mounts only after the measurement pass collapses chips,
  // so its hover listeners must be plain React props (a mount-time ref hook
  // would bind to a null element and never fire).
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(chips.length);
  const signature = chips.map((chip) => chip.key).join("|");

  useLayoutEffect(() => {
    const root = rootRef.current;
    const measure = measureRef.current;
    if (!root || !measure) return;
    const column = root.closest(".event-row") as HTMLElement | null;

    const compute = () => {
      const columnWidth = column?.clientWidth ?? root.clientWidth;
      const available = columnWidth * BUBBLE_MAX_FRACTION;
      const items = Array.from(measure.children) as HTMLElement[];
      if (items.length === 0) return;
      // Last measure child is the "+N" template; the rest map to `chips`.
      const overflowEl = items[items.length - 1];
      const chipEls = items.slice(0, items.length - 1);
      if (chipEls.length <= 1) {
        setVisibleCount(chipEls.length);
        return;
      }

      let total = 0;
      chipEls.forEach((el, index) => {
        total += el.offsetWidth + (index > 0 ? CHIP_GAP : 0);
      });
      if (total <= available) {
        setVisibleCount(chipEls.length);
        return;
      }

      const reserve = overflowEl.offsetWidth + CHIP_GAP;
      let used = 0;
      let count = 0;
      for (let index = 0; index < chipEls.length; index += 1) {
        const width = chipEls[index].offsetWidth + (index > 0 ? CHIP_GAP : 0);
        if (used + width + reserve <= available) {
          used += width;
          count += 1;
        } else {
          break;
        }
      }
      setVisibleCount(Math.max(1, count));
    };

    compute();
    const observer = new ResizeObserver(compute);
    if (column) observer.observe(column);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [signature]);

  const visible = chips.slice(0, visibleCount);
  const hidden = chips.slice(visibleCount);

  return (
    <div className="event-context-chips" ref={rootRef}>
      <div
        className="event-context-chips__measure"
        ref={measureRef}
        aria-hidden
      >
        {chips.map((chip) => (
          <Fragment key={chip.key}>{chip.node}</Fragment>
        ))}
        <span className="event-context-chip event-context-chip--overflow">
          +9
        </span>
      </div>
      {visible.map((chip) => (
        <Fragment key={chip.key}>{chip.node}</Fragment>
      ))}
      {hidden.length > 0 && (
        <>
          <button
            type="button"
            ref={triggerRef}
            className="event-context-chip event-context-chip--overflow"
            aria-label={t("app.chat.messageRow.showMoreChips", {
              count: hidden.length,
            })}
            onMouseEnter={() => setOverflowOpen(true)}
            onMouseLeave={() => setOverflowOpen(false)}
            onFocus={() => setOverflowOpen(true)}
            onBlur={() => setOverflowOpen(false)}
          >
            +{hidden.length}
          </button>
          <ChipPreviewPortal
            triggerRef={triggerRef}
            open={overflowOpen}
            preferredPlacement="top"
            className="event-context-overflow-card"
          >
            {hidden.map((chip) => (
              <Fragment key={chip.key}>{chip.node}</Fragment>
            ))}
          </ChipPreviewPortal>
        </>
      )}
    </div>
  );
}

/**
 * A user-attached image inside the sent message. Presentation reuses the
 * composer's compact, uniform image chip while retaining the shared
 * full-window lightbox.
 */
function AttachmentImage({
  attachment,
  index,
  safeUrl,
}: {
  attachment: Attachment;
  index: number;
  safeUrl: string;
}) {
  const t = useT();
  const label = getAttachmentLabel(attachment, index, t);
  return (
    <ImageAttachmentChip
      thumbnailUrl={safeUrl}
      fullImageUrl={safeUrl}
      alt={attachment.name ?? t("app.chat.messageRow.attachmentAlt")}
      title={t("app.chat.messageRow.clickToEnlarge", { label })}
    />
  );
}

type UserRowProps = {
  row: UserRowViewModel;
};

export const UserMessageRow = memo(
  function UserMessageRow({ row }: UserRowProps) {
    const t = useT();
    const messageActions = useUserMessageActions();
    const actionsBusy = useUserMessageActionsBusy();
    const forkAction = messageActions?.fork;
    const handleRewind = useCallback(
      () => messageActions?.rewind(row),
      [messageActions, row],
    );
    const handleFork = useCallback(
      () => forkAction?.(row),
      [forkAction, row],
    );
    const { text, windowLabel, attachments, channelEnvelope } = row;
    // Attachment the Copy action falls back to when the message has no text
    // (image → clipboard image; other file → path as text). Memoized so the
    // memoized action row isn't re-rendered by busy-state toggles.
    const copyAttachment = useMemo(
      () => primaryCopyAttachment(attachments),
      [attachments],
    );
    const appSelectionLabels = (row.appSelectionLabels ?? [])
      .map((label) => label.trim())
      .filter((label) => label.length > 0);
    const activityLabel = row.activityLabel?.trim();
    const pastedTexts = row.pastedTexts ?? [];
    const windowPreviewImageUrl = sanitizeAttachmentImageUrl(
      row.windowPreviewImageUrl,
    );
    const reactionSummary = channelEnvelope
      ? summarizeReactions(channelEnvelope, t)
      : null;

    const chips: ContextChip[] = [];
    if (windowLabel) {
      chips.push({
        key: "window",
        node: (
          <UserWindowContextChip
            label={windowLabel}
            previewImageUrl={windowPreviewImageUrl ?? undefined}
          />
        ),
      });
    }
    appSelectionLabels.forEach((label, index) => {
      chips.push({
        key: `app-selection-${index}`,
        node: <ContextPill kind="app-selection" label={label} />,
      });
    });
    if (activityLabel) {
      chips.push({
        key: "activity",
        node: <ContextPill kind="activity" label={activityLabel} />,
      });
    }
    pastedTexts.forEach((descriptor, index) => {
      chips.push({
        key: `pasted-text-${index}`,
        node: <UserPastedTextChip descriptor={descriptor} />,
      });
    });
    if (row.quotedText?.trim()) {
      chips.push({
        key: "quoted-text",
        node: <UserQuotedTextChip quotedText={row.quotedText} />,
      });
    }
    if (channelEnvelope?.provider) {
      chips.push({
        key: "channel-provider",
        node: (
          <span className="event-channel-badge provider">
            {formatProvider(channelEnvelope.provider)}
          </span>
        ),
      });
    }
    if (channelEnvelope && channelEnvelope.kind !== "message") {
      chips.push({
        key: "channel-kind",
        node: (
          <span className="event-channel-badge kind">
            {formatChannelKind(channelEnvelope.kind, t)}
          </span>
        ),
      });
    }
    if (channelEnvelope && reactionSummary) {
      chips.push({
        key: "channel-reaction",
        node: (
          <span className="event-channel-badge reaction">
            {reactionSummary}
          </span>
        ),
      });
    }
    attachments.forEach((attachment, index) => {
      const safeUrl = sanitizeAttachmentImageUrl(attachment.url);
      const key = attachment.id ?? `attachment-${index}`;
      if (safeUrl && isImageAttachment(attachment, safeUrl)) {
        chips.push({
          key,
          node: (
            <AttachmentImage
              attachment={attachment}
              index={index}
              safeUrl={safeUrl}
            />
          ),
        });
        return;
      }
      // Non-image attachments (pdf, docs, audio, …) reuse the composer's
      // document chip: file-type glyph + real filename, opening the
      // original on disk when a source path was captured at attach time.
      chips.push({
        key,
        node: (
          <FileAttachmentChip
            name={getFileAttachmentName(attachment, t)}
            size={attachment.size}
            mimeType={attachment.mimeType}
            path={attachment.path}
          />
        ),
      });
    });

    return (
      <div
        className={`event-row event-row--user${row.justSent ? " event-row--user--just-sent" : ""}`}
        data-chat-row-id={row.id}
      >
        {chips.length > 0 && <UserContextChips chips={chips} />}
        {text.trim() && (
          <div className="event-item user">
            <UserMessageBody text={text} />
          </div>
        )}
        {/* The action row (Copy + Rewind + Fork) mounts for any user
            message that has visible content — text OR attachment/context
            chips — so attachment-only messages get the same actions. Copy
            no-ops gracefully when there is no text to copy; Rewind/Fork use
            the attachment-restore path to bring the attachments back. */}
        {(text.trim() || chips.length > 0) && (
          <MessageActions
            text={text}
            messageKey={row.id}
            align="end"
            timestampMs={row.timestampMs}
            onRewind={messageActions ? handleRewind : undefined}
            onFork={forkAction ? handleFork : undefined}
            actionsDisabled={actionsBusy}
            copyAttachment={copyAttachment ?? undefined}
          />
        )}
      </div>
    );
  },
  (prev, next) => eventRowEqual(prev.row, next.row),
);

type AssistantRowProps = {
  row: AssistantRowViewModel;
  conversationId?: string | null;
  agentModelConfigByThread?: AgentModelConfigsByThread;
};

export const AssistantMessageRow = memo(
  function AssistantMessageRow({
    row,
    conversationId,
    agentModelConfigByThread,
  }: AssistantRowProps) {
    const t = useT();
    const [detailLoadState, setDetailLoadState] = useState<
      "idle" | "loading" | "error"
    >("idle");
    const text = row.text;
    const hasText = text.trim().length > 0;
    const hasWebSearchResults = (row.webSearchResults?.length ?? 0) > 0;
    const hasMapArtifacts = (row.mapArtifacts?.length ?? 0) > 0;
    const hasVoiceSession = Boolean(row.voiceSession);
    const hasBackgroundWork = Boolean(
      row.backgroundWork && row.backgroundWork.threadIds.length > 0,
    );
    const hasAgentCompletion = Boolean(
      row.agentCompletion && row.agentCompletion.sections.length > 0,
    );
    // Shared predicate with ChatTimeline (which drops renderless rows
    // before virtualization) — see assistant-row-content.ts.
    if (!assistantRowHasVisibleContent(row)) {
      // Reserve a scroll-follow target before the first token lands;
      // otherwise `followActiveAssistantRow` can't find
      // `[data-scroll-follow-key]` and auto-follow waits on ResizeObserver
      // luck.
      if (row.isStreaming) {
        return (
          <div
            className="event-row event-row--assistant event-row--streaming"
            data-chat-row-id={row.id}
            data-scroll-follow-key={row.id}
            aria-hidden
          >
            <div className="event-item assistant event-item--streaming-placeholder" />
          </div>
        );
      }
      return null;
    }

    return (
      <div
        className={`event-row event-row--assistant${row.isStreaming ? " event-row--streaming" : ""}`}
        data-chat-row-id={row.id}
        data-scroll-follow-key={row.id}
        data-react-key={row.id}
      >
        <div className="event-item assistant">
          {hasVoiceSession && row.voiceSession && (
            <VoiceSessionCard durationMs={row.voiceSession.durationMs} />
          )}
          {hasText && (
            <div
              className={`assistant-message-text${row.isFadingOut ? " assistant-message-text--fading" : ""}`}
            >
              <StreamingTextReveal active={Boolean(row.isStreaming)}>
                <Markdown
                  text={text}
                  cacheKey={row.cacheKey}
                  mode={row.isStreaming ? "streaming" : "static"}
                  animateStreamingWords={Boolean(
                    row.isStreaming && !row.isFadingOut,
                  )}
                  hideHorizontalRules
                />
              </StreamingTextReveal>
            </div>
          )}
          {hasBackgroundWork && row.backgroundWork ? (
            <BackgroundWorkCard
              threadIds={row.backgroundWork.threadIds}
              completedThreadIds={row.backgroundWork.completedThreadIds}
              pausedThreadIds={row.backgroundWork.pausedThreadIds}
              failedThreadIds={row.backgroundWork.failedThreadIds}
              supersededThreadIds={row.backgroundWork.supersededThreadIds}
              spawnedAtMs={row.backgroundWork.spawnedAtMs}
              descriptions={row.backgroundWork.descriptions}
              statusTexts={row.backgroundWork.statusTexts}
              followUpThreadIds={row.backgroundWork.followUpThreadIds}
              cardId={row.backgroundWork.cardId}
              startEventIdsByThread={row.backgroundWork.startEventIdsByThread}
              attemptGenerationsByThread={
                row.backgroundWork.attemptGenerationsByThread
              }
              rootRunIdsByThread={row.backgroundWork.rootRunIdsByThread}
              terminalEventIdsByThread={
                row.backgroundWork.terminalEventIdsByThread
              }
              conversationId={conversationId ?? ""}
            />
          ) : null}
          {hasAgentCompletion && row.agentCompletion && (
            <AgentCompletionCard
              sections={row.agentCompletion.sections}
              conversationId={conversationId ?? ""}
              modelConfigByThread={agentModelConfigByThread}
            />
          )}
          {hasWebSearchResults && row.webSearchResults && (
            <WebSearchResultsStrip results={row.webSearchResults} />
          )}
          {hasMapArtifacts && row.mapArtifacts && (
            <MapRouteCards cards={row.mapArtifacts} />
          )}
          {row.officePreviewRef && (
            <OfficePreviewCard previewRef={row.officePreviewRef} />
          )}
          {row.inlineImagePayloads && row.inlineImagePayloads.length > 0 ? (
            <InlineGeneratedImageStrip
              conversationId={conversationId}
              payloads={row.inlineImagePayloads.filter(
                (
                  payload,
                ): payload is Extract<DisplayPayload, { kind: "media" }> =>
                  payload.kind === "media" &&
                  payload.presentation === "inline-image" &&
                  payload.asset.kind === "image",
              )}
            />
          ) : null}
          {row.sourceDiffPayloads && row.sourceDiffPayloads.length > 0 ? (
            <SourceDiffEndResource
              batchId={row.id}
              payloads={row.sourceDiffPayloads}
            />
          ) : row.resourcePayload ? (
            <EndResourceCard payload={row.resourcePayload} />
          ) : null}
          {row.toolEventSummary?.truncated && row.sourceMessageId ? (
            <button
              type="button"
              className="turn-detail-load"
              disabled={detailLoadState === "loading" || !conversationId}
              onClick={async () => {
                if (!conversationId || detailLoadState === "loading") return;
                setDetailLoadState("loading");
                try {
                  const loaded = await loadLocalMessageToolEventPage(
                    conversationId,
                    row.sourceMessageId!,
                  );
                  setDetailLoadState(loaded ? "idle" : "error");
                } catch {
                  setDetailLoadState("error");
                }
              }}
            >
              {detailLoadState === "loading"
                ? t("common.loading")
                : detailLoadState === "error"
                  ? t("common.tryAgain")
                  : `${t("app.chat.userMessage.showMore")} (${row.toolEventSummary.loadedCount}/${row.toolEventSummary.totalCount}${row.toolEventSummary.totalCountIsLowerBound ? "+" : ""})`}
            </button>
          ) : null}
          {row.customSlot ? row.customSlot : null}
          {hasText && !row.isIntraTurn && (
            // Only a turn's final assistant message carries the action strip.
            // Mid-turn preambles render no strip or reserved action height.
            <MessageActions
              text={text}
              messageKey={row.id}
              showReadAloud
              align="start"
              timestampMs={row.timestampMs}
              streaming={Boolean(row.isStreaming)}
            />
          )}
        </div>
      </div>
    );
  },
  (prev, next) =>
    prev.conversationId === next.conversationId &&
    prev.agentModelConfigByThread === next.agentModelConfigByThread &&
    eventRowEqual(prev.row, next.row),
);
