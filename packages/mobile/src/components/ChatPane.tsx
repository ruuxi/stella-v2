import type { ReplyRef } from "@stella/contracts/reply-refs";
import { AgentReportSheet, ReplyFocus, type AgentReplyRef } from "./ReplyFocus";
import { type ReplyAgentStatus } from "./ReplyPreview";
import {
  mobileReplyContexts,
  type MobileReplyContexts,
} from "../lib/mobile-reply-context";
import { useAgentReplyTitles } from "../lib/use-agent-reply-titles";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Alert,
  type GestureResponderEvent,
  Keyboard,
  LayoutChangeEvent,
  LayoutAnimation,
  Linking,
  NativeScrollEvent,
  NativeSyntheticEvent,
  Platform,
  Pressable,
  Share,
  StyleSheet,
  Text,
  TextInput,
  UIManager,
  useWindowDimensions,
  View,
} from "react-native";
import {
  LegendList,
  type LegendListRenderItemProps,
} from "@legendapp/list/react-native";
import { LinearGradient } from "expo-linear-gradient";
import MaskedView from "@react-native-masked-view/masked-view";
import * as Clipboard from "expo-clipboard";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import {
  CHAT_ATTACHMENT_MAX_COUNT,
  driveFileNameFor,
  type ComposerAttachment,
  type PickedAttachment,
} from "../lib/chat-attachments";
import { useT } from "../i18n";
import {
  useChatDraftSelector,
  type ChatDraftStore,
} from "../lib/chat-draft-store";
import Reanimated, {
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AddContextSheet } from "./AddContextSheet";
import { Icon } from "./Icon";
import {
  formatTimestampHeader,
  readReceipt,
  timestampHeaders,
} from "../lib/message-time-labels";
import {
  MessageContextMenu,
  type MessageMenuAction,
} from "./MessageContextMenu";
import { AppBackdrop } from "./AppBackdrop";
import { useShellTopInset } from "./MainScreenSurface";
import { useKeyboardHandler } from "react-native-keyboard-controller";
import {
  ASSISTANT_ROW_PAD_VERTICAL,
  ChatMessageRow,
  MessageEntry,
  carryCompletionQuotes,
  makeMessageRowStyles,
  type MessageMenuRequest,
  type MessageRowActions,
} from "./chat/MessageRow";
import {
  CHAT_HORIZONTAL_INSET,
  Composer,
  type ComposerModelPickerConfig,
  LAYOUT_SPRING,
  draftHasText,
  isDraftEmpty,
} from "./chat/Composer";
import { CatchUpPill, ScrollToBottomFab } from "./chat/FloatingControls";
import {
  type AnchorRect,
  type PlusMenuOption,
  PlusMenuPopover,
} from "./chat/PlusMenu";
import { ChatSearchResults, useChatSearchResults } from "./chat/Search";
import { stellaFileChatArtifact } from "../lib/stella-file-links";
import { useCatchUpIndicatorVisible } from "../lib/catch-up-indicator";
import { ChatHistoryPaging } from "../lib/chat-history-paging";
import {
  markPrependedMessagesSeen,
  shouldAnimateMessageEntry,
  visibleChatMessages,
} from "../lib/message-row-identity";
import { RealtimeVoiceOverlay } from "./RealtimeVoiceOverlay";
import {
  getVoiceEnabled,
  subscribeVoiceEnabled,
} from "../lib/voice-visibility";
import { ensureMicrophonePermission } from "../lib/microphone-permission";
import {
  WorkingIndicator,
  WORKING_INDICATOR_SLOT_HEIGHT,
} from "./WorkingIndicator";
import type { WorkingIndicatorState } from "./working-indicator-state";
import { useDictation } from "../lib/dictation";
import { canSubmitFinalizedDictation } from "../lib/dictation-send";
import { hasAiConsent, requestAiConsent } from "../lib/ai-consent";
import type { RealtimeVoiceActionDispatch } from "../lib/realtime-voice-protocol";
import type { StoredPhoneAccess } from "../lib/phone-access";
import { useChatSearch } from "../lib/chat-search";
import { canStartPostSendPlacement } from "../lib/chat-post-send-placement";
import { resolveChatDataChangeScrollOwner } from "../lib/chat-scroll-ownership";
import { useChatScroll } from "../lib/use-chat-scroll";
import { useKeyboardInset } from "../lib/use-keyboard-inset";
import { notifySuccess, tapMedium, tapLight } from "../lib/haptics";
import {
  pauseReadAloud,
  resumeReadAloud,
  speakReply,
  stopReadAloud,
  startAfterStoppingReadAloud,
  getReadAloudPlaybackState,
  useReadAloudPreference,
} from "../lib/read-aloud";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";
import type {
  ChatArtifact,
  ChatMessage,
  ComposerQuote,
  MobileTask,
} from "../types";

// Required for LayoutAnimation on Android.
if (
  Platform.OS === "android" &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

/**
 * Quiet window after the footer stops shrinking before we commit the smaller
 * height to the list inset. A collapse animation emits a burst of intermediate
 * `onLayout` heights; committing each one re-renders the list padding and
 * re-targets the scroll-follow math every frame. Slightly longer than a 350ms
 * spring's tail so we settle on the resting height, not a mid-animation one.
 */
const FOOTER_SHRINK_SETTLE_MS = 140;

const EDGE_FADE = 48;
/**
 * Where the transcript's first row rests below the top bar: the list's own
 * 80pt lead plus the 4pt the shell's content box used to add above the pane.
 */
const LIST_TOP_GAP = 84;
/** How far below the top bar the scrolled-under fade reaches. */
const TOP_TAPER_TAIL = 24;
const CATCH_UP_PILL_GAP = 10;
/** LegendList's data-change tail pin, hoisted so it keeps one identity. */
const LEGEND_TAIL_SCROLL_AT_END = {
  animated: false,
  on: { dataChange: true, itemLayout: false, layout: false },
} as const;
const MESSAGE_LIST_GAP = 10;
/**
 * Fixed reading-area floor below the last message (desktop's
 * `.event-list-trailing-region` `min-height`). The inline working indicator
 * lives inside this footer region; reserving a constant height means the
 * indicator fading in/out never grows or shrinks the chat's content, so the
 * tail never jumps when a reply starts or finishes. Sized to fully contain the
 * indicator slot plus a few pt so it reads as a deliberate gap when idle.
 */
const CHAT_TAIL_GAP = WORKING_INDICATOR_SLOT_HEIGHT + 12;
/**
 * The working indicator used to live inside the footer overlay (above the
 * composer), so its reserved slot height was baked into the measured
 * `footerHeight` that the floating controls anchor their bottom offset against.
 * It now rides inline at the chat tail, which shrank `footerHeight` by that
 * slot height and dropped both floating buttons low enough for the composer to
 * overlap them. Re-add the slot height to the buttons' bottom anchor so they
 * sit exactly where they did before the indicator moved, without bringing back
 * the fixed indicator. `footerHeight` still includes the composer's safe-area
 * inset, so the buttons keep clearing the home indicator.
 */
const FLOATING_CONTROL_LIFT = WORKING_INDICATOR_SLOT_HEIGHT;
/** Cancels the shell `content` padding so chat owns its horizontal inset. */
const SHELL_CONTENT_PADDING = 20;

const copyMessageText = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return;
  void Clipboard.setStringAsync(trimmed).then((ok) => {
    if (ok) notifySuccess();
  });
};

const shareMessageText = (text: string) => {
  const trimmed = text.trim();
  if (!trimmed) return;
  void Share.share({ message: trimmed }).catch(() => {});
};

/**
 * Renders `text` as a markdown blockquote (each line prefixed with "> "), the
 * quote convention understood by the composer's markdown. Used by the message
 * menu's "Quote" action to reply to a specific message.
 */
const quoteMessageText = (text: string): string =>
  text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

/**
 * The long-press menu's read-aloud entry for an assistant reply. It reads the
 * playback state when the menu opens, so while this reply's clip is loaded the
 * same slot pauses, resumes or stops it instead of starting over.
 */
const speakAloudMenuAction = (
  text: string,
  messageId: string,
): MessageMenuAction => {
  const playback = getReadAloudPlaybackState();
  const status = playback?.messageId === messageId ? playback.status : null;
  if (status === "playing") {
    return {
      id: "speak",
      label: "Pause speaking",
      icon: "pause",
      onSelect: () => {
        tapLight();
        pauseReadAloud();
      },
    };
  }
  if (status === "paused") {
    return {
      id: "speak",
      label: "Resume speaking",
      icon: "play",
      onSelect: () => {
        tapLight();
        resumeReadAloud();
      },
    };
  }
  if (status === "loading") {
    return {
      id: "speak",
      label: "Stop speaking",
      icon: "stop",
      onSelect: () => {
        tapLight();
        stopReadAloud();
      },
    };
  }
  return {
    id: "speak",
    label: "Speak aloud",
    icon: "volume-2",
    onSelect: () => {
      tapLight();
      void speakReply(text, messageId);
    },
  };
};

// ---------------------------------------------------------------------------
// ChatPane — full chat screen surface (list + composer + scroll model).
// Used by both the chat and the computer chat so both render visually
// identically; the parent just owns message state and submission.
// ---------------------------------------------------------------------------

/** Durable pages adjacent to the bounded in-memory message window. */
export type ChatPaneHistory = {
  /**
   * True while history is still hydrating (e.g. AsyncStorage load on mount or
   * an unknown pairing state). Suppresses the empty state so it doesn't flash
   * during tab transitions before the real messages arrive.
   */
  loading?: boolean;
  hasOlder?: boolean;
  hasNewer?: boolean;
  pageLoading?: boolean;
  onLoadOlder?: () => Promise<void> | void;
  onLoadNewer?: () => Promise<void> | void;
};

export type ChatPaneComposer = {
  /**
   * The composer text. Only the input subscribes to the full value, so a
   * keystroke re-renders the input rather than this whole pane.
   */
  draftStore: ChatDraftStore;
  /** Whether the composer accepts text (typing + sending). */
  enabled?: boolean;
  /**
   * Optional paired-computer model control. When pinned, it keeps the composer
   * expanded and renders a compact model picker in the toolbar.
   */
  modelPicker?: ComposerModelPickerConfig;
  /** Visible placeholder when not transcribing. */
  placeholder: string;
  /** Owner-approved intervention pinned immediately above the composer. */
  intervention?: ReactNode;
  /**
   * Everything except content that gates sending (uploads settled, hydrated,
   * online, authority ready). The pane adds the content check itself: typed
   * text, an attachment, or a quote.
   */
  sendReady: boolean;
  /** Triggered by the send button or `return` key. */
  onSubmit: () => { userMessageId: string } | null;
  /**
   * Optional stop handler. When provided AND `streaming` is true, the send
   * button is replaced by a stop button that calls this. Used to cancel the
   * in-flight reply (and cancels any queued messages without deleting their
   * bubbles) for both the local chat stream and computer-chat round trip.
   */
  onStop?: () => void;
};

/** Photo and file attachments. Omitted when this transport takes none. */
export type ChatPaneAttachments = {
  /** Current attachments. */
  items?: ComposerAttachment[];
  /** Hands picked files to the owner, which uploads them and reports overflow. */
  onAdd?: (picked: readonly PickedAttachment[]) => {
    rejected: number;
  };
  onRemove?: (id: string) => void;
  /** Retries one failed upload. Absent means a failed chip can only be removed. */
  onRetry?: (id: string) => void;
  /**
   * Optional overall cap for this transport. Picker-level limits reset per
   * launch, so the chat supplies its backend request limit here.
   */
  max?: number;
};

/**
 * Quoted-text chips pending in the composer — added by the message menu's
 * "Quote" and assistant selection's "Ask Stella", rendered as removable chips
 * above the input, and folded into the sent message by `useChatThread`. When
 * `onAdd` is absent those actions fall back to inline draft text.
 */
export type ChatPaneQuotes = {
  items?: ComposerQuote[];
  onAdd?: (text: string) => void;
  onRemove?: (id: string) => void;
};

export type ChatPaneDictation = {
  anonymous: boolean;
  /** Headers passed to the dictation upload (e.g. mobile device id for guests). */
  headers?: Record<string, string>;
};

export type ChatPaneRealtimeVoice = {
  /** Stable id of the text chat to which realtime voice is attached. */
  conversationId?: string | null;
  /** Where voice-request actions should execute. */
  execution?: "phone" | "computer";
  /** Paired desktop credentials used only by Computer realtime voice. */
  desktopAccess?: StoredPhoneAccess | null;
  /** Show sign-in before starting capture for an anonymous cloud user. */
  signInRequired?: boolean;
  /** Dispatches one action request into the attached text chat. */
  onAction?: (request: string) => Promise<RealtimeVoiceActionDispatch>;
};

// The pane is not memoized, and every group is destructured into scalars
// before it reaches a hook dependency or a memoized child, so callers may pass
// these groups inline.
export type ChatPaneProps = {
  /** Visible message list (parent-owned). */
  messages: ChatMessage[];
  /** True while a reply is streaming — controls composer stop button. */
  streaming: boolean;
  /**
   * Live working-indicator props derived from the run (active state + the
   * dynamic, tool-aware label), mirroring the desktop indicator.
   */
  workingIndicator?: WorkingIndicatorState;
  /** Shows a quiet offline notice above the composer. */
  offline?: boolean;
  /** Empty-state body. Rendered centered when there are no messages. */
  emptyContent: ReactNode;
  history?: ChatPaneHistory;
  composer: ChatPaneComposer;
  /** Omitted hides the photo/file actions of the `+` sheet. */
  attachments?: ChatPaneAttachments;
  quotes?: ChatPaneQuotes;
  dictation: ChatPaneDictation;
  realtimeVoice?: ChatPaneRealtimeVoice;
  /**
   * Paired desktop used to open computer-owned files in the transcript. Kept
   * separate from the voice route so a cloud voice selection does not hide
   * files produced by an earlier computer turn.
   */
  desktopAccess?: StoredPhoneAccess | null;

  /** Opens a desktop artifact linked from an assistant message. */
  onOpenArtifact?: (
    artifact: ChatArtifact,
    gallery?: readonly ChatArtifact[],
  ) => void;

  /**
   * Conversation the transcript belongs to. Used to key artifacts built from
   * tapped `stella://file/...` links so the viewer's computer file reads are
   * scoped like inline artifact cards. Optional — link taps still open the
   * viewer without it.
   */
  conversationId?: string | null;

  /** Background tasks, for realtime voice's picture of what is running. */
  activityTasks?: MobileTask[];

  /**
   * Reveals the activity (the sidebar, where tasks, schedules and files
   * live). Message rows with agent work tap through to it. Running work
   * itself shows in the top bar's status pill.
   */
  onOpenActivity?: () => void;

  /**
   * Height of the chrome floating over the pane's top edge (the safe area
   * plus the shell's top bar). The transcript scrolls underneath it and rests
   * below it. Defaults to the shell's own top bar.
   */
  topInset?: number;

  /**
   * True while a catch-up sync is pulling turns the phone may have missed
   * (landing, foreground/refocus, Force Sync — see `useChatThread`). Renders a
   * small transient "Catching up" pill at the top of the transcript, debounced
   * by `useCatchUpIndicatorVisible` so instant pulls never flash it.
   * Steady-state polls and send-path pulls must not set this.
   */
  catchingUp?: boolean;
};

const NO_HISTORY: ChatPaneHistory = {};
const NO_ATTACHMENTS: ChatPaneAttachments = {};
const NO_QUOTES: ChatPaneQuotes = {};
const NO_REALTIME_VOICE: ChatPaneRealtimeVoice = {};

export function ChatPane({
  messages: projectedMessages,
  streaming,
  workingIndicator,
  offline = false,
  emptyContent,
  history = NO_HISTORY,
  composer,
  attachments: attachmentsGroup,
  quotes: quotesGroup = NO_QUOTES,
  dictation: { anonymous: dictationAnonymous, headers: dictationHeaders },
  realtimeVoice = NO_REALTIME_VOICE,
  desktopAccess: desktopAccessProp = null,
  onOpenArtifact,
  conversationId = null,
  activityTasks,
  onOpenActivity,
  catchingUp = false,
  topInset: topInsetProp,
}: ChatPaneProps) {
  const {
    loading: historyLoading = false,
    hasOlder: hasOlderHistory = false,
    hasNewer: hasNewerHistory = false,
    pageLoading: historyPageLoading = false,
    onLoadOlder: onLoadOlderHistory,
    onLoadNewer: onLoadNewerHistory,
  } = history;
  const {
    draftStore,
    enabled: composerEnabled = true,
    modelPicker: composerModelPicker,
    placeholder,
    intervention: composerIntervention,
    sendReady,
    onSubmit,
    onStop,
  } = composer;
  const enableAttachments = attachmentsGroup !== undefined;
  const {
    items: attachments,
    onAdd: onAddAttachments,
    onRemove: onRemoveAttachment,
    onRetry: onRetryAttachment,
    max: maxAttachments,
  } = attachmentsGroup ?? NO_ATTACHMENTS;
  const {
    items: quotes,
    onAdd: onAddQuote,
    onRemove: onRemoveQuote,
  } = quotesGroup;
  const {
    conversationId: realtimeVoiceConversationId = null,
    execution: realtimeVoiceExecution = "phone",
    desktopAccess: realtimeVoiceDesktopAccess = null,
    signInRequired: realtimeVoiceSignInRequired = false,
    onAction: onRealtimeVoiceAction,
  } = realtimeVoice;
  // Transcript file links open on the preferred paired computer even when the
  // voice route itself is the phone's cloud session.
  const desktopAccess = desktopAccessProp ?? realtimeVoiceDesktopAccess;
  const messages = useAgentReplyTitles(conversationId, projectedMessages);
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const t = useT();
  const readAloud = useReadAloudPreference();
  const insets = useSafeAreaInsets();
  const bottomInset = insets.bottom;
  const safeAreaTop = insets.top;
  const shellTopInset = useShellTopInset();
  const topInset = topInsetProp ?? shellTopInset;
  const { height: screenHeight } = useWindowDimensions();

  const inputRef = useRef<TextInput>(null);
  const { height: keyboardHeight, composerBottomPad } = useKeyboardInset();
  // The composer rests at `composerBottomPad` (the home-indicator band) above
  // the screen bottom and rides the keyboard's top edge, a constant gap above
  // it, once the keyboard reaches it: it is lifted by the keyboard height
  // minus that band.
  const keyboardHeightNow = useSharedValue(0);
  useKeyboardHandler(
    {
      onStart: (e) => {
        "worklet";
        if (e.duration === 0) keyboardHeightNow.value = e.height;
      },
      onMove: (e) => {
        "worklet";
        keyboardHeightNow.value = e.height;
      },
      onInteractive: (e) => {
        "worklet";
        keyboardHeightNow.value = e.height;
      },
      onEnd: (e) => {
        "worklet";
        keyboardHeightNow.value = e.height;
      },
    },
    [],
  );
  const keyboardLift = useDerivedValue(() =>
    Math.max(0, keyboardHeightNow.value - bottomInset),
  );
  const composerKeyboardStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -keyboardLift.value }],
  }));
  const listKeyboardStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -keyboardLift.value }],
  }));
  const keyboardExtra = Math.max(0, keyboardHeight - bottomInset);

  // The composer + working indicator overlay the bottom of the chat. We
  // measure their actual height so the list can reserve matching
  // bottom inset, letting messages scroll under the composer (visible
  // through transparent margins around the glass shell) instead of being
  // clipped by it. The composer's keyboard lift is a transform, so this
  // measured height stays constant across keyboard show/hide.
  const [footerHeight, setFooterHeight] = useState(0);
  // The list runs under the composer, so its reserved inset is exactly the
  // overlay; the chat tail supplies the gap between the last row and it.
  const listBottomInsetPx = footerHeight;
  const listTrailingSlackPx = listBottomInsetPx + CHAT_TAIL_GAP;

  // The footer (working indicator + composer) re-measures on every frame of any
  // layout animation it runs. Each measurement re-renders the list padding and
  // nudges the scroll-follow target, so tracking every intermediate frame turns
  // a composer collapse into churn at the bottom of the screen. Grow the inset
  // immediately — too little reserved space lets the composer overlap the last
  // message — but defer a shrink until the animation settles, since extra slack
  // for a beat is invisible.
  const footerShrinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const onFooterLayout = useCallback((e: LayoutChangeEvent) => {
    const h = Math.round(e.nativeEvent.layout.height);
    if (footerShrinkTimerRef.current) {
      clearTimeout(footerShrinkTimerRef.current);
      footerShrinkTimerRef.current = null;
    }
    setFooterHeight((prev) => {
      if (h > prev) return h;
      if (h < prev) {
        footerShrinkTimerRef.current = setTimeout(() => {
          footerShrinkTimerRef.current = null;
          setFooterHeight(h);
        }, FOOTER_SHRINK_SETTLE_MS);
      }
      return prev;
    });
  }, []);
  useEffect(
    () => () => {
      if (footerShrinkTimerRef.current) {
        clearTimeout(footerShrinkTimerRef.current);
      }
    },
    [],
  );

  const assistantTextLenRef = useRef(0);
  const assistantIdRef = useRef<string | null>(null);
  // Hidden tool/activity rows still own reply relationships and agent state.
  // Project those from the complete transcript before filtering list cells.
  const replyContexts = useMemo(
    () => mobileReplyContexts(messages),
    [messages],
  );
  const visibleMessages = useMemo(
    () =>
      visibleChatMessages(messages, {
        contextMessageIds: replyContexts.contexts,
        canOpenArtifacts: Boolean(onOpenArtifact),
      }),
    [messages, replyContexts, onOpenArtifact],
  );
  const quoteCarry = useMemo(
    () => carryCompletionQuotes(visibleMessages),
    [visibleMessages],
  );
  // A conversation first observed empty mounts its list on the optimistic
  // send. Our post-send owner already places that row; starting Legend's
  // footer-preserving end bootstrap as well would move it a second time.
  // Existing history still bootstraps at its tail once hydration completes.
  const initialScrollAtEndRef = useRef<boolean | null>(null);
  if (!historyLoading && initialScrollAtEndRef.current === null) {
    initialScrollAtEndRef.current = visibleMessages.length > 0;
  }
  const [replyFocus, setReplyFocus] = useState<ReplyRef | null>(null);
  const [reportRef, setReportRef] = useState<AgentReplyRef | null>(null);
  const closeReplyFocus = useCallback(() => setReplyFocus(null), []);
  const closeReport = useCallback(() => setReportRef(null), []);
  useEffect(() => {
    setReplyFocus(null);
    setReportRef(null);
  }, [conversationId]);
  const contextStatusFor = useCallback(
    (
      contexts: MobileReplyContexts,
      ref: ReplyRef | undefined,
    ): ReplyAgentStatus | undefined =>
      ref?.kind === "agent"
        ? contexts.agentStates.get(ref.threadId)
        : undefined,
    [],
  );
  const lastMessage = visibleMessages[visibleMessages.length - 1];
  const scroll = useChatScroll(
    listTrailingSlackPx,
    lastMessage?.id ?? null,
    topInset,
  );

  const [unread, setUnread] = useState(false);
  const prevLenRef = useRef(0);
  const sawTurnRef = useRef(false);
  const spokenAssistantIdsRef = useRef<Set<string>>(new Set());
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  /** Head of the rendered window, so a prepend can be told from an arrival. */
  const headMessageIdRef = useRef<string | null>(null);
  headMessageIdRef.current = markPrependedMessagesSeen(
    seenMessageIdsRef.current,
    visibleMessages,
    headMessageIdRef.current,
  );

  if (lastMessage?.role === "assistant") {
    const isNewAssistant = lastMessage.id !== assistantIdRef.current;
    const grewText = lastMessage.text.length > assistantTextLenRef.current;
    if (isNewAssistant) {
      scroll.resetAssistantAutoScroll();
    }
    // Only engage the animated catch-up while a reply is actively streaming
    // (or pending, for the computer chat). Without this gate, hydrating saved
    // history on tab mount looks like a fresh assistant message with huge
    // "growth" (baseline=0 before the list lays out), and the follow loop
    // animates a ~400px scroll on top of the initial scrollToEnd — the chat
    // visibly readjusts every time the user switches to the tab.
    if (streaming && (isNewAssistant || grewText)) {
      scroll.prepareAssistantLayoutFollow();
    }
    assistantTextLenRef.current = lastMessage.text.length;
    assistantIdRef.current = lastMessage.id;
  } else {
    assistantTextLenRef.current = 0;
    assistantIdRef.current = null;
  }

  // Assistant identity changes reset its measurements above. A busy-state
  // transition alone must not cancel the in-flight post-send placement.

  // A send records its intent here and fires the nudge on the render where
  // the submitted row has reached the list. The keyboard no longer changes
  // the list's insets, so the dismissal that follows a send cannot skew it.
  const pendingSendNudgeRef = useRef<{
    userMessageId: string;
  } | null>(null);
  useEffect(() => {
    const pending = pendingSendNudgeRef.current;
    if (!pending) return;
    // onSubmit can return before its optimistic row reaches this list. Starting
    // placement against the previous tail discards the anchor before onLayout.
    if (
      !canStartPostSendPlacement(
        pending.userMessageId,
        visibleMessages.map((message) => message.id),
        0,
      )
    )
      return;
    pendingSendNudgeRef.current = null;
    scroll.nudgeAfterSend(pending.userMessageId);
  }, [visibleMessages, scroll.nudgeAfterSend]);

  // LegendList's `dataChange` auto-pin fires on the optimistic send append —
  // `streaming` is often still false at that render (always for a placed
  // dispatch) — and scrolls to the literal content end, fighting the custom
  // post-send nudge that owns the tail. Suppress it while a send-nudge is in
  // flight; streaming or the next appended row releases this identity latch.
  const [sendPinSuppressForId, setSendPinSuppressForId] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (!sendPinSuppressForId) return;
    if (streaming || lastMessage?.id !== sendPinSuppressForId) {
      setSendPinSuppressForId(null);
    }
  }, [sendPinSuppressForId, streaming, lastMessage?.id]);

  const dataChangeScrollOwner = resolveChatDataChangeScrollOwner({
    isFollowingLatest: scroll.isFollowingLatest,
    isStreaming: streaming,
    postSendPlacementPending: sendPinSuppressForId !== null,
  });
  const scrollOwnerRef = useRef(dataChangeScrollOwner);
  scrollOwnerRef.current = dataChangeScrollOwner;
  const historyAnchored = dataChangeScrollOwner === "history-anchor";
  const maintainVisibleContentPosition = useMemo(
    () => ({
      // Keep native MVCP enabled for the lifetime of the ScrollView. Toggling
      // it during a drag lets iOS adjust from a stale pre-send native anchor.
      // `data` is what holds that guarantee: Legend derives the ScrollView's
      // own `maintainVisibleContentPosition` from `data || size`, so the
      // native prop stays on no matter how `size` moves below.
      data: true,
      // An older page is laid out from estimated heights and then measures
      // for real. Those re-measurements are *size* changes, not data changes,
      // and Legend only compensates the axis that is enabled — so with `size`
      // off, every older row that measured taller than its estimate shoved
      // the content under the user's finger. That is the jagged scrollback.
      // Compensate while history owns position, and only then: at the live
      // tail the custom follow loop owns streaming growth and must not be
      // fought by a second position owner.
      size: historyAnchored,
      shouldRestorePosition: () => scrollOwnerRef.current === "history-anchor",
    }),
    [historyAnchored],
  );
  useEffect(() => {
    const grew = visibleMessages.length > prevLenRef.current;
    prevLenRef.current = visibleMessages.length;
    if (visibleMessages.length === 0) {
      setUnread(false);
      return;
    }
    if (grew && scroll.awayFromBottom) setUnread(true);
  }, [visibleMessages.length, scroll.awayFromBottom]);

  useEffect(() => {
    if (!scroll.awayFromBottom) setUnread(false);
  }, [scroll.awayFromBottom]);

  // Read aloud now fires when the assistant MESSAGE arrives rather than on the
  // falling edge of a stream: there is no stream to end. `sawTurnRef` keeps the
  // original behaviour's boundary — only a reply produced by a turn this pane
  // watched is spoken, never a transcript restored from history or pulled by a
  // background sync. It is armed while a turn is in flight and consumed by the
  // first assistant text that lands after it.
  useEffect(() => {
    if (!readAloud.enabled) {
      // Drop the latch, or a turn that landed while read-aloud was off would
      // speak a stale reply the moment the preference is re-enabled.
      sawTurnRef.current = false;
      return;
    }
    if (streaming && !sawTurnRef.current) {
      // Rising edge of a turn: every reply already on screen predates it, so
      // mark them handled. Only a message that lands from here on is eligible,
      // which is what the old stream-end latch effectively guaranteed.
      for (const message of visibleMessages) {
        if (message.role === "assistant" && message.text.trim()) {
          spokenAssistantIdsRef.current.add(message.id);
        }
      }
      sawTurnRef.current = true;
    }
    if (!sawTurnRef.current) return;
    const latestAssistant = [...visibleMessages]
      .reverse()
      .find((message) => message.role === "assistant" && message.text.trim());
    if (
      !latestAssistant ||
      spokenAssistantIdsRef.current.has(latestAssistant.id)
    ) {
      return;
    }
    // A landed message consumes the latch: a multi-segment turn speaks its
    // first segment as it arrives, exactly as the old stream-end latch spoke
    // the one reply the turn produced.
    sawTurnRef.current = false;
    spokenAssistantIdsRef.current.add(latestAssistant.id);
    void speakReply(latestAssistant.text, latestAssistant.id);
  }, [visibleMessages, readAloud.enabled, streaming]);

  const [realtimeVoiceOpen, setRealtimeVoiceOpen] = useState(false);
  const [voiceEnabled, setVoiceEnabledLocal] = useState(() =>
    getVoiceEnabled(),
  );
  useEffect(() => subscribeVoiceEnabled(setVoiceEnabledLocal), []);
  useEffect(() => {
    if (!voiceEnabled) setRealtimeVoiceOpen(false);
  }, [voiceEnabled]);

  // Derived draft flags: these re-render the pane only when they flip, not on
  // every keystroke.
  const draftEmpty = useChatDraftSelector(draftStore, isDraftEmpty);
  const hasText = useChatDraftSelector(draftStore, draftHasText);

  const submit = useCallback(() => {
    tapMedium();
    const shouldPlaceLatestTurn = scroll.getShouldPlaceLatestTurn();
    const submitted = onSubmit();
    if (submitted && shouldPlaceLatestTurn) {
      setSendPinSuppressForId(submitted.userMessageId);
      // Always start from the committed message list, even with no keyboard.
      pendingSendNudgeRef.current = {
        userMessageId: submitted.userMessageId,
      };
    } else if (submitted) {
      scroll.releaseFollow();
    }
    Keyboard.dismiss();
  }, [
    onSubmit,
    scroll.getShouldPlaceLatestTurn,
    scroll.nudgeAfterSend,
    scroll.releaseFollow,
  ]);

  const dictationHeadersMemo = useMemo(
    () => dictationHeaders,
    // We trust the parent to memoize these.
    [dictationHeaders],
  );

  // Auto-send-after-dictation coordination (see `stopAndSendVoice` below).
  // When a voice-send is armed we stash the exact draft the transcript produces
  // so the send effect can wait for the draft state to actually reflect it,
  // rather than racing the (separately-committed) status → idle update.
  const pendingVoiceSendRef = useRef(false);
  const voiceSendTargetRef = useRef<string | null>(null);
  const voiceSendResultReadyRef = useRef(false);
  const [voiceSendResultVersion, setVoiceSendResultVersion] = useState(0);

  const appendTranscript = useCallback(
    (text: string) => {
      // The store is read synchronously, so a transcription chunk always
      // appends to the latest text.
      const trimmedPrev = draftStore.get().trimEnd();
      const next = trimmedPrev ? `${trimmedPrev} ${text}` : text;
      if (pendingVoiceSendRef.current) voiceSendTargetRef.current = next;
      draftStore.set(next);
    },
    [draftStore],
  );

  const dictation = useDictation({
    anonymous: dictationAnonymous,
    headers: dictationHeadersMemo,
    onTranscript: appendTranscript,
  });

  // The hook returns a fresh object each render; its callbacks are stable, so
  // handlers depend on them (not the object) to keep the memoized composer's
  // props steady.
  const {
    status: dictationStatus,
    start: startDictation,
    stop: stopDictation,
    cancel: cancelDictation,
    toggle: toggleDictation,
  } = dictation;
  const isListening = dictation.isRecording;
  // Dictation flips the shell between pill and expanded shapes from inside
  // the hook, so configure the spring on the render that carries the flip.
  const wasListeningRef = useRef(isListening);
  if (wasListeningRef.current !== isListening) {
    wasListeningRef.current = isListening;
    LayoutAnimation.configureNext(LAYOUT_SPRING);
  }

  const toggleVoice = useCallback(async () => {
    if (dictationStatus === "idle") {
      // No tap here: `useDictation` fires on the real transition, once the
      // mic is actually live. Buzzing on the press as well double-tapped the
      // start and lied whenever consent or the mic permission refused.
      // In-flight progressive TTS can otherwise apply Expo's playback audio
      // mode after recording starts. On iOS that mode stops every recorder.
      await startAfterStoppingReadAloud(() => startDictation());
      return;
    }
    await toggleDictation();
  }, [dictationStatus, startDictation, toggleDictation]);
  const cancelDictationInput = useCallback(
    () => void cancelDictation(),
    [cancelDictation],
  );
  const confirmDictationInput = useCallback(
    () => void stopDictation(),
    [stopDictation],
  );

  const realtimeVoiceOpeningRef = useRef(false);
  const openRealtimeVoice = useCallback(async () => {
    if (!getVoiceEnabled()) return;
    if (!realtimeVoiceSignInRequired && !hasAiConsent()) {
      requestAiConsent();
      return;
    }
    if (realtimeVoiceOpeningRef.current) return;
    realtimeVoiceOpeningRef.current = true;
    tapMedium();
    try {
      // Resolve microphone access before the voice screen exists. The system
      // prompt suspends the app (Android reports it as `background`), which
      // used to close a voice screen that had only just opened. An already
      // granted permission resolves silently and never shows a prompt.
      const permission = realtimeVoiceSignInRequired
        ? ({ granted: true } as const)
        : await ensureMicrophonePermission();
      if (!permission.granted) {
        Alert.alert(
          "Microphone access needed",
          permission.canAskAgain
            ? "Stella needs access to your microphone for realtime voice. You can allow it the next time the system asks."
            : "Stella needs access to your microphone for realtime voice. Turn it on in Settings → Stella → Microphone.",
          permission.canAskAgain
            ? [{ text: "OK", style: "default" }]
            : [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Open Settings",
                  style: "default",
                  onPress: () => {
                    void Linking.openSettings();
                  },
                },
              ],
        );
        return;
      }
      stopReadAloud();
      Keyboard.dismiss();
      setRealtimeVoiceOpen(true);
    } finally {
      realtimeVoiceOpeningRef.current = false;
    }
  }, [realtimeVoiceSignInRequired]);

  const performRealtimeVoiceAction = useCallback(
    async (request: string) =>
      onRealtimeVoiceAction ? onRealtimeVoiceAction(request) : null,
    [onRealtimeVoiceAction],
  );

  // "Stop dictation and send": stop recording, then auto-submit once the
  // transcript has landed in the draft. `dictation.stop()` resolves after the
  // round-trip, but `onTranscript` updates the draft through the parent, so we
  // can't read it back synchronously here. Arm a flag and let the effect below
  // fire submit on the render where the transcript has committed and dictation
  // has returned to idle.
  const stopAndSendVoice = useCallback(() => {
    if (pendingVoiceSendRef.current) return;
    pendingVoiceSendRef.current = true;
    voiceSendTargetRef.current = null;
    voiceSendResultReadyRef.current = false;
    void stopDictation()
      .then((transcript) => {
        if (!pendingVoiceSendRef.current) return;
        // Never send a stale typed prefix when recording/transcription failed.
        if (transcript && voiceSendTargetRef.current !== null) {
          voiceSendResultReadyRef.current = true;
          // The transcript callback updates parent-owned draft state. Force one
          // render after stop() has fully resolved so the effect can verify that
          // exact target was committed before calling submit.
          setVoiceSendResultVersion((version) => version + 1);
          return;
        }
        pendingVoiceSendRef.current = false;
        voiceSendTargetRef.current = null;
      })
      .catch(() => {
        pendingVoiceSendRef.current = false;
        voiceSendTargetRef.current = null;
      });
  }, [stopDictation]);

  useEffect(() => {
    const target = voiceSendTargetRef.current;
    if (
      !canSubmitFinalizedDictation({
        armed: pendingVoiceSendRef.current,
        resultReady: voiceSendResultReadyRef.current,
        status: dictation.status,
        draft: draftStore.get(),
        target,
        attachmentCount: attachments?.length ?? 0,
      })
    ) {
      return;
    }
    pendingVoiceSendRef.current = false;
    voiceSendResultReadyRef.current = false;
    voiceSendTargetRef.current = null;
    submit();
  }, [
    dictation.status,
    draftStore,
    attachments,
    submit,
    voiceSendResultVersion,
  ]);

  const attachmentLimit = maxAttachments ?? CHAT_ATTACHMENT_MAX_COUNT;
  const acceptPicked = useCallback(
    (picked: readonly PickedAttachment[]) => {
      if (!onAddAttachments || picked.length === 0) return;
      tapLight();
      const { rejected } = onAddAttachments(picked);
      if (rejected > 0) {
        Alert.alert(
          t("chat.attachments.tooManyTitle"),
          t("chat.attachments.tooManyBody", { count: attachmentLimit }),
        );
      }
    },
    [attachmentLimit, onAddAttachments, t],
  );

  const imagePickAsAttachment = useCallback(
    (asset: ImagePicker.ImagePickerAsset): PickedAttachment => ({
      id: asset.assetId ?? asset.uri,
      uri: asset.uri,
      name: driveFileNameFor(asset.fileName ?? asset.uri, "image"),
      mimeType: asset.mimeType ?? "image/jpeg",
      sizeBytes: asset.fileSize ?? 0,
      kind: "image",
    }),
    [],
  );

  const pickImage = useCallback(async () => {
    if (!enableAttachments || !onAddAttachments) return;
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        t("chat.attachments.photosDeniedTitle"),
        t("chat.attachments.photosDeniedBody"),
      );
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      quality: 0.75,
      selectionLimit: attachmentLimit,
      // HEIC bypasses the picker's `quality` JPEG re-encode (raw bytes pass
      // through), and desktop model providers can't decode HEIC. Ask PhotoKit
      // for the most compatible representation so library picks arrive as
      // JPEG at the picker level.
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
    });
    if (!result.canceled) {
      acceptPicked(result.assets.map(imagePickAsAttachment));
    }
  }, [
    acceptPicked,
    attachmentLimit,
    enableAttachments,
    imagePickAsAttachment,
    onAddAttachments,
    t,
  ]);

  const takePhoto = useCallback(async () => {
    if (!enableAttachments || !onAddAttachments) return;
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        t("chat.attachments.cameraDeniedTitle"),
        t("chat.attachments.cameraDeniedBody"),
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 0.75,
    });
    if (!result.canceled) {
      acceptPicked(result.assets.map(imagePickAsAttachment));
    }
  }, [
    acceptPicked,
    enableAttachments,
    imagePickAsAttachment,
    onAddAttachments,
    t,
  ]);

  const pickDocument = useCallback(async () => {
    if (!enableAttachments || !onAddAttachments) return;
    const result = await DocumentPicker.getDocumentAsync({
      multiple: true,
      // Copied into the app's cache so the URI stays readable after the
      // picker's security-scoped access is released.
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    acceptPicked(
      result.assets.map((asset) => {
        const mimeType = asset.mimeType ?? "application/octet-stream";
        const kind = mimeType.startsWith("image/") ? "image" : "file";
        return {
          id: asset.uri,
          uri: asset.uri,
          name: driveFileNameFor(asset.name, kind),
          mimeType,
          sizeBytes: asset.size ?? 0,
          kind,
        };
      }),
    );
  }, [acceptPicked, enableAttachments, onAddAttachments]);

  // Root the in-tree menu overlays measure against (see PlusMenuPopover).
  const rootRef = useRef<View>(null);
  const modelPickerAnchorRef = useRef<View>(null);
  const [addSheetOpen, setAddSheetOpen] = useState(false);
  // The picker a sheet choice asked for; it opens once the sheet is gone,
  // since iOS won't present a picker over a sheet that is still leaving.
  const afterAddSheetRef = useRef<(() => void) | null>(null);
  const [modelPickerAnchor, setModelPickerAnchor] = useState<AnchorRect | null>(
    null,
  );

  const chooseFromAddSheet = useCallback((action: () => void) => {
    afterAddSheetRef.current = action;
    setAddSheetOpen(false);
  }, []);
  const onAddSheetDismissed = useCallback(() => {
    const action = afterAddSheetRef.current;
    afterAddSheetRef.current = null;
    action?.();
  }, []);

  // Debounced catch-up indicator (show delay + minimum visible time), so
  // instant no-op pulls on every tab return never flash the pill.
  const catchUpVisible = useCatchUpIndicatorVisible(catchingUp);

  // Discard a previous conversation's gesture even if this pane stays mounted.
  const historyPaging = useMemo(
    () => new ChatHistoryPaging(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversationId],
  );
  const requestHistoryNearPosition = useCallback(
    ({ contentOffset, contentSize, layoutMeasurement }: NativeScrollEvent) => {
      const page = historyPaging.takePage({
        offsetY: contentOffset.y,
        contentHeight: contentSize.height,
        layoutHeight: layoutMeasurement.height,
        hasOlder: hasOlderHistory && Boolean(onLoadOlderHistory),
        hasNewer: hasNewerHistory && Boolean(onLoadNewerHistory),
        loading: historyPageLoading,
      });
      if (page === "older") void onLoadOlderHistory?.();
      if (page === "newer") void onLoadNewerHistory?.();
    },
    [
      historyPaging,
      hasOlderHistory,
      hasNewerHistory,
      historyPageLoading,
      onLoadOlderHistory,
      onLoadNewerHistory,
    ],
  );
  const handleListScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      scroll.onScroll(e);
      requestHistoryNearPosition(e.nativeEvent);
    },
    [scroll.onScroll, requestHistoryNearPosition],
  );
  const handleListScrollSettle = scroll.onScrollSettle;
  const handleListContentSizeChange = scroll.onListContentSizeChange;

  const onPressPlus = useCallback(() => {
    tapLight();
    Keyboard.dismiss();
    setAddSheetOpen(true);
  }, []);

  const modelPickerOptions = useMemo<PlusMenuOption[]>(() => {
    if (!composerModelPicker?.pinned) return [];
    const disabled = Boolean(
      composerModelPicker.loading || composerModelPicker.saving,
    );
    // No effort options means the selection's effort is backend-owned
    // (Stella-managed models), so the thinking entry is hidden entirely.
    const thinkingOptions: PlusMenuOption[] =
      composerModelPicker.effortOptions.length === 0
        ? []
        : [
            {
              id: "model-thinking",
              label: t("app.chat.miniModelPicker.reasoningEffortLabel"),
              icon: "sparkles",
              trailingLabel: composerModelPicker.effortLabel,
              disabled: composerModelPicker.loading,
              submenuTitle: t("app.chat.miniModelPicker.reasoningEffortLabel"),
              submenu: composerModelPicker.effortOptions.map((effort) => ({
                id: `model-effort-${effort.id}`,
                label: effort.label,
                icon: "sparkles",
                selected: effort.selected,
                disabled,
                onSelect: () => composerModelPicker.onSelectEffort(effort.id),
              })),
              onSelect: () => undefined,
            },
          ];
    const options: PlusMenuOption[] = [
      ...thinkingOptions,
      ...composerModelPicker.recentModels.map((model) => ({
        id: `model-recent-${model.id}`,
        label: model.label,
        icon: "cpu" as const,
        selected: model.selected,
        disabled: disabled || model.selected,
        onSelect: () => composerModelPicker.onSelectModel(model.id),
      })),
    ];
    return options;
  }, [composerModelPicker, t]);

  const onPressModelPicker = useCallback(() => {
    if (!composerModelPicker?.pinned || !modelPickerAnchorRef.current) return;
    tapLight();
    composerModelPicker.onOpen();
    const measureAnchor = () => {
      modelPickerAnchorRef.current?.measureInWindow((x, y, width, height) => {
        setModelPickerAnchor({ x, y, width, height });
      });
    };
    if (Keyboard.isVisible()) {
      const sub = Keyboard.addListener("keyboardDidHide", () => {
        sub.remove();
        measureAnchor();
      });
      Keyboard.dismiss();
    } else {
      measureAnchor();
    }
  }, [composerModelPicker]);

  const dismissModelPicker = useCallback(() => setModelPickerAnchor(null), []);

  // Long-press message actions — a popover anchored at the touch point so it
  // matches the app's menu language instead of a native sheet takeover.
  const [messageMenu, setMessageMenu] = useState<MessageMenuRequest | null>(
    null,
  );
  // The message currently in "Select text" mode (id), entered from the menu's
  // Select text action. At most one row selects at a time.
  const [selectingMessageId, setSelectingMessageId] = useState<string | null>(
    null,
  );
  const startSelectingMessage = useCallback((id: string) => {
    setSelectingMessageId(id);
  }, []);
  const stopSelectingMessage = useCallback(() => {
    setSelectingMessageId(null);
  }, []);
  const dismissMessageMenu = useCallback(() => {
    setMessageMenu(null);
  }, []);

  // "Quote" a message: drop it into the composer as a removable quote chip (so
  // the input isn't stuffed with the paragraph), then focus so the reply is
  // typed alongside it. On send the chip folds back in as a blockquote (see
  // `useChatThread`). Falls back to inline blockquote text if the surface didn't
  // wire quote state.
  const quoteMessage = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (onAddQuote) {
        onAddQuote(trimmed);
      } else {
        const quoted = quoteMessageText(trimmed);
        const current = draftStore.get();
        draftStore.set(
          current.trim() ? `${quoted}\n\n${current}` : `${quoted}\n\n`,
        );
      }
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [draftStore, onAddQuote],
  );

  // The long-press menu, the same for both speakers (iOS Messages order).
  // Each action fires a light tap; the open itself is a medium tap in
  // ChatMessageRow.openMenu.
  const messageMenuActions = useMemo<MessageMenuAction[]>(() => {
    if (!messageMenu) return [];
    const message = messageMenu.message;
    const text = message.text;
    if (!text.trim()) return [];
    return [
      {
        id: "reply",
        label: "Reply",
        icon: "reply",
        onSelect: () => {
          tapLight();
          quoteMessage(text);
        },
      },
      {
        id: "copy",
        label: "Copy",
        icon: "copy",
        onSelect: () => {
          tapLight();
          copyMessageText(text);
        },
      },
      {
        id: "select",
        label: "Select",
        icon: "select",
        onSelect: () => {
          tapLight();
          startSelectingMessage(message.id);
        },
      },
      {
        id: "share",
        label: "Share",
        icon: "share",
        onSelect: () => {
          tapLight();
          shareMessageText(text);
        },
      },
      ...(message.role === "assistant"
        ? [speakAloudMenuAction(text, message.id)]
        : []),
    ];
  }, [messageMenu, quoteMessage, startSelectingMessage]);

  // The list's handlers are stable so a composer keystroke — which re-renders
  // this pane — leaves the memoized LegendList (and its rows) alone.
  const selectingMessageIdRef = useRef<string | null>(null);
  selectingMessageIdRef.current = selectingMessageId;
  // A quick tap anywhere in the transcript leaves Select mode. The selection
  // field never raises a keyboard, so the list's tap-to-dismiss never blurs
  // it; drags (moving the selection handles) are left alone.
  const viewportTouchRef = useRef<{ x: number; y: number; at: number } | null>(
    null,
  );
  const handleViewportTouchStart = useCallback((e: GestureResponderEvent) => {
    if (selectingMessageIdRef.current == null) return;
    const { pageX, pageY } = e.nativeEvent;
    viewportTouchRef.current = { x: pageX, y: pageY, at: Date.now() };
  }, []);
  const handleViewportTouchEnd = useCallback(
    (e: GestureResponderEvent) => {
      const start = viewportTouchRef.current;
      viewportTouchRef.current = null;
      if (!start || selectingMessageIdRef.current == null) return;
      const { pageX, pageY } = e.nativeEvent;
      const moved = Math.hypot(pageX - start.x, pageY - start.y);
      if (moved < 8 && Date.now() - start.at < 350) stopSelectingMessage();
    },
    [stopSelectingMessage],
  );
  const handleListScrollBeginDrag = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      // Scrolling the transcript exits any active text selection before the
      // drag runs.
      if (selectingMessageIdRef.current != null) stopSelectingMessage();
      pendingSendNudgeRef.current = null;
      scroll.onScrollBeginDrag();
      historyPaging.beginDrag();
      // A short page may already be at the boundary and never cross a list
      // threshold. The drag itself requests one page.
      requestHistoryNearPosition(e.nativeEvent);
    },
    [
      historyPaging,
      requestHistoryNearPosition,
      scroll.onScrollBeginDrag,
      stopSelectingMessage,
    ],
  );
  const handleListScrollEndDrag = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      historyPaging.endDrag(e.nativeEvent.velocity?.y);
      handleListScrollSettle();
    },
    [handleListScrollSettle, historyPaging],
  );
  const handleListMomentumScrollBegin = useCallback(
    () => historyPaging.beginMomentum(),
    [historyPaging],
  );
  const handleListMomentumScrollEnd = useCallback(() => {
    historyPaging.endScroll();
    handleListScrollSettle();
  }, [handleListScrollSettle, historyPaging]);

  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);
  // The in-flight turn's reply row: appended empty on dispatch, then grown by
  // whole message segments. It owns the autoscroll follow so a landing message
  // scrolls itself into view; nothing else about it is per-row state now that
  // text arrives complete.
  const activeAssistantId =
    streaming && lastMessage?.role === "assistant" ? lastMessage.id : null;
  const latestUserMessageId =
    lastMessage?.role === "user" ? lastMessage.id : null;
  useEffect(() => {
    if (!activeAssistantId) {
      scroll.clearActiveAssistantLayout();
    }
  }, [activeAssistantId, scroll.clearActiveAssistantLayout]);

  const activeMenuMessageId = messageMenu?.message.id ?? null;
  // iMessage time labels: a centered time after a long quiet gap, and a read
  // receipt under the latest message once the model has it.
  const timeHeaders = useMemo(
    () => timestampHeaders(visibleMessages),
    [visibleMessages],
  );
  const receipt = useMemo(
    () => readReceipt(visibleMessages),
    [visibleMessages],
  );
  // Tapped `stella://file/<path>` links in assistant markdown resolve into
  // the same artifact shape inline cards carry, then open the same viewer.
  const onOpenStellaFile = useMemo(
    () =>
      onOpenArtifact
        ? (path: string, gallery?: readonly string[]) =>
            onOpenArtifact(
              stellaFileChatArtifact(path, conversationId ?? ""),
              gallery?.map((entry) =>
                stellaFileChatArtifact(entry, conversationId ?? ""),
              ),
            )
        : undefined,
    [onOpenArtifact, conversationId],
  );
  // The scroll owner's layout handlers change with the reserved bottom inset
  // (keyboard, composer height). Route rows through stable forwarders so those
  // changes do not invalidate every mounted row.
  const scrollLayoutRef = useRef(scroll);
  scrollLayoutRef.current = scroll;
  const onActiveAssistantLayout = useCallback(
    (event: LayoutChangeEvent) =>
      scrollLayoutRef.current.onActiveAssistantLayout(event),
    [],
  );
  const onLatestUserLayout = useCallback(
    (id: string, event: LayoutChangeEvent) =>
      scrollLayoutRef.current.onLatestUserLayout(id, event),
    [],
  );
  // One handler object for every row (transcript and focused chain), so a
  // row's memo compares a single stable reference.
  const rowStyles = useMemo(() => makeMessageRowStyles(colors), [colors]);
  const rowActions = useMemo<MessageRowActions>(
    () => ({
      onOpenArtifact,
      onOpenStellaFile,
      onOpenMessageMenu: setMessageMenu,
      onEndSelecting: stopSelectingMessage,
      onAskStella: quoteMessage,
      onOpenAgentActivity: onOpenActivity,
      onOpenReply: setReplyFocus,
      onOpenReport: setReportRef,
    }),
    [
      onOpenArtifact,
      onOpenStellaFile,
      stopSelectingMessage,
      quoteMessage,
      onOpenActivity,
    ],
  );
  // The long-press menu's lifted copy is inert: no file, reply or report taps.
  const menuCloneRowActions = useMemo<MessageRowActions>(
    () => ({
      onOpenMessageMenu: setMessageMenu,
      onEndSelecting: stopSelectingMessage,
      onAskStella: quoteMessage,
    }),
    [stopSelectingMessage, quoteMessage],
  );
  const renderItem = useCallback(
    ({ item }: LegendListRenderItemProps<ChatMessage>) => {
      const isActiveAssistant = item.id === activeAssistantId;
      const isLatestUser = item.id === latestUserMessageId;
      const animate = shouldAnimateMessageEntry(
        seenMessageIdsRef.current,
        item.id,
      );
      return (
        <MessageEntry
          key={item.id}
          animate={animate && item.role !== "assistant"}
          onLayout={
            isActiveAssistant
              ? onActiveAssistantLayout
              : isLatestUser
                ? (event) => onLatestUserLayout(item.id, event)
                : undefined
          }
        >
          {timeHeaders.has(item.id) ? (
            <Text
              style={styles.timestampHeader}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              {formatTimestampHeader(timeHeaders.get(item.id)!)}
            </Text>
          ) : null}
          <ChatMessageRow
            item={item}
            conversationId={conversationId ?? ""}
            animate={animate && item.id === lastMessage?.id && !historyLoading}
            styles={rowStyles}
            colors={colors}
            menuActive={item.id === activeMenuMessageId}
            isSelecting={item.id === selectingMessageId}
            anySelecting={selectingMessageId != null}
            actions={rowActions}
            contextRef={replyContexts.contexts.get(item.id)}
            contextStatus={contextStatusFor(
              replyContexts,
              replyContexts.contexts.get(item.id),
            )}
            desktopAccess={desktopAccess}
            receiptLabel={receipt?.id === item.id ? receipt.label : null}
            carriedQuotes={quoteCarry.carried.get(item.id)}
            quotesForwarded={quoteCarry.forwarded.has(item.id)}
          />
        </MessageEntry>
      );
    },
    [
      timeHeaders,
      receipt,
      replyContexts,
      quoteCarry,
      contextStatusFor,
      lastMessage?.id,
      historyLoading,
      styles,
      rowStyles,
      colors,
      rowActions,
      latestUserMessageId,
      onLatestUserLayout,
      onActiveAssistantLayout,
      activeAssistantId,
      activeMenuMessageId,
      selectingMessageId,
      desktopAccess,
      conversationId,
    ],
  );
  // Legend re-renders a mounted row only when its item or `extraData`
  // changes, never when `renderItem` does. Everything a row closes over —
  // focus and selection, the palette (native attributed text needs new
  // colors), reply quotes and "N replies" counts that change when *other*
  // messages land, the latest-turn layout wiring, paired-computer access —
  // is a `renderItem` dependency, so its identity is the invalidation key.
  // Rows whose props did not change still bail out in `ChatMessageRow`'s memo.
  const listExtraData = renderItem;
  const renderSeparator = useCallback(
    () => <View style={styles.itemSeparator} />,
    [styles],
  );
  const getItemType = useCallback((item: ChatMessage) => item.role, []);

  // The working indicator rides at the tail of the chat (desktop-style) instead
  // of floating above the composer. It keeps a stable slot, so fading it in or
  // out never changes the footer's height.
  const listFooter = useMemo(
    () => (
      <View style={styles.chatTail}>
        <WorkingIndicator
          active={workingIndicator?.active ?? streaming}
          exitImmediately={workingIndicator?.exitImmediately}
          status={workingIndicator?.status}
          toolName={workingIndicator?.toolName}
          toolCallId={workingIndicator?.toolCallId}
        />
      </View>
    ),
    [streaming, workingIndicator, styles.chatTail],
  );

  // Search shows a separate results menu that overlays the chat (the chat
  // itself is never filtered). Matches are listed newest-first; tapping one
  // jumps to that message in the conversation.
  const search = useChatSearch();
  const searchOpen = search.isOpen;
  const searchQuery = search.query.trim();
  const searchActive = searchQuery.length > 0;
  const searchResults = useChatSearchResults(
    visibleMessages,
    searchOpen,
    searchQuery,
  );

  const jumpToMessage = useCallback(
    (index: number) => {
      search.close();
      // Let the results overlay unmount before scrolling the list underneath.
      setTimeout(() => {
        scroll.listRef.current?.scrollToIndex({
          index,
          animated: true,
          viewOffset: topInset,
        });
      }, 60);
    },
    [search, scroll.listRef, topInset],
  );

  const empty = visibleMessages.length === 0;
  const composerHasContent =
    !draftEmpty || (attachments?.length ?? 0) > 0 || (quotes?.length ?? 0) > 0;
  const canSubmit =
    sendReady &&
    (hasText || (attachments?.length ?? 0) > 0 || (quotes?.length ?? 0) > 0);
  const dictationInline = isListening && !hasText;

  useEffect(() => {
    if (!composerModelPicker?.pinned || dictationInline) {
      setModelPickerAnchor(null);
    }
  }, [composerModelPicker?.pinned, dictationInline]);

  // Realtime voice sits beside the mic only while the composer is empty.
  const showRealtimeVoice = Boolean(
    voiceEnabled &&
      realtimeVoiceConversationId &&
      (onRealtimeVoiceAction || realtimeVoiceDesktopAccess) &&
      composerEnabled &&
      !offline &&
      !composerHasContent &&
      dictationStatus === "idle",
  );
  // Focusing the composer (keyboard opening) exits any active message text
  // selection. Reads the ref so the memoized composer keeps one handler.
  const onComposerFocus = useCallback(() => {
    if (selectingMessageIdRef.current != null) stopSelectingMessage();
  }, [stopSelectingMessage]);

  const listContentContainerStyle = useMemo(
    () => [
      styles.list,
      { paddingTop: topInset + LIST_TOP_GAP, paddingBottom: listBottomInsetPx },
    ],
    [styles.list, listBottomInsetPx, topInset],
  );
  const emptyStateStyle = useMemo(
    () => [styles.emptyState, { paddingTop: topInset }],
    [styles.emptyState, topInset],
  );
  // The transcript runs under the top bar. The fade holds the backdrop solid
  // behind the status bar and thins it across the bar, so rows passing under
  // the controls dim instead of colliding with them. Built once per geometry:
  // the backdrop mask would otherwise re-render with every composer keystroke.
  const taperHeight = topInset + TOP_TAPER_TAIL;
  const taperSolidStop =
    topInset > 0 ? Math.min(1, safeAreaTop / taperHeight) : 0;
  const taperBackdropOffset = shellTopInset - topInset;
  const topTaper = useMemo(
    () => (
      <View
        style={[styles.topTaper, { height: taperHeight }]}
        pointerEvents="none"
        collapsable={false}
      >
        <MaskedView
          style={StyleSheet.absoluteFill}
          maskElement={
            <LinearGradient
              colors={["#000", "#000", "rgba(0,0,0,0)"]}
              locations={[0, taperSolidStop, 1]}
              style={StyleSheet.absoluteFill}
            />
          }
        >
          <View
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: -taperBackdropOffset,
              height: screenHeight,
            }}
          >
            <AppBackdrop />
          </View>
        </MaskedView>
      </View>
    ),
    [
      screenHeight,
      styles.topTaper,
      taperBackdropOffset,
      taperHeight,
      taperSolidStop,
    ],
  );
  return (
    <View ref={rootRef} collapsable={false} style={styles.screen}>
      <View
        style={styles.viewport}
        onTouchStart={handleViewportTouchStart}
        onTouchEnd={handleViewportTouchEnd}
      >
        {historyLoading ? (
          // Hold a stable blank surface while history hydrates so the empty
          // state never flashes during a tab transition.
          <View style={emptyStateStyle} />
        ) : empty ? (
          <Pressable style={emptyStateStyle} onPress={() => Keyboard.dismiss()}>
            {emptyContent}
          </Pressable>
        ) : (
          <>
            <Reanimated.View style={[styles.messageList, listKeyboardStyle]}>
              <LegendList<ChatMessage>
                ref={scroll.listRef}
                pointerEvents={replyFocus ? "none" : "auto"}
                accessibilityElementsHidden={Boolean(replyFocus)}
                importantForAccessibility={
                  replyFocus ? "no-hide-descendants" : "auto"
                }
                style={styles.messageList}
                contentContainerStyle={listContentContainerStyle}
                data={visibleMessages}
                extraData={listExtraData}
                // Short transcript rows measure roughly 44–70 pt. Reserve
                // enough containers for those runs; measured heights still
                // determine layout for longer replies and artifacts.
                estimatedItemSize={64}
                renderItem={renderItem}
                keyExtractor={keyExtractor}
                getItemType={getItemType}
                ItemSeparatorComponent={renderSeparator}
                ListFooterComponent={listFooter}
                onScroll={handleListScroll}
                onScrollBeginDrag={handleListScrollBeginDrag}
                onScrollEndDrag={handleListScrollEndDrag}
                onMomentumScrollBegin={handleListMomentumScrollBegin}
                onMomentumScrollEnd={handleListMomentumScrollEnd}
                onContentSizeChange={handleListContentSizeChange}
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={false}
                keyboardDismissMode="on-drag"
                fadingEdgeLength={EDGE_FADE}
                // Open at the latest message every time the tab mounts, instead
                // of landing at the top of history. Short conversations that
                // don't fill the viewport read top-down (no `alignItemsAtEnd`)
                // so the first message sits at the top rather than the bottom.
                initialScrollAtEnd={initialScrollAtEndRef.current === true}
                // Keep the visible message anchored when the data array changes
                // (e.g. messages syncing in from the desktop) so the list never
                // snaps back to the top.
                maintainVisibleContentPosition={maintainVisibleContentPosition}
                // Pin to the tail only when new/synced messages arrive while the
                // user is already near the bottom. Scoped to data changes so it
                // doesn't fight the custom streaming-follow target updates,
                // which own item-layout/size growth.
                //
                // While streaming, every token mutates the data array, so a
                // dataChange-pinned tail would fire `scrollToEnd` on each token —
                // overriding the custom "freeze once the message reaches the top"
                // target and snapping the user back down whenever they try to
                // scroll up. The custom follow loop already keeps the tail in view
                // during streaming, so disable the built-in pin for that window.
                // Position ownership is exclusive: history anchoring wins while
                // follow is released, the custom loop owns streams/post-send
                // placement, and this pin owns only ordinary live-tail appends.
                maintainScrollAtEnd={
                  dataChangeScrollOwner === "legend-tail"
                    ? LEGEND_TAIL_SCROLL_AT_END
                    : false
                }
              />
            </Reanimated.View>
            {/* Top taper — fades the list into the surface at the top edge so
                messages scrolling under the top bar dissolve instead of
                hard-cutting. Cross-platform (RN `fadingEdgeLength` is
                Android-only). Paints the *actual* app backdrop (aligned to the
                screen via the top-bar offset) and masks it to a vertical fade,
                so it matches the soft gradient seamlessly instead of stamping a
                flat `colors.background` band over it. */}
            {/* Android's native MaskedView does not implement pointerEvents.
                Keep touch exclusion on a real RN View around the whole mask,
                including its screen-height backdrop child. */}
            {topTaper}
          </>
        )}
        {replyFocus && (
          <ReplyFocus
            key={`${conversationId}:${replyFocus.kind === "agent" ? replyFocus.threadId : replyFocus.id}`}
            topInset={topInset}
            bottomInset={footerHeight + keyboardExtra}
            root={replyFocus}
            messages={visibleMessages}
            colors={colors}
            onClose={closeReplyFocus}
            hasOlder={hasOlderHistory}
            onLoadOlder={onLoadOlderHistory}
            // Inside focus the chain is already open, so rows carry no reply
            // count; a quote still appears for a link to *other* work.
            renderMessage={(item, contexts) => (
              <ChatMessageRow
                item={item}
                conversationId={conversationId ?? ""}
                animate={false}
                styles={rowStyles}
                colors={colors}
                menuActive={false}
                isSelecting={false}
                anySelecting={false}
                actions={rowActions}
                carriedQuotes={quoteCarry.carried.get(item.id)}
                quotesForwarded={quoteCarry.forwarded.has(item.id)}
                contextRef={contexts.contexts.get(item.id)}
                contextStatus={contextStatusFor(
                  contexts,
                  contexts.contexts.get(item.id),
                )}
                desktopAccess={desktopAccess}
              />
            )}
          />
        )}
        {reportRef && conversationId ? (
          <AgentReportSheet
            key={reportRef.threadId}
            reference={reportRef}
            conversationId={conversationId}
            colors={colors}
            onClose={closeReport}
            topInset={topInset}
          />
        ) : null}
        {/* Floating glass controls (scroll-to-bottom FAB + computer-options
            button) sit in a pass-through absolute overlay. This MUST be a plain
            View, not a GlassGroup/GlassContainer: the native glass container is
            a raw view that ignores `pointerEvents`, so a full-screen one swallows
            every touch over the chat (no scroll/tap) and, as a screen-spanning
            glass layer beneath the in-tree menu popovers, triggers Apple's
            glass-on-glass suppression that renders those menus clear. A plain
            `box-none` View passes touches through to the list and lets each
            button — and the popovers — keep their own Liquid Glass. While a
            focused chain is open they hide: its glass backdrop would sit over
            them and, being glass over glass, render them clear. */}
        <View
          pointerEvents={replyFocus ? "none" : "box-none"}
          style={[
            StyleSheet.absoluteFill,
            replyFocus ? styles.hiddenWhileFocused : null,
          ]}
        >
          {!searchOpen ? (
            <CatchUpPill
              visible={catchUpVisible}
              top={topInset + CATCH_UP_PILL_GAP}
              colors={colors}
            />
          ) : null}
          {!historyLoading && !empty ? (
            <Reanimated.View
              pointerEvents="box-none"
              style={[StyleSheet.absoluteFill, listKeyboardStyle]}
            >
              <ScrollToBottomFab
                visible={scroll.awayFromBottom}
                hasUnread={unread}
                onPress={scroll.scrollToBottom}
                colors={colors}
                bottomOffset={footerHeight + FLOATING_CONTROL_LIFT - 24}
              />
            </Reanimated.View>
          ) : null}
        </View>
        {searchOpen && searchActive ? (
          <ChatSearchResults
            results={searchResults}
            query={searchQuery}
            topInset={topInset}
            colors={colors}
            onSelect={jumpToMessage}
          />
        ) : null}
      </View>

      <Reanimated.View
        style={[
          styles.footerOverlay,
          composerKeyboardStyle,
          searchOpen && styles.hiddenFooter,
        ]}
        onLayout={onFooterLayout}
        pointerEvents={searchOpen ? "none" : "box-none"}
      >
        {offline ? (
          <View style={styles.offlineNotice} pointerEvents="none">
            <Icon name="wifi-off" size={13} color={colors.textMuted} />
            <Text
              style={styles.offlineNoticeText}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              You're offline
            </Text>
          </View>
        ) : null}
        <Composer
          colors={colors}
          inputRef={inputRef}
          draftStore={draftStore}
          enabled={composerEnabled}
          placeholder={placeholder}
          intervention={composerIntervention}
          bottomPad={composerBottomPad}
          draftEmpty={draftEmpty}
          hasText={hasText}
          canSubmit={canSubmit}
          streaming={streaming}
          onSubmit={submit}
          onStop={onStop}
          onInputFocus={onComposerFocus}
          onPressPlus={onPressPlus}
          dictationStatus={dictationStatus}
          onToggleVoice={toggleVoice}
          onCancelDictation={cancelDictationInput}
          onConfirmDictation={confirmDictationInput}
          onStopAndSendVoice={stopAndSendVoice}
          showRealtimeVoice={showRealtimeVoice}
          onOpenRealtimeVoice={openRealtimeVoice}
          modelPicker={composerModelPicker}
          modelPickerAnchorRef={modelPickerAnchorRef}
          onPressModelPicker={onPressModelPicker}
          quotes={quotes}
          onRemoveQuote={onRemoveQuote}
          attachments={attachments}
          onRemoveAttachment={onRemoveAttachment}
          onRetryAttachment={onRetryAttachment}
        />
      </Reanimated.View>
      <AddContextSheet
        visible={addSheetOpen}
        onClose={() => setAddSheetOpen(false)}
        onDismissed={onAddSheetDismissed}
        onCamera={
          enableAttachments
            ? () => chooseFromAddSheet(() => void takePhoto())
            : undefined
        }
        onPhotos={
          enableAttachments
            ? () => chooseFromAddSheet(() => void pickImage())
            : undefined
        }
        onFiles={
          enableAttachments
            ? () => chooseFromAddSheet(() => void pickDocument())
            : undefined
        }
        readAloud={readAloud.enabled}
        onReadAloudChange={(next) => void readAloud.setEnabled(next)}
      />
      {messageMenu && messageMenuActions.length > 0 ? (
        <MessageContextMenu
          key={messageMenu.message.id}
          rect={messageMenu.anchor}
          side={messageMenu.message.role === "user" ? "right" : "left"}
          bubble={
            <ChatMessageRow
              item={messageMenu.message}
              conversationId={conversationId ?? ""}
              animate={false}
              styles={rowStyles}
              colors={colors}
              menuActive={false}
              isSelecting={false}
              anySelecting={false}
              actions={menuCloneRowActions}
              menuClone
            />
          }
          actions={messageMenuActions}
          colors={colors}
          onDismiss={dismissMessageMenu}
        />
      ) : null}
      <PlusMenuPopover
        visible={Boolean(modelPickerAnchor) && modelPickerOptions.length > 0}
        anchor={modelPickerAnchor}
        options={modelPickerOptions}
        onDismiss={dismissModelPicker}
        colors={colors}
        containerRef={rootRef}
        minWidth={320}
        wrapLabels
      />
      <RealtimeVoiceOverlay
        visible={realtimeVoiceOpen}
        conversationId={realtimeVoiceConversationId}
        execution={realtimeVoiceExecution}
        desktopAccess={realtimeVoiceDesktopAccess}
        signInRequired={realtimeVoiceSignInRequired}
        messages={messages}
        tasks={activityTasks ?? []}
        chatBusy={streaming}
        onPerformAction={performRealtimeVoiceAction}
        onClose={() => setRealtimeVoiceOpen(false)}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      marginHorizontal: -SHELL_CONTENT_PADDING,
      position: "relative",
    },
    // Anchored at the bottom of the screen, above the message list. The list
    // gets matching bottom inset (via `footerHeight`) so content can still be
    // scrolled fully into view; the transparent gutters around the composer
    // shell let messages peek through as they pass underneath.
    footerOverlay: {
      bottom: 0,
      left: 0,
      position: "absolute",
      right: 0,
    },
    viewport: { flex: 1, minHeight: 0, position: "relative" },
    hiddenWhileFocused: { display: "none" },
    messageList: { flex: 1 },
    topTaper: {
      left: 0,
      position: "absolute",
      right: 0,
      top: 0,
    },
    list: {
      paddingHorizontal: CHAT_HORIZONTAL_INSET,
    },
    itemSeparator: { height: MESSAGE_LIST_GAP },
    // Fixed-height tail below the last message. Hosts the inline working
    // indicator and keeps its footprint constant whether or not it's showing.
    // Its top padding matches the user-to-assistant bubble gap (separator plus
    // the assistant row's padding), so the indicator bubble sits as far below
    // the last message as the next reply will.
    chatTail: {
      minHeight: CHAT_TAIL_GAP,
      paddingTop: MESSAGE_LIST_GAP + ASSISTANT_ROW_PAD_VERTICAL,
      justifyContent: "flex-start",
    },
    emptyState: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
    },
    hiddenFooter: {
      display: "none",
    },
    timestampHeader: {
      alignSelf: "center",
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
      letterSpacing: -0.1,
      paddingBottom: 10,
      paddingTop: 14,
    },
    offlineNotice: {
      alignItems: "center",
      alignSelf: "center",
      flexDirection: "row",
      gap: 6,
      paddingBottom: 2,
      paddingTop: 4,
    },
    offlineNoticeText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
      letterSpacing: -0.1,
    },
  } as const);
