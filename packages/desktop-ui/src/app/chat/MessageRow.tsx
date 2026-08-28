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

const isImageAttachment = (attachment: Attachment, safeUrl: string): boolean => {
  if (attachment.kind === "file") return false;
  const mimeType = attachment.mimeType?.trim().toLowerCase();
  if (mimeType) return mimeType.startsWith("image/");
  if (safeUrl.startsWith("data:")) {
    return /^data:image\//i.test(safeUrl);
  }

  if (attachment.name && /\.[a-z0-9]+$/i.test(attachment.name)) {
    return IMAGE_FILE_EXT_RE.test(attachment.name);
  }
  return true;
};

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

const BUBBLE_MAX_FRACTION = 0.85;
const CHIP_GAP = 6;

function UserContextChips({ chips }: { chips: ContextChip[] }) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);

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
          <div className="event-item user chat-bubble-text">
            <UserMessageBody text={text} />
          </div>
        )}
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

    if (!assistantRowHasVisibleContent(row)) {
      return null;
    }

    return (
      <div
        className={`event-row event-row--assistant${row.justArrived ? " event-row--assistant--just-arrived" : ""}`}
        data-chat-row-id={row.id}
        data-scroll-follow-key={row.id}
        data-react-key={row.id}
      >
        <div className="event-item assistant">
          {hasVoiceSession && row.voiceSession && (
            <VoiceSessionCard durationMs={row.voiceSession.durationMs} />
          )}
          {hasText && (
            <div className="assistant-message-text chat-bubble-text">
              <Markdown
                text={text}
                cacheKey={row.cacheKey}
                hideHorizontalRules
              />
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
          {row.customSlot ? row.customSlot : null}
          {hasText && !row.isIntraTurn && (
            <MessageActions
              text={text}
              messageKey={row.id}
              showReadAloud
              align="start"
              timestampMs={row.timestampMs}
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
