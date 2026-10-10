import {
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  LayoutChangeEvent,
  NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  type TextLayoutEventData,
  useWindowDimensions,
  View,
} from "react-native";
import { Image } from "expo-image";
import { extractPlainText } from "react-native-nitro-markdown";
import type { ReplyRef } from "@stella/contracts/reply-refs";
import { cloudWorldDrivePath } from "@stella/contracts/cloud-world-paths";
import { extractStellaAppLinkSlugs } from "@stella/contracts/workspace-apps";
import {
  extractLocalFileLinkPaths,
  unlinkLocalFileLinks,
} from "@stella/contracts/local-file-links";
import { AssistantBubble, SENT_BUBBLE_POP, useBubblePop } from "../BubblePop";
import { type AgentReplyRef } from "../ReplyFocus";
import {
  ReplyPreview,
  replyTitle,
  type ReplyAgentStatus,
} from "../ReplyPreview";
import { ReplyFilePills } from "../ReplyFilePills";
import { Icon } from "../Icon";
import { AssistantMarkdown } from "../AssistantMarkdown";
import { AssistantTextSelection } from "../AssistantTextSelection";
import { MESSAGE_PRESS_SCALE } from "../MessageContextMenu";
import { MessageEvidenceStrip } from "../evidence/MessageEvidenceStrip";
import { AppPreviewCard } from "../AppPreviewCard";
import { MapRouteCard } from "../MapRouteCard";
import type { AnchorRect } from "./PlusMenu";
import { assistantBubbleNeedsBoundedWidth } from "../../lib/assistant-bubble-layout";
import { artifactPrimaryFilePath } from "../../lib/mobile-artifacts";
import {
  resolveCloudDriveFileUri,
  useCloudDriveFileUri,
} from "../../lib/use-cloud-drive-file-uri";
import { scheduleReceiptText } from "../../lib/schedule-receipt-summary";
import { isStandInArtifactRow } from "../../lib/message-row-identity";
import {
  inlineAgentWorkCardSections,
  consolidateRowArtifacts,
} from "../../lib/agent-artifact-consolidation";
import type { StoredPhoneAccess } from "../../lib/phone-access";
import {
  bytesToDataUri,
  readLinkedArtifactFile,
} from "../../lib/desktop-artifact-data";
import { isDeviceOfflineError } from "../../lib/device-requests";
import { tapMedium } from "../../lib/haptics";
import { CONTENT_MAX_FONT_SCALE } from "../../lib/setup-text-defaults";
import {
  isUserMessageTruncatable,
  shouldRemeasureUserMessageWidth,
  userMessageNumberOfLines,
} from "../../lib/user-message-clamp";
import { type Colors } from "../../theme/colors";
import { fadeHex } from "../../theme/oklch";
import { fonts } from "../../theme/fonts";
import type { ChatArtifact, ChatMessage } from "../../types";

export type MessageRowStyles = ReturnType<typeof makeMessageRowStyles>;

/**
 * The row's callbacks, grouped so the list, the focused reply chain and the
 * long-press menu's lifted copy can share one memoized object instead of
 * threading each handler separately.
 */
export type MessageRowActions = {
  onOpenArtifact?: (
    artifact: ChatArtifact,
    gallery?: readonly ChatArtifact[],
  ) => void;
  /** Opens a tapped `stella://file/...` markdown link in the file viewer. */
  onOpenStellaFile?: (path: string, gallery?: readonly string[]) => void;
  onOpenMessageMenu: (request: MessageMenuRequest) => void;
  /** Leaves native text-selection mode for this row. */
  onEndSelecting: () => void;
  onAskStella: (text: string) => void;
  /** Opens the activity hub — the tap-through target for agent rows. */
  onOpenAgentActivity?: () => void;
  onOpenReply?: (ref: ReplyRef) => void;
  onOpenReport?: (ref: AgentReplyRef) => void;
};

const describePastedText = (pasted: {
  lines: number;
  chars: number;
}): string =>
  pasted.lines > 1
    ? `${pasted.lines.toLocaleString()} lines`
    : `${pasted.chars.toLocaleString()} chars`;

/**
 * How long a finger must rest on a message before its press shrink starts.
 * Longer than a tap and than the moment a drag turns into a list scroll.
 */
const MESSAGE_HOLD_MS = 180;
/** When the long-press menu opens; the shrink fills the time after the hold. */
const MESSAGE_LONG_PRESS_MS = 420;
/** `assistantRow`'s vertical padding, part of the visible gap between bubbles. */
export const ASSISTANT_ROW_PAD_VERTICAL = 2;

// ---------------------------------------------------------------------------
// Message wrapper — pops a just-sent message in, mirroring desktop `bubble-pop`.
// ---------------------------------------------------------------------------

export function MessageEntry({
  children,
  onLayout,
  animate,
}: {
  children: ReactNode;
  onLayout?: (event: LayoutChangeEvent) => void;
  animate: boolean;
}) {
  const animatedStyle = useBubblePop(animate, SENT_BUBBLE_POP);
  return (
    <Animated.View onLayout={onLayout} style={animatedStyle}>
      {children}
    </Animated.View>
  );
}

/** Anchor passed to the message-actions popover (the long-press point). */
export type MessageMenuRequest = { message: ChatMessage; anchor: AnchorRect };

/**
 * User message body with collapse/expand for long text — the mobile analogue
 * of desktop's `UserMessageBody`. Collapsed by default when the rendered text
 * exceeds `USER_MESSAGE_COLLAPSE_LINES`; a tappable "Show more" / "Show less"
 * toggle then reveals or re-hides the overflow.
 *
 * Overflow is detected from the native text-layout line boxes (not a
 * character count). The measuring pass renders at the collapse cap plus one
 * line — enough to distinguish "fits" from "overflows" without ever painting
 * a long message at full height (a full-height first paint used to inflate
 * the row after send and skew the post-send scroll anchor). Later width
 * changes remeasure so wrap at a new bubble width can grow or shrink the
 * toggle.
 */
function UserMessageText({
  text,
  styles,
}: {
  text: string;
  styles: MessageRowStyles;
}) {
  const { width: windowWidth } = useWindowDimensions();
  const [expanded, setExpanded] = useState(false);
  const [totalLines, setTotalLines] = useState<number | null>(null);
  const [measuring, setMeasuring] = useState(true);
  const measuredWidthRef = useRef<number | null>(null);

  // Reset when the underlying message text changes (row reuse across items).
  useEffect(() => {
    setExpanded(false);
    setTotalLines(null);
    setMeasuring(true);
    measuredWidthRef.current = null;
  }, [text]);

  // Remeasure from the viewport width, not the text box itself. User bubbles
  // are width:fit-content, so clamping the first four lines can shrink the
  // box and would otherwise oscillate if we keyed off the text layout width.
  useEffect(() => {
    if (
      shouldRemeasureUserMessageWidth(measuredWidthRef.current, windowWidth)
    ) {
      measuredWidthRef.current = windowWidth;
      setMeasuring(true);
      return;
    }
    if (measuredWidthRef.current === null) {
      measuredWidthRef.current = windowWidth;
    }
  }, [windowWidth]);

  const handleTextLayout = useCallback(
    (event: NativeSyntheticEvent<TextLayoutEventData>) => {
      const lines = event.nativeEvent.lines.length;
      if (measuring || totalLines === null) {
        setTotalLines(lines);
        setMeasuring(false);
      }
    },
    [measuring, totalLines],
  );

  const isTruncatable = isUserMessageTruncatable(totalLines);

  return (
    <>
      <Text
        style={styles.userText}
        maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        onTextLayout={handleTextLayout}
        numberOfLines={userMessageNumberOfLines({
          expanded,
          measuring,
          truncatable: isTruncatable,
        })}
      >
        {text}
      </Text>
      {isTruncatable ? (
        <Pressable
          onPress={() => setExpanded((prev) => !prev)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={
            expanded ? "Show less of this message" : "Show more of this message"
          }
        >
          {({ pressed }) => (
            <Text
              style={[styles.userToggle, pressed && styles.userTogglePressed]}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              {expanded ? "Show less" : "Show more"}
            </Text>
          )}
        </Pressable>
      ) : null}
    </>
  );
}

const generatedImageAspectRatio = (value: string | undefined): number => {
  const match = value
    ?.trim()
    .match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
  if (!match) return 4 / 3;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : 4 / 3;
};

const GeneratedImageTile = memo(function GeneratedImageTile({
  filePath,
  conversationId,
  access,
  driveBacked,
  aspectRatio,
  alt,
  generationState,
  colors,
}: {
  filePath?: string;
  conversationId: string;
  access?: StoredPhoneAccess;
  /** `filePath` is a cloud drive path; resolve it through the drive, not the computer. */
  driveBacked?: boolean;
  aspectRatio: number;
  alt: string;
  generationState?: "running" | "completed" | "failed" | "canceled";
  colors: Colors;
}) {
  const [computerUri, setComputerUri] = useState<string | null>(null);
  const [computerFailed, setComputerFailed] = useState(false);
  const [computerOffline, setComputerOffline] = useState(false);
  const drive = useCloudDriveFileUri(driveBacked && filePath ? filePath : null);
  const uri = driveBacked ? drive.uri : computerUri;
  const failed = driveBacked ? drive.failed : computerFailed;
  const offline = !driveBacked && computerOffline;
  useEffect(() => {
    let cancelled = false;
    const setUri = setComputerUri;
    const setFailed = setComputerFailed;
    setUri(null);
    setFailed(false);
    setComputerOffline(false);
    if (!filePath || driveBacked) return () => undefined;
    if (/^(?:file|https?|data):/i.test(filePath)) {
      setUri(filePath);
      return () => undefined;
    }
    const controller = new AbortController();
    void readLinkedArtifactFile(
      access ?? null,
      conversationId,
      filePath,
      controller.signal,
    )
      .then((result) => {
        if (cancelled) return;
        if (result.missing) {
          setFailed(true);
          return;
        }
        setUri(bytesToDataUri(result.bytes, result.mimeType));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setComputerOffline(isDeviceOfflineError(error));
        setFailed(true);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [access, conversationId, driveBacked, filePath]);

  return (
    <View
      accessibilityLabel={failed ? "Generated image failed to load" : alt}
      accessibilityRole="image"
      style={[
        generatedImageStyles.tile,
        { aspectRatio, backgroundColor: colors.surface },
      ]}
    >
      {uri ? (
        <Image
          source={{ uri }}
          style={generatedImageStyles.image}
          contentFit="cover"
        />
      ) : (
        <View style={generatedImageStyles.placeholder}>
          {failed ||
          generationState === "failed" ||
          generationState === "canceled" ? (
            <Text style={{ color: colors.textMuted }}>
              {generationState === "canceled"
                ? "Image generation canceled"
                : generationState === "failed"
                  ? "Image generation failed"
                  : offline
                    ? "Your computer is offline"
                    : "Image unavailable"}
            </Text>
          ) : (
            <>
              <ActivityIndicator size="small" color={colors.textMuted} />
              <Text
                style={[
                  generatedImageStyles.placeholderText,
                  { color: colors.textMuted },
                ]}
              >
                Generating image...
              </Text>
            </>
          )}
        </View>
      )}
    </View>
  );
});

const GeneratedImageCard = memo(function GeneratedImageCard({
  artifact,
  access,
  colors,
  onPress,
}: {
  artifact: ChatArtifact;
  access?: StoredPhoneAccess;
  colors: Colors;
  onPress?: (artifact: ChatArtifact) => void;
}) {
  const payload = artifact.payload;
  const driveBacked = payload.kind === "media" && payload.driveBacked === true;
  const open = useCallback(() => {
    if (!onPress) return;
    if (
      !driveBacked ||
      payload.kind !== "media" ||
      payload.asset.kind !== "image"
    ) {
      onPress(artifact);
      return;
    }
    // The viewer renders http(s) images directly; hand it signed URLs so a
    // cloud drive path is never asked of the computer.
    const asset = payload.asset;
    void Promise.all(asset.filePaths.map(resolveCloudDriveFileUri))
      .then((filePaths) =>
        onPress({
          ...artifact,
          payload: { ...payload, asset: { ...asset, filePaths } },
        }),
      )
      .catch(() => onPress(artifact));
  }, [artifact, driveBacked, onPress, payload]);
  if (payload.kind !== "media" || payload.asset.kind !== "image") return null;
  const paths =
    payload.asset.filePaths.length > 0 ? payload.asset.filePaths : [undefined];
  return (
    <Pressable
      accessibilityRole={
        payload.asset.filePaths.length > 0 ? "button" : undefined
      }
      accessibilityLabel={
        payload.generationState === "failed"
          ? "Image generation failed"
          : payload.asset.filePaths.length > 0
            ? "Open generated image"
            : "Generating image"
      }
      disabled={payload.asset.filePaths.length === 0}
      onPress={open}
      style={generatedImageStyles.strip}
    >
      {paths.map((filePath, index) => (
        <GeneratedImageTile
          key={filePath ?? `${artifact.id}:${index}`}
          filePath={filePath}
          conversationId={artifact.conversationId}
          access={access}
          driveBacked={driveBacked}
          aspectRatio={generatedImageAspectRatio(payload.aspectRatio)}
          alt={payload.prompt ?? "Generated image"}
          generationState={payload.generationState}
          colors={colors}
        />
      ))}
    </Pressable>
  );
});

const generatedImageStyles = StyleSheet.create({
  image: { height: "100%", width: "100%" },
  placeholder: {
    alignItems: "center",
    flex: 1,
    gap: 8,
    justifyContent: "center",
  },
  placeholderText: { fontFamily: fonts.sans.regular, fontSize: 14 },
  strip: { gap: 8 },
  tile: { borderRadius: 14, maxWidth: 320, overflow: "hidden", width: "100%" },
});

type CompletionQuote = {
  key: string;
  artifactId: string;
  ref: AgentReplyRef;
  files: ChatArtifact[];
};

/**
 * The tasks a row relays the results of: one quote per agent of each settled
 * completion card on the row (a follow-up keeps its spawn row instead).
 */
const rowCompletionQuotes = (
  agentWork: ReturnType<typeof consolidateRowArtifacts>["agentWork"],
): CompletionQuote[] =>
  agentWork.flatMap((artifact) => {
    if (
      artifact.payload.state !== "done" ||
      artifact.payload.followUp === true ||
      artifact.payload.completion !== true
    ) {
      return [];
    }
    const sections = inlineAgentWorkCardSections(artifact) ?? [];
    const filesByAgent = new Map(
      sections.flatMap((section) =>
        section.agentId ? [[section.agentId, section.files] as const] : [],
      ),
    );
    const agents =
      artifact.payload.agents && artifact.payload.agents.length > 0
        ? artifact.payload.agents.map((agent) => ({
            agentId: agent.agentId,
            title: agent.title,
            files: filesByAgent.get(agent.agentId) ?? [],
          }))
        : (artifact.payload.agentIds ?? []).slice(0, 1).map((agentId) => ({
            agentId,
            title: artifact.payload.title,
            files: [] as ChatArtifact[],
          }));
    return agents.flatMap((agent) => {
      if (!agent.agentId) return [];
      return [
        {
          key: `${artifact.id}:${agent.agentId}`,
          artifactId: artifact.id,
          ref: {
            kind: "agent" as const,
            threadId: agent.agentId,
            title: agent.title || artifact.payload.title,
          },
          files: agent.files,
        },
      ];
    });
  });

/**
 * A cloud completion lands on its own textless row just above the reply that
 * relays it. That row keeps the task quote; the reply below takes the task's
 * report link and files, so they ride in its bubble like on desktop.
 */
export const carryCompletionQuotes = (
  messages: readonly ChatMessage[],
): {
  carried: ReadonlyMap<string, CompletionQuote[]>;
  forwarded: ReadonlySet<string>;
} => {
  const carried = new Map<string, CompletionQuote[]>();
  const forwarded = new Set<string>();
  let pending: { ids: string[]; quotes: CompletionQuote[] } = {
    ids: [],
    quotes: [],
  };
  for (const message of messages) {
    if (message.role !== "assistant") {
      pending = { ids: [], quotes: [] };
      continue;
    }
    if ((message.text ?? "").trim().length > 0) {
      if (pending.quotes.length > 0) {
        carried.set(message.id, pending.quotes);
        for (const id of pending.ids) forwarded.add(id);
      }
      pending = { ids: [], quotes: [] };
      continue;
    }
    const quotes = rowCompletionQuotes(
      consolidateRowArtifacts(message.artifacts ?? [], message.tasks ?? [])
        .agentWork,
    );
    if (quotes.length > 0) {
      pending = {
        ids: [...pending.ids, message.id],
        quotes: [...pending.quotes, ...quotes],
      };
    }
  }
  return { carried, forwarded };
};

export const ChatMessageRow = memo(function ChatMessageRow({
  item,
  conversationId,
  styles,
  colors,
  animate,
  menuActive,
  isSelecting,
  anySelecting,
  actions: {
    onOpenArtifact,
    onOpenStellaFile,
    onOpenMessageMenu,
    onEndSelecting,
    onAskStella,
    onOpenReply,
    onOpenReport,
  },
  contextRef,
  contextStatus,
  desktopAccess,
  menuClone = false,
  receiptLabel,
  carriedQuotes,
  quotesForwarded = false,
}: {
  item: ChatMessage;
  /** Scopes this row's file reads, the way a tapped file link is scoped. */
  conversationId: string;
  styles: MessageRowStyles;
  colors: Colors;
  animate: boolean;
  /**
   * True while this row's long-press menu is open. The menu draws its own copy
   * of the bubble above the scrim, so the original steps aside.
   */
  menuActive: boolean;
  /** True while this row is in native text-selection mode. */
  isSelecting: boolean;
  /** True while ANY row is selecting — lets other rows tap-to-dismiss it. */
  anySelecting: boolean;
  /** Must keep one identity across renders (memoize it) or every row re-renders. */
  actions: MessageRowActions;
  /** The one reference worth quoting above this reply (shared reply-context rule). */
  contextRef?: ReplyRef;
  /** Live state of the quoted task, for its status glyph. */
  contextStatus?: ReplyAgentStatus;
  desktopAccess?: StoredPhoneAccess | null;
  /** Render only the bubble, for the long-press menu's lifted copy. */
  menuClone?: boolean;
  /** "Delivered" / "Read" under the latest user message. */
  receiptLabel?: string | null;
  /** Tasks quoted on the textless row just above, whose report link and
   *  files this reply's bubble carries. */
  carriedQuotes?: CompletionQuote[];
  /** This row's tasks are carried by the reply below it. */
  quotesForwarded?: boolean;
}) {
  // iOS press feedback: the held bubble eases down while the long-press
  // builds, then the menu lifts a copy of it (see MessageContextMenu).
  const pressScale = useRef(new Animated.Value(1)).current;
  const bubbleRef = useRef<View>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHold = () => {
    if (holdTimerRef.current === null) return;
    clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  };
  useEffect(
    () => () => {
      if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
    },
    [],
  );
  // Nothing moves until the finger has stayed down for MESSAGE_HOLD_MS, so a
  // tap, or a touch the list takes over as a scroll, never shows the press.
  // The timer is cancelled on release; an `Animated.delay` would not be,
  // because stopping `pressScale` leaves a sequence's pending delay running.
  const pressIn = () => {
    cancelHold();
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      Animated.timing(pressScale, {
        toValue: MESSAGE_PRESS_SCALE,
        duration: MESSAGE_LONG_PRESS_MS - MESSAGE_HOLD_MS,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
    }, MESSAGE_HOLD_MS);
  };
  const pressOut = () => {
    cancelHold();
    pressScale.stopAnimation();
    Animated.spring(pressScale, {
      toValue: 1,
      stiffness: 420,
      damping: 30,
      useNativeDriver: true,
    }).start();
  };
  const pressStyle = useMemo(
    () => ({ transform: [{ scale: pressScale }] }),
    [pressScale],
  );
  const openMenu = () => {
    // Every menu action works on text; an attachment-only bubble has none.
    if (!item.text.trim()) return;
    const bubble = bubbleRef.current;
    if (!bubble) return;
    // The frame is measured on an unscaled wrapper, so it is the bubble's
    // resting size even while the press shrink is showing.
    bubble.measureInWindow((x, y, width, height) => {
      // Medium impact for the lift; action taps then fire a light tap.
      tapMedium();
      onOpenMessageMenu({ message: item, anchor: { x, y, width, height } });
    });
  };

  // Keyed on the stable sub-objects: the trailing assistant row's `item` is
  // replaced whenever a message segment lands or a tool step updates, but its
  // artifacts/toolSteps keep their identity, so these derivations must not
  // re-run and mint fresh objects that defeat child memoization.
  const consolidated = useMemo(
    () => consolidateRowArtifacts(item.artifacts ?? [], item.tasks ?? []),
    [item.artifacts, item.tasks],
  );
  // Every file this reply hands over, in the order it named them: the loose
  // file artifacts of the turn, then the files its own text links. Generated
  // images keep their own full-width presentation, so they stay out of it.
  const evidencePaths = useMemo(() => {
    if (item.role !== "assistant") return [];
    const paths: string[] = [];
    for (const artifact of consolidated.looseFiles) {
      if (
        artifact.payload.kind === "media" &&
        artifact.payload.asset.kind === "image"
      ) {
        continue;
      }
      const filePath = artifactPrimaryFilePath(artifact.payload);
      if (filePath) paths.push(filePath);
    }
    paths.push(...extractLocalFileLinkPaths(item.text ?? ""));
    return paths;
  }, [consolidated.looseFiles, item.role, item.text]);
  // A cloud turn names one drive file twice: drive-relative as an artifact,
  // world-absolute as a link. The strip shows each file once, by the
  // world-absolute path, which is the one that opens from the drive.
  const evidenceStripPaths = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const filePath of evidencePaths) {
      const drivePath = cloudWorldDrivePath(filePath);
      const key = drivePath ?? filePath;
      if (!byKey.has(key) || drivePath) byKey.set(key, filePath);
    }
    return [...byKey.values()];
  }, [evidencePaths]);
  // Schedule tool results render their human-readable summaries as plain
  // text lines in the flow (desktop parity — no chip/card). Every settled
  // Schedule call in the turn gets its line, in call order; unparseable or
  // side-channel-JSON results render nothing. Keyed by step id for the map.
  const scheduleReceipts = useMemo(() => {
    const receipts: { id: string; text: string }[] = [];
    for (const step of item.toolSteps ?? []) {
      if (step.toolName.toLowerCase() !== "schedule") continue;
      if (step.status === "error") continue;
      const text = scheduleReceiptText({ resultPreview: step.resultPreview });
      if (text) receipts.push({ id: step.id, text });
    }
    return receipts;
  }, [item.toolSteps]);
  const bodyText = useMemo(
    () =>
      evidencePaths.length > 0
        ? unlinkLocalFileLinks(item.text, evidencePaths)
        : item.text,
    [item.text, evidencePaths],
  );
  const hasText = bodyText.trim().length > 0;
  // Apps the reply links (`stella://app/<slug>`) show as app cards under it.
  const linkedAppSlugs = useMemo(
    () =>
      item.role === "assistant" ? extractStellaAppLinkSlugs(item.text) : [],
    [item.role, item.text],
  );
  const boundedAssistantBubble = useMemo(
    () =>
      item.role === "assistant" && assistantBubbleNeedsBoundedWidth(item.text),
    [item.role, item.text],
  );
  // The reply row is appended empty when the turn dispatches and gains its text
  // when the message lands, so "mounted empty" is exactly "this message arrived
  // while the user was watching" — the cue for the landing entrance. Rows
  // restored from history mount with their text and render settled.
  const mountedEmptyRef = useRef(!hasText);

  if (item.role === "user") {
    const thumbs = item.thumbnailUris ?? [];
    const attachmentPreviews = item.attachmentPreviews ?? [];
    const showThumbs = thumbs.length > 0;
    const documentNames = item.documentNames ?? [];
    const showText = item.text.trim().length > 0;
    const quotedText = item.quotedText?.trim();
    const pastedTexts = item.pastedTexts ?? [];
    const hasBubbleBody =
      showText ||
      showThumbs ||
      attachmentPreviews.length > 0 ||
      documentNames.length > 0;
    const userBubbleBody = (
      <>
        {attachmentPreviews.length > 0 ? (
          <View
            style={[styles.userThumbStrip, showText && styles.userThumbsAbove]}
          >
            {attachmentPreviews.slice(0, 3).map((preview) => (
              <View key={preview.path} style={styles.userThumbImage}>
                {preview.imageUri ? (
                  <Image
                    source={{ uri: preview.imageUri }}
                    style={styles.userThumbImage}
                    contentFit="cover"
                    accessibilityLabel={preview.name}
                  />
                ) : (
                  <View style={styles.userAttachmentPlaceholder}>
                    <Icon name="file-text" size={20} color={colors.textMuted} />
                    <Text style={styles.userDocumentName} numberOfLines={2}>
                      {preview.name}
                    </Text>
                  </View>
                )}
              </View>
            ))}
          </View>
        ) : showThumbs ? (
          <View
            style={[styles.userThumbStrip, showText && styles.userThumbsAbove]}
          >
            {thumbs.slice(0, 3).map((uri) => (
              <Image
                key={uri}
                source={{ uri }}
                style={styles.userThumbImage}
                contentFit="cover"
              />
            ))}
          </View>
        ) : null}
        {attachmentPreviews.length === 0 && documentNames.length > 0 ? (
          <View
            style={[
              styles.userDocumentStrip,
              showText && styles.userThumbsAbove,
            ]}
          >
            {documentNames.map((name) => (
              <View key={name} style={styles.userDocumentChip}>
                <Icon name="file-text" size={12} color={colors.textMuted} />
                <Text
                  style={styles.userDocumentName}
                  numberOfLines={1}
                  maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
                >
                  {name}
                </Text>
              </View>
            ))}
          </View>
        ) : null}
        {showText ? <UserMessageText text={item.text} styles={styles} /> : null}
      </>
    );
    if (menuClone) {
      return <View style={styles.userBubble}>{userBubbleBody}</View>;
    }
    return (
      <View style={styles.userRow}>
        <View style={styles.userColumn}>
          {quotedText ? (
            // Quoted / "Ask Stella" context rides to the model as a separate
            // field and shows here as a chip — never folded into the bubble
            // body — so internal framing/decoration can't leak into the text.
            <View style={[styles.quoteChip, styles.userQuoteChip]}>
              <Icon
                name="quote"
                size={13}
                color={colors.textMuted}
                style={styles.quoteChipIcon}
              />
              <Text
                style={styles.quoteChipText}
                numberOfLines={1}
                maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
              >
                {quotedText}
              </Text>
            </View>
          ) : null}
          {pastedTexts.map((pasted, index) => (
            <View
              key={`pasted-${index}`}
              style={[styles.quoteChip, styles.userQuoteChip]}
              accessibilityLabel={`Pasted text, ${describePastedText(pasted)}`}
            >
              <Icon
                name="file-text"
                size={13}
                color={colors.textMuted}
                style={styles.quoteChipIcon}
              />
              <Text
                style={styles.quoteChipText}
                numberOfLines={1}
                maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
              >
                {`Pasted text · ${describePastedText(pasted)}`}
              </Text>
            </View>
          ))}
          {!hasBubbleBody ? null : isSelecting && showText ? (
            // "Select" mode: the bubble body becomes a native selection
            // surface (with a Copy pill), so a substring can be lifted out.
            <View style={styles.userBubble}>
              <AssistantTextSelection
                text={item.text}
                colors={{ ...colors, text: colors.userBubbleText }}
                onDismiss={onEndSelecting}
              />
            </View>
          ) : (
            <View
              ref={bubbleRef}
              collapsable={false}
              style={menuActive ? styles.bubbleHidden : null}
            >
              <Animated.View style={pressStyle}>
                <Pressable
                  onLongPress={openMenu}
                  onPressIn={pressIn}
                  onPressOut={pressOut}
                  // While another message is selecting, a tap here exits
                  // selection, so tapping away always dismisses.
                  onPress={anySelecting ? onEndSelecting : undefined}
                  delayLongPress={MESSAGE_LONG_PRESS_MS}
                  accessibilityHint="Long press for message actions"
                  style={styles.userBubble}
                >
                  {userBubbleBody}
                </Pressable>
              </Animated.View>
            </View>
          )}
          {receiptLabel ? (
            <Text
              style={styles.receipt}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              {receiptLabel}
            </Text>
          ) : null}
          {item.stopped ? (
            <Text
              style={styles.stoppedTag}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              Stopped
            </Text>
          ) : null}
        </View>
      </View>
    );
  }
  // Desktop-parity consolidation: agent lifecycle cards are expanded per
  // agent, noise writes are filtered and declared deliverables lead. The
  // minimal agent rows no longer surface file pills — agent-produced files
  // stay reachable through the activity hub — so `agentFiles` is unused here.
  const {
    agentWork: agentWorkArtifacts,
    maps: mapArtifacts,
    looseFiles,
  } = consolidated;
  const isStandIn = isStandInArtifactRow(item);
  // Assistant text no longer streams, so there is no partial-render window to
  // protect: every card mounts as soon as its artifact reaches the row.
  const showMapArtifacts = !isStandIn && mapArtifacts.length > 0;
  const generatedImages = looseFiles.filter(
    (artifact) =>
      artifact.payload.kind === "media" &&
      artifact.payload.asset.kind === "image",
  );
  const showGeneratedImages = !isStandIn && generatedImages.length > 0;
  // Everything else the reply attached shows as the strip: one row of real
  // media previews, then the rest as pills.
  const showEvidence = !isStandIn && evidencePaths.length > 0;
  const showArtifacts =
    showMapArtifacts ||
    (showGeneratedImages && !hasText) ||
    linkedAppSlugs.length > 0;
  // Desktop renders the complete markdown body once, then attaches activity
  // and artifact cards at the row boundary. Keep the same shape on mobile:
  // stored text offsets still describe event chronology, but must never become
  // character-level insertion points that split prose (or markdown) in two.
  const groupAgentWorkArtifacts = agentWorkArtifacts;
  // Desktop parity: a task whose result this reply relays is quoted ABOVE
  // the bubble the iMessage way; the files it produced ride as pills at the
  // bottom of the reply bubble itself. A settled follow-up keeps its spawn
  // row.
  const completionQuotes = rowCompletionQuotes(groupAgentWorkArtifacts);
  const relayedQuotes = [
    ...(quotesForwarded ? [] : completionQuotes),
    ...(carriedQuotes ?? []),
  ];
  const quotedThreadIds = new Set(
    [...completionQuotes, ...relayedQuotes].map((quote) => quote.ref.threadId),
  );
  // Files a relayed task produced, minus any the evidence strip already shows
  // because the reply links them.
  const evidencePathSet = new Set(evidencePaths);
  const replyFiles = onOpenArtifact
    ? relayedQuotes
        .flatMap((quote) => quote.files)
        .filter((file, index, all) => {
          const filePath = artifactPrimaryFilePath(file.payload);
          return (
            !(filePath && evidencePathSet.has(filePath)) &&
            all.findIndex((other) => other.id === file.id) === index
          );
        })
    : [];
  const showReplyFiles = !isStandIn && replyFiles.length > 0;
  // Everything the reply attaches sits at the bottom of its bubble; a reply
  // with no text shows the same pieces on their own.
  const generatedImageCards = showGeneratedImages
    ? generatedImages.map((artifact) => (
        <GeneratedImageCard
          key={artifact.id}
          artifact={artifact}
          access={desktopAccess ?? undefined}
          colors={colors}
          onPress={onOpenArtifact}
        />
      ))
    : null;
  // With text, pictures and video sit in their own block under the bubble
  // and file pills at the bottom of it; without text, the strip stands alone.
  const evidenceMedia = showEvidence ? (
    <MessageEvidenceStrip
      filePaths={evidenceStripPaths}
      conversationId={conversationId}
      access={desktopAccess ?? null}
      colors={colors}
      onOpen={onOpenStellaFile}
      part={hasText ? "media" : undefined}
      style={hasText ? styles.mediaBelowBubble : undefined}
    />
  ) : null;
  const evidenceDocuments =
    showEvidence && hasText ? (
      <MessageEvidenceStrip
        filePaths={evidenceStripPaths}
        conversationId={conversationId}
        access={desktopAccess ?? null}
        colors={colors}
        onOpen={onOpenStellaFile}
        part="documents"
        style={styles.bubbleEvidence}
      />
    ) : null;
  const replyFilePills =
    showReplyFiles && onOpenArtifact ? (
      <ReplyFilePills
        files={replyFiles}
        colors={colors}
        onOpenArtifact={onOpenArtifact}
        style={styles.bubbleFilePills}
      />
    ) : null;
  // The full report of each task this reply relays (or cites, unless it is
  // still running) opens from a quiet "more" after the reply's text, not from
  // the quote.
  const reportRefs: AgentReplyRef[] = [
    ...relayedQuotes.map((quote) => quote.ref),
    ...(contextRef?.kind === "agent" &&
    !quotedThreadIds.has(contextRef.threadId) &&
    contextStatus !== "running"
      ? [contextRef]
      : []),
  ];
  const moreLinks =
    onOpenReport && reportRefs.length > 0
      ? reportRefs.map((ref) => ({
          key: ref.threadId,
          label: `Full report: ${replyTitle(ref)}`,
          onPress: () => onOpenReport(ref),
        }))
      : undefined;
  const fillAssistantBubble = boundedAssistantBubble;
  const assistantBubble = (
    <AssistantBubble
      style={[
        styles.assistantBubble,
        fillAssistantBubble && styles.assistantBlockBubble,
      ]}
      animate={!menuClone && (animate || mountedEmptyRef.current)}
    >
      <AssistantMarkdown
        text={bodyText}
        colors={colors}
        fill={boundedAssistantBubble}
        onStellaFileLink={onOpenStellaFile}
        moreLinks={moreLinks}
      />
      {evidenceDocuments}
      {replyFilePills}
    </AssistantBubble>
  );
  if (menuClone) return assistantBubble;
  return (
    <View style={styles.assistantRow}>
      {onOpenReply
        ? completionQuotes.map((quote) => (
            <ReplyPreview
              key={quote.key}
              reference={quote.ref}
              status={
                contextRef?.kind === "agent" &&
                contextRef.threadId === quote.ref.threadId
                  ? contextStatus
                  : "completed"
              }
              colors={colors}
              onOpen={() => onOpenReply(quote.ref)}
            />
          ))
        : null}
      {contextRef &&
      onOpenReply &&
      !(
        contextRef.kind === "agent" && quotedThreadIds.has(contextRef.threadId)
      ) ? (
        <ReplyPreview
          reference={contextRef}
          status={contextStatus}
          colors={colors}
          onOpen={() => onOpenReply(contextRef)}
        />
      ) : null}
      {hasText && isSelecting ? (
        // "Select" mode: the reply's plain text in a selection surface with
        // everything selected and a Copy / Ask Stella pill.
        <View style={[styles.assistantBubble, styles.assistantSelectBubble]}>
          <AssistantTextSelection
            text={extractPlainText(item.text).trim()}
            colors={{ ...colors, text: colors.assistantBubbleText }}
            onAskStella={onAskStella}
            onDismiss={onEndSelecting}
          />
        </View>
      ) : hasText ? (
        <View
          ref={bubbleRef}
          collapsable={false}
          style={[
            fillAssistantBubble
              ? styles.assistantBubbleSlotFill
              : styles.assistantBubbleSlot,
            menuActive && styles.bubbleHidden,
          ]}
        >
          <Animated.View style={pressStyle}>
            <Pressable
              onLongPress={openMenu}
              onPressIn={pressIn}
              onPressOut={pressOut}
              onPress={anySelecting ? onEndSelecting : undefined}
              delayLongPress={MESSAGE_LONG_PRESS_MS}
              accessibilityHint="Long press for message actions"
            >
              {assistantBubble}
            </Pressable>
          </Animated.View>
        </View>
      ) : null}
      {hasText && (showGeneratedImages || showEvidence) ? (
        <View>
          {showGeneratedImages ? (
            <View style={[styles.artifactGroup, styles.mediaBelowBubble]}>
              {generatedImageCards}
            </View>
          ) : null}
          {evidenceMedia}
        </View>
      ) : null}
      {scheduleReceipts.map((receipt) => (
        <Text
          key={receipt.id}
          style={styles.scheduleReceipt}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          {receipt.text}
        </Text>
      ))}
      {showArtifacts ? (
        <View
          style={[styles.artifactGroup, hasText && styles.artifactGroupSpaced]}
        >
          {/* Running agents surface in the top bar's status mark, not as
              transcript rows; finished ones arrive as quotes above replies. */}
          {linkedAppSlugs.map((slug) => (
            <AppPreviewCard key={`app:${slug}`} slug={slug} colors={colors} />
          ))}
          {showMapArtifacts
            ? mapArtifacts.map((artifact) => (
                <MapRouteCard
                  key={artifact.id}
                  payload={artifact.payload}
                  colors={colors}
                />
              ))
            : null}
          {hasText ? null : generatedImageCards}
        </View>
      ) : null}
      {hasText ? null : evidenceMedia}
      {hasText || !replyFilePills ? null : (
        <View style={styles.artifactGroupSpaced}>{replyFilePills}</View>
      )}
      {item.stopped ? (
        <Text
          style={styles.stoppedTag}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          Stopped
        </Text>
      ) : null}
      {item.cloudFallback ? (
        <Text
          style={styles.cloudTag}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          Answered while your computer was offline
        </Text>
      ) : null}
    </View>
  );
});

export const makeMessageRowStyles = (colors: Colors) =>
  StyleSheet.create({
    userRow: { flexDirection: "row", justifyContent: "flex-end" },
    userColumn: { alignItems: "flex-end", maxWidth: "92%" },
    // iMessage bubbles: one continuous (squircle) radius on every corner. The
    // radius is desktop's fixed `--radius-3xl` (18) rather than something at or
    // past half a one-line bubble's height, which is what kept very short
    // messages from collapsing into a round blob there.
    userBubble: {
      backgroundColor: colors.userBubbleFill,
      borderRadius: 18,
      borderCurve: "continuous",
      paddingHorizontal: 14,
      paddingVertical: 6,
    },
    bubbleHidden: { opacity: 0 },
    receipt: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
      letterSpacing: -0.1,
      marginRight: 6,
      marginTop: 4,
    },
    stoppedTag: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 11,
      letterSpacing: 0.4,
      marginTop: 6,
      textTransform: "uppercase",
    },
    cloudTag: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      letterSpacing: -0.1,
      marginTop: 6,
      opacity: 0.8,
    },
    userText: {
      color: colors.userBubbleText,
      fontFamily: fonts.sans.regular,
      fontSize: 17,
      letterSpacing: 0.03 * 17,
      lineHeight: 17 * 1.52,
    },
    userToggle: {
      alignSelf: "flex-end",
      // Muted version of the bubble's own text color (desktop: 68% alpha).
      color: fadeHex(colors.userBubbleText, 0.68),
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: -0.1,
      lineHeight: 16,
      marginTop: 6,
    },
    userTogglePressed: {
      color: colors.text,
    },
    userThumbStrip: {
      alignSelf: "flex-start",
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
    },
    userThumbsAbove: { marginBottom: 8 },
    userThumbImage: {
      backgroundColor: colors.muted,
      borderRadius: 8,
      height: 84,
      width: 84,
    },
    userDocumentStrip: {
      alignSelf: "flex-start",
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 6,
    },
    userAttachmentPlaceholder: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 6,
      gap: 5,
    },
    userDocumentChip: {
      alignItems: "center",
      backgroundColor: fadeHex(colors.textMuted, 0.14),
      borderRadius: 999,
      flexDirection: "row",
      gap: 4,
      maxWidth: 200,
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    userDocumentName: {
      color: colors.textMuted,
      flexShrink: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      letterSpacing: -0.1,
    },
    assistantRow: { paddingVertical: ASSISTANT_ROW_PAD_VERTICAL },
    /**
     * Mirror of `userBubble`, flipped: same radius family with the tightened
     * corner on the bottom LEFT, the quieter elevated surface (`card`) instead
     * of the accent tint, and a hairline `border` rather than `borderStrong` so
     * the assistant reads as the calmer of the two speakers.
     *
     * Vertical padding is asymmetric on purpose: markdown blocks carry their
     * own trailing margin (a paragraph's is 10 — see `buildNodeStyles` in
     * AssistantMarkdown), so a small `paddingBottom` plus that margin lands at
     * the same ~10-12pt optical inset as the top, with no negative margins that
     * could clip a trailing code block.
     */
    assistantBubble: {
      alignSelf: "flex-start",
      overflow: "hidden",
      borderRadius: 18,
      borderCurve: "continuous",
      maxWidth: "100%",
      paddingBottom: 0,
      paddingHorizontal: 14,
      paddingTop: 9,
    },
    // The long-press target hugs the bubble so its measured frame is the
    // bubble's own (the menu redraws the bubble at exactly that frame).
    assistantBubbleSlot: { alignSelf: "flex-start", maxWidth: "100%" },
    assistantBubbleSlotFill: { alignSelf: "stretch" },
    assistantSelectBubble: {
      backgroundColor: colors.assistantBubbleFillBottom,
      paddingBottom: 10,
    },
    // Yoga stretches block Markdown to the measured list-cell width in the
    // same layout pass, giving nested list/scroller children a definite bound.
    // Plain text keeps the intrinsic hugging style above.
    assistantBlockBubble: { alignSelf: "stretch" },
    // Schedule tool receipt — a plain text line in the conversation flow
    // (desktop parity: no chip or card), slightly quieter than reply prose.
    scheduleReceipt: {
      color: colors.text,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      letterSpacing: -0.1,
      lineHeight: 20,
      marginTop: 6,
    },
    artifactGroup: { gap: 10 },
    bubbleFilePills: { marginTop: 2, marginBottom: 12 },
    bubbleEvidence: { marginTop: 0, marginBottom: 12 },
    mediaBelowBubble: { marginTop: 6 },
    artifactGroupSpaced: { marginTop: 10 },
    quoteChip: {
      alignItems: "center",
      alignSelf: "flex-start",
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 6,
      maxWidth: "100%",
      paddingLeft: 10,
      paddingRight: 6,
      paddingVertical: 6,
    },
    quoteChipIcon: { opacity: 0.8 },
    quoteChipText: {
      color: colors.textMuted,
      flexShrink: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      letterSpacing: -0.1,
    },
    // Sent-message variant of the quote chip: right-aligned above the user
    // bubble (matching the bubble's trailing edge) with a little breathing room.
    userQuoteChip: {
      alignSelf: "flex-end",
      marginBottom: 6,
    },
  } as const);
