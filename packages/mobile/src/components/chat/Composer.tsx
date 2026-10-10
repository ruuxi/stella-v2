import {
  type ReactNode,
  type Ref,
  type RefObject,
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
  LayoutAnimation,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from "react-native";
import { Image } from "expo-image";
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { useT } from "../../i18n";
import { type ComposerAttachment } from "../../lib/chat-attachments";
import { useChatDraft, type ChatDraftStore } from "../../lib/chat-draft-store";
import { resolveComposerExpanded } from "../../lib/composer-model-layout";
import type { DictationStatus } from "../../lib/dictation";
import { tapLight } from "../../lib/haptics";
import { CONTENT_MAX_FONT_SCALE } from "../../lib/setup-text-defaults";
import { type Colors } from "../../theme/colors";
import { fadeHex } from "../../theme/oklch";
import { fonts } from "../../theme/fonts";
import type { ComposerQuote } from "../../types";
import { DictationRecordingBar } from "../DictationRecordingBar";
import { GlassSurface } from "../glass";
import { Icon } from "../Icon";

// ---------------------------------------------------------------------------
// Constants — mapped from desktop full-shell.composer.css
// ---------------------------------------------------------------------------

/** Horizontal inset from the true screen edge once shell padding is cancelled. */
export const CHAT_HORIZONTAL_INSET = 12;

/**
 * Content-height threshold for pill → expanded.
 * RN `onContentSizeChange` reports raw text height (no padding).
 * fontSize 16 × lineHeight ~22 ≈ 22 per line; trip on the second line so
 * wrapping immediately grows the composer instead of clipping behind the
 * send button.
 */
const EXPAND_THRESHOLD = 30;
/** Tallest the typed text area grows before it scrolls inside the composer. */
const COMPOSER_INPUT_MAX_HEIGHT = 200;
/**
 * Tallest a live dictation transcript grows in an empty composer (eight
 * transcript lines, inside the typed area's cap) before it scrolls.
 */
const DICTATION_INLINE_MAX_HEIGHT = 168;
/**
 * Tallest a live transcript grows under already-typed text (three lines),
 * which has its own cap above it.
 */
const DICTATION_BELOW_MAX_HEIGHT = 63;
/** LayoutAnimation config matching the same 350ms critically-damped spring. */
export const LAYOUT_SPRING = {
  duration: 350,
  update: { type: LayoutAnimation.Types.spring, springDamping: 1 },
  create: {
    type: LayoutAnimation.Types.spring,
    springDamping: 1,
    property: LayoutAnimation.Properties.opacity,
  },
  delete: {
    type: LayoutAnimation.Types.spring,
    springDamping: 1,
    property: LayoutAnimation.Properties.opacity,
  },
};

export const isDraftEmpty = (draft: string) => draft.length === 0;
export const draftHasText = (draft: string) => draft.trim().length > 0;

type ComposerStyles = ReturnType<typeof makeComposerStyles>;

export type ComposerModelPickerConfig = {
  pinned: boolean;
  label: string;
  loading?: boolean;
  saving?: boolean;
  effortLabel: string;
  effortOptions: readonly {
    id: string;
    label: string;
    selected: boolean;
  }[];
  recentModels: readonly {
    id: string;
    label: string;
    selected: boolean;
  }[];
  onOpen: () => void;
  onSelectEffort: (id: string) => void;
  onSelectModel: (id: string) => void;
};

/**
 * The composer's text input — the only component a keystroke re-renders. It
 * subscribes to the draft store for its value and writes edits straight back.
 */
function ComposerTextInput({
  draftStore,
  ref,
  ...props
}: Omit<TextInputProps, "value" | "onChangeText"> & {
  draftStore: ChatDraftStore;
  ref?: Ref<TextInput>;
}) {
  const value = useChatDraft(draftStore);
  return (
    <TextInput
      ref={ref}
      {...props}
      value={value}
      onChangeText={draftStore.set}
    />
  );
}

/**
 * Submit button that springs between enabled/disabled states like the
 * desktop `motion.button` in `ComposerPrimitives.tsx`:
 *   animate={{ opacity: canSubmit ? 1 : 0.4, scale: canSubmit ? 1 : 0.92 }}
 *   transition={{ type: "spring", duration: 0.2, bounce: 0 }}
 */
function AnimatedSubmitButton({
  canSubmit,
  onPress,
  styles,
  colors,
  accessibilityLabel,
}: {
  canSubmit: boolean;
  onPress: () => void;
  styles: ComposerStyles;
  colors: Colors;
  accessibilityLabel: string;
}) {
  const opacity = useRef(new Animated.Value(canSubmit ? 1 : 0.4)).current;
  const scale = useRef(new Animated.Value(canSubmit ? 1 : 0.92)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.spring(opacity, {
        toValue: canSubmit ? 1 : 0.4,
        damping: 18,
        stiffness: 260,
        mass: 0.6,
        useNativeDriver: true,
      }),
      Animated.spring(scale, {
        toValue: canSubmit ? 1 : 0.92,
        damping: 18,
        stiffness: 260,
        mass: 0.6,
        useNativeDriver: true,
      }),
    ]).start();
  }, [canSubmit, opacity, scale]);

  const animatedStyle = useMemo(
    () => ({ opacity, transform: [{ scale }] }),
    [opacity, scale],
  );

  return (
    <Animated.View style={animatedStyle}>
      <Pressable
        onPress={onPress}
        disabled={!canSubmit}
        accessibilityRole="button"
        accessibilityState={{ disabled: !canSubmit }}
        accessibilityLabel={accessibilityLabel}
        style={styles.submitButton}
        hitSlop={4}
      >
        <Icon
          name="arrow-up"
          size={15}
          color={colors.accentForeground}
          weight="heavy"
        />
      </Pressable>
    </Animated.View>
  );
}

/**
 * Square stop affordance shown in place of the submit button while a reply is
 * streaming (chat) or pending (computer chat). Calling `onPress` cancels the
 * in-flight reply and cancels any queued messages. Canceled user bubbles stay
 * visible in the transcript with a Stopped label; resuming requires re-sending.
 */
function StopButton({
  onPress,
  styles,
  colors,
}: {
  onPress: () => void;
  styles: ComposerStyles;
  colors: Colors;
}) {
  return (
    <Pressable
      onPress={() => {
        tapLight();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel="Stop reply"
      style={styles.submitButton}
      hitSlop={4}
    >
      <Icon
        name="stop"
        size={13}
        color={colors.accentForeground}
        weight="heavy"
        filled
      />
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Composer — the glass shell at the bottom of the chat: quote and attachment
// strips, the text input (pill ⇄ expanded), dictation, and the toolbar. The
// pane owns sending, dictation and the menus; this renders them. Memoized, so
// the pane's scroll, keyboard and footer re-renders skip it: keep every prop's
// identity stable.
// ---------------------------------------------------------------------------

export const Composer = memo(function Composer({
  colors,
  inputRef,
  draftStore,
  enabled,
  placeholder,
  intervention,
  hidden = false,
  bottomPad,
  draftEmpty,
  hasText,
  canSubmit,
  streaming,
  onSubmit,
  onStop,
  onInputFocus,
  onPressPlus,
  dictationStatus,
  onToggleVoice,
  onCancelDictation,
  onConfirmDictation,
  onStopAndSendVoice,
  showRealtimeVoice,
  onOpenRealtimeVoice,
  modelPicker,
  modelPickerAnchorRef,
  onPressModelPicker,
  quotes,
  onRemoveQuote,
  attachments,
  onRemoveAttachment,
  onRetryAttachment,
}: {
  colors: Colors;
  inputRef: RefObject<TextInput | null>;
  draftStore: ChatDraftStore;
  /** Whether the composer accepts text (typing + sending). */
  enabled: boolean;
  placeholder: string;
  /** Owner-approved intervention pinned immediately above the composer. */
  intervention?: ReactNode;
  /** The intervention takes the composer's place, e.g. a question card. */
  hidden?: boolean;
  /** Bottom padding that keeps the shell clear of the home indicator. */
  bottomPad: number;
  draftEmpty: boolean;
  hasText: boolean;
  canSubmit: boolean;
  streaming: boolean;
  onSubmit: () => void;
  onStop?: () => void;
  onInputFocus: () => void;
  onPressPlus: () => void;
  dictationStatus: DictationStatus;
  onToggleVoice: () => Promise<void>;
  onCancelDictation: () => void;
  onConfirmDictation: () => void;
  onStopAndSendVoice: () => void;
  /** Realtime voice is offered (empty composer, idle dictation, a voice route). */
  showRealtimeVoice: boolean;
  onOpenRealtimeVoice: () => Promise<void>;
  modelPicker?: ComposerModelPickerConfig;
  modelPickerAnchorRef: RefObject<View | null>;
  onPressModelPicker: () => void;
  quotes?: ComposerQuote[];
  onRemoveQuote?: (id: string) => void;
  /** Pending attachments; absent when this transport takes none. */
  attachments?: ComposerAttachment[];
  onRemoveAttachment?: (id: string) => void;
  onRetryAttachment?: (id: string) => void;
}) {
  const styles = useMemo(() => makeComposerStyles(colors), [colors]);
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const isListening = dictationStatus === "recording";
  const isTranscribing = dictationStatus === "transcribing";

  // When the parent clears draft after send, collapse back to pill shape.
  useEffect(() => {
    if (expanded && draftEmpty) {
      LayoutAnimation.configureNext(LAYOUT_SPRING);
      setExpanded(false);
    }
  }, [draftEmpty, expanded]);

  // Expansion is one-way while the user is typing: the pill and expanded
  // shapes give the text different widths, so a 2-line pill can re-flow to
  // 1 line in expanded shape — flipping back to pill would re-wrap and
  // oscillate forever. Collapse happens only when the parent clears the
  // draft (see the `useEffect` above) or via dedicated dictation handlers.
  // Trigger expand purely on measured content height crossing the threshold.
  // We used to gate on a `hasMounted` ref to skip the first event, but on
  // screens where the composer's host re-renders shortly after mount (e.g.
  // Computer tab settling `paired: null → true`) the *useful* first event —
  // the one that already exceeds the threshold — could be the one that got
  // swallowed, leaving the pill stuck at one line forever.
  const handleContentSizeChange = useCallback(
    (e: { nativeEvent: { contentSize: { height: number } } }) => {
      if (expanded) return;
      // Ignore measurements once the draft is empty. On send the draft clears
      // and the collapse effect drops us back to the pill, but the native
      // TextInput can still emit one more `onContentSizeChange` carrying the
      // *old* tall height before it renders the cleared value. Acting on that
      // would re-expand an empty composer, the collapse effect would collapse
      // it again, and the two LayoutAnimation springs ping-pong — the composer
      // (and the working indicator stacked above it) shake violently. An empty
      // composer is never expanded, so there is nothing to grow for here.
      if (draftStore.get().length === 0) return;
      const h = e.nativeEvent.contentSize.height;
      if (h > EXPAND_THRESHOLD) {
        LayoutAnimation.configureNext(LAYOUT_SPRING);
        setExpanded(true);
      }
    },
    [expanded, draftStore],
  );

  const dictationInline = isListening && !hasText;
  const dictationBelow = isListening && hasText;
  const isExpandedComposed = resolveComposerExpanded({
    expanded,
    dictationBelow,
    dictationInline,
    modelPickerPinned: Boolean(modelPicker?.pinned),
    hasAttachments: (attachments?.length ?? 0) > 0,
    hasQuotes: (quotes?.length ?? 0) > 0,
  });

  // While dictating, the recording bar's leading slot carries cancel instead.
  // Withheld here rather than only in the inline branch so the other dictation
  // layout (recording bar below a composer that already has text) does not end
  // up showing a + and an X at once — one leading control, one meaning.
  const plusButton =
    enabled && !isListening ? (
      <View collapsable={false}>
        <Pressable
          style={styles.addButton}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel="Open add menu"
          onPress={onPressPlus}
        >
          <Icon
            name="plus"
            size={17}
            color={colors.textMuted}
            weight="semibold"
          />
        </Pressable>
      </View>
    ) : null;

  // Shared mic / dictation control. Reused across the collapsed pill and the
  // expanded toolbar. It is intentionally NOT gated on `streaming`: dictation
  // stays available mid-run so a voice message can steer the active turn,
  // exactly like typing + sending while busy. The branches that render it are
  // mutually exclusive per render, so reusing the same element is safe.
  const micButton = (
    <Pressable
      onPress={() => void onToggleVoice()}
      accessibilityRole="button"
      accessibilityState={{ disabled: isTranscribing }}
      accessibilityLabel={
        isListening ? "Stop voice input" : "Start voice input"
      }
      disabled={isTranscribing}
      style={[styles.micButton, isListening && styles.micButtonActive]}
      hitSlop={4}
    >
      <Icon
        name={isListening ? "mic-off" : "mic"}
        size={20}
        color={isListening ? colors.accentForeground : colors.textMuted}
        filled={isListening}
      />
    </Pressable>
  );

  // Realtime voice is a distinct live-conversation mode, not dictation. Keep
  // it immediately to the right of the mic only while the composer is empty;
  // once text or an attachment exists, send remains the unambiguous action.
  const realtimeVoiceButton = showRealtimeVoice ? (
    <Pressable
      onPress={() => void onOpenRealtimeVoice()}
      accessibilityRole="button"
      accessibilityLabel="Start realtime voice conversation"
      style={({ pressed }) => [
        styles.realtimeVoiceButton,
        pressed && styles.realtimeVoiceButtonPressed,
      ]}
      hitSlop={4}
    >
      <Icon name="waveform" size={19} color={colors.text} weight="semibold" />
    </Pressable>
  ) : null;

  const reveal = useSharedValue(hidden ? 0 : 1);
  useEffect(() => {
    reveal.value = hidden
      ? 0
      : withSpring(1, { damping: 22, stiffness: 220, mass: 0.9 });
  }, [hidden, reveal]);
  const revealStyle = useAnimatedStyle(() => ({
    opacity: reveal.value,
    transform: [{ translateY: (1 - reveal.value) * 18 }],
  }));

  const showAttachmentStrip = (attachments?.length ?? 0) > 0;
  const quoteChips = quotes ?? [];
  const showQuoteStrip = quoteChips.length > 0;

  return (
    <View style={[styles.composerWrap, { paddingBottom: bottomPad }]}>
      {intervention}
      <Reanimated.View
        style={[styles.composerReveal, revealStyle, hidden && styles.composerHidden]}
        pointerEvents={hidden ? "none" : "box-none"}
      >
      <Pressable
        accessible={false}
        style={styles.composerFocusTarget}
        disabled={!enabled || dictationInline || dictationBelow}
        onPress={() => inputRef.current?.focus()}
      >
        <GlassSurface
          glass="regular"
          // Interactive so a touch on the composer draws Apple's glow inside
          // the glass, the way every other Liquid Glass control answers a
          // tap. It does not take the touches: the input and buttons inside
          // keep receiving them.
          interactive
          // Softer than the menu tint: enough contrast for the input text
          // while keeping the composer visibly glassy over scrolling chat.
          tintColor={fadeHex(colors.surface, 0.5)}
          radius={isExpandedComposed ? 20 : 999}
          fallbackColor={colors.surface}
          style={styles.shell}
        >
          {showQuoteStrip ? (
            <View style={styles.composerQuoteStrip}>
              {quoteChips.map((quote) => (
                <View key={quote.id} style={styles.composerQuote}>
                  <Icon
                    name="reply"
                    size={14}
                    color={colors.textMuted}
                    weight="regular"
                  />
                  <Text
                    style={styles.composerQuoteText}
                    numberOfLines={2}
                    maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
                  >
                    {quote.text}
                  </Text>
                  <Pressable
                    style={({ pressed }) => [
                      styles.composerQuoteRemove,
                      pressed && styles.composerQuoteRemovePressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Remove quoted text"
                    onPress={() => onRemoveQuote?.(quote.id)}
                    hitSlop={10}
                  >
                    <Icon
                      name="x"
                      size={10}
                      color={colors.textMuted}
                      weight="bold"
                    />
                  </Pressable>
                </View>
              ))}
            </View>
          ) : null}
          {showAttachmentStrip ? (
            // Pending attachments sit inside the composer, above the text,
            // in a horizontal rail so any number of them stays one row.
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              style={styles.attachmentStrip}
              contentContainerStyle={styles.attachmentStripContent}
            >
              {(attachments ?? []).map((attachment) => (
                <View key={attachment.id} style={styles.attachmentThumb}>
                  {attachment.kind === "image" ? (
                    <Image
                      source={{ uri: attachment.uri }}
                      style={styles.attachmentImage}
                      contentFit="cover"
                    />
                  ) : (
                    <View style={styles.attachmentFile}>
                      <Icon
                        name="file-text"
                        size={18}
                        color={colors.textMuted}
                      />
                      <Text style={styles.attachmentFileName} numberOfLines={2}>
                        {attachment.name}
                      </Text>
                    </View>
                  )}
                  {attachment.status !== "ready" && (
                    <Pressable
                      style={styles.attachmentStatusScrim}
                      disabled={attachment.status === "uploading"}
                      accessibilityRole="button"
                      accessibilityLabel={
                        attachment.status === "uploading"
                          ? t("chat.attachments.uploading")
                          : t("chat.attachments.retryUpload")
                      }
                      onPress={() => onRetryAttachment?.(attachment.id)}
                    >
                      {attachment.status === "uploading" ? (
                        <ActivityIndicator size="small" color="#ffffff" />
                      ) : (
                        <Icon
                          name="refresh-cw"
                          size={16}
                          color="#ffffff"
                          weight="bold"
                        />
                      )}
                    </Pressable>
                  )}
                  <Pressable
                    style={styles.attachmentRemove}
                    accessibilityLabel={t("chat.attachments.remove")}
                    onPress={() => onRemoveAttachment?.(attachment.id)}
                    hitSlop={4}
                  >
                    <Icon
                      name="x"
                      size={12}
                      // The button's scrim is a fixed dark wash (it sits over
                      // arbitrary photo content), so the glyph has to be a
                      // fixed light colour too — `accentForeground` inverts
                      // with the theme and goes near-black in every dark one.
                      color="#ffffff"
                      weight="bold"
                    />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          ) : null}
          {dictationInline ? (
            // Dictation into an empty composer keeps the expanded shape:
            // the live transcript takes the text area and the waveform
            // row sits where the toolbar normally is.
            <View style={styles.dictationInlineBlock}>
              <DictationRecordingBar
                placeholder={"Listening\u2026"}
                transcriptStyle={styles.dictationInlineTranscript}
                transcriptMaxHeight={DICTATION_INLINE_MAX_HEIGHT}
                onCancel={onCancelDictation}
                onConfirm={onConfirmDictation}
                onSend={onStopAndSendVoice}
              />
            </View>
          ) : (
            // Single TextInput, stable JSX position across pill ⇄ expanded so
            // React reuses the same native UITextView when the shape swaps.
            // Swapping between two separate <TextInput> instances dropped
            // focus, which collapsed and re-summoned the keyboard on every
            // expand — visible as a flicker whenever a line wrapped.
            <View>
              <View
                style={
                  isExpandedComposed
                    ? styles.expandedInputBlock
                    : styles.formPill
                }
              >
                {isExpandedComposed ? null : plusButton}
                <ComposerTextInput
                  ref={inputRef}
                  draftStore={draftStore}
                  multiline
                  scrollEnabled={isExpandedComposed}
                  onContentSizeChange={handleContentSizeChange}
                  onFocus={onInputFocus}
                  blurOnSubmit={false}
                  placeholder={
                    isExpandedComposed
                      ? placeholder
                      : isTranscribing
                        ? "Transcribing\u2026"
                        : placeholder
                  }
                  placeholderTextColor={fadeHex(colors.textMuted, 0.35)}
                  selectionColor={colors.accent}
                  underlineColorAndroid="transparent"
                  style={
                    isExpandedComposed
                      ? [
                          styles.inputExpanded,
                          draftEmpty && styles.inputExpandedEmpty,
                        ]
                      : styles.inputPill
                  }
                  editable={enabled}
                />
                {isExpandedComposed ? null : canSubmit ? (
                  <AnimatedSubmitButton
                    canSubmit={canSubmit}
                    onPress={onSubmit}
                    styles={styles}
                    colors={colors}
                    accessibilityLabel="Send message"
                  />
                ) : streaming && onStop ? (
                  // Busy with an empty composer: keep the mic available so a
                  // dictated message can steer the active turn, and keep Stop
                  // reachable alongside it (mirrors the expanded toolbar,
                  // which always shows the mic).
                  <View style={styles.pillTrailingCluster}>
                    {micButton}
                    {realtimeVoiceButton}
                    <StopButton
                      onPress={onStop}
                      styles={styles}
                      colors={colors}
                    />
                  </View>
                ) : (
                  <View style={styles.pillTrailingCluster}>
                    {micButton}
                    {realtimeVoiceButton}
                  </View>
                )}
              </View>
              {isExpandedComposed && !dictationBelow ? (
                <View style={styles.toolbar}>
                  <View style={styles.toolbarLeft}>{plusButton}</View>
                  <View style={styles.toolbarRight}>
                    {modelPicker?.pinned ? (
                      <View ref={modelPickerAnchorRef} collapsable={false}>
                        <Pressable
                          onPress={onPressModelPicker}
                          disabled={modelPicker.loading}
                          accessibilityRole="button"
                          accessibilityLabel={t(
                            "app.chat.miniModelPicker.triggerLabel",
                            { model: modelPicker.label },
                          )}
                          style={({ pressed }) => [
                            styles.miniModelPickerTrigger,
                            pressed && styles.miniModelPickerTriggerPressed,
                          ]}
                        >
                          <Text
                            style={styles.miniModelPickerLabel}
                            numberOfLines={1}
                          >
                            {modelPicker.loading
                              ? "Loading…"
                              : modelPicker.label}
                          </Text>
                          <Icon
                            name="chevron-down"
                            size={13}
                            color={colors.textMuted}
                          />
                        </Pressable>
                      </View>
                    ) : null}
                    {micButton}
                    {realtimeVoiceButton}
                    {streaming && onStop && !hasText ? (
                      <StopButton
                        onPress={onStop}
                        styles={styles}
                        colors={colors}
                      />
                    ) : (
                      <AnimatedSubmitButton
                        canSubmit={canSubmit}
                        onPress={onSubmit}
                        styles={styles}
                        colors={colors}
                        accessibilityLabel="Send message"
                      />
                    )}
                  </View>
                </View>
              ) : null}
              {dictationBelow ? (
                <View style={styles.dictationRow}>
                  <DictationRecordingBar
                    transcriptMaxHeight={DICTATION_BELOW_MAX_HEIGHT}
                    onCancel={onCancelDictation}
                    onConfirm={onConfirmDictation}
                    onSend={onStopAndSendVoice}
                  />
                </View>
              ) : null}
            </View>
          )}
        </GlassSurface>
      </Pressable>
      </Reanimated.View>
    </View>
  );
});

const makeComposerStyles = (colors: Colors) =>
  StyleSheet.create({
    composerWrap: {
      alignItems: "center",
      flexShrink: 0,
      gap: 8,
      paddingBottom: 6,
      paddingHorizontal: CHAT_HORIZONTAL_INSET,
      paddingTop: 12,
    },
    // Attachment rail inside the shell: sized by its content so the input
    // below keeps its own height, scrolling sideways once thumbs overflow.
    attachmentStrip: {
      flexGrow: 0,
      flexShrink: 0,
    },
    attachmentStripContent: {
      flexDirection: "row",
      gap: 8,
      paddingBottom: 2,
      paddingHorizontal: 12,
      paddingTop: 12,
    },
    composerQuoteStrip: {
      gap: 6,
      paddingHorizontal: 10,
      paddingTop: 10,
    },
    composerQuote: {
      alignItems: "center",
      backgroundColor: fadeHex(colors.textMuted, 0.1),
      borderCurve: "continuous",
      borderRadius: 12,
      flexDirection: "row",
      gap: 10,
      paddingLeft: 8,
      paddingRight: 8,
      paddingVertical: 8,
    },
    composerQuoteText: {
      color: colors.textMuted,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      letterSpacing: -0.15,
      lineHeight: 19,
    },
    composerQuoteRemove: {
      alignItems: "center",
      backgroundColor: fadeHex(colors.textMuted, 0.16),
      borderRadius: 999,
      height: 20,
      justifyContent: "center",
      width: 20,
    },
    composerQuoteRemovePressed: {
      backgroundColor: fadeHex(colors.textMuted, 0.28),
    },
    attachmentThumb: {
      borderRadius: 10,
      height: 64,
      overflow: "hidden",
      position: "relative",
      width: 64,
    },
    attachmentImage: { borderRadius: 10, height: 64, width: 64 },
    // A document has no preview to show, so the tile becomes its name.
    attachmentFile: {
      alignItems: "center",
      backgroundColor: fadeHex(colors.textMuted, 0.12),
      borderRadius: 10,
      gap: 2,
      height: 64,
      justifyContent: "center",
      paddingHorizontal: 4,
      width: 64,
    },
    attachmentFileName: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 9,
      letterSpacing: -0.1,
      textAlign: "center",
    },
    // Covers the whole tile while an upload is in flight or broken, so a chip
    // never reads as ready when it is not.
    attachmentStatusScrim: {
      alignItems: "center",
      backgroundColor: "rgba(0,0,0,0.45)",
      borderRadius: 10,
      bottom: 0,
      justifyContent: "center",
      left: 0,
      position: "absolute",
      right: 0,
      top: 0,
    },
    attachmentRemove: {
      alignItems: "center",
      backgroundColor: "rgba(0,0,0,0.55)",
      borderRadius: 10,
      height: 20,
      justifyContent: "center",
      position: "absolute",
      right: 3,
      top: 3,
      width: 20,
    },
    shell: {
      borderColor: colors.panelSurfaceBorder,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: "hidden",
      width: "100%",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.08,
      shadowRadius: 24,
      elevation: 8,
    },
    composerFocusTarget: { width: "100%" },
    composerHidden: { display: "none" },
    composerReveal: { alignSelf: "stretch" },
    formPill: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      minHeight: 56,
      paddingHorizontal: 8,
      paddingVertical: 11,
    },
    expandedInputBlock: { flexDirection: "column" },
    inputPill: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 16,
      letterSpacing: -0.2,
      lineHeight: 22,
      maxHeight: 32,
      paddingHorizontal: 4,
      paddingVertical: 0,
      ...(Platform.OS === "android"
        ? { textAlignVertical: "center" as const }
        : {}),
    },
    inputExpanded: {
      color: colors.text,
      fontFamily: fonts.sans.regular,
      fontSize: 16,
      letterSpacing: -0.2,
      lineHeight: 24,
      maxHeight: COMPOSER_INPUT_MAX_HEIGHT,
      minHeight: 46,
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 2,
    },
    // A pinned model picker keeps the same scrollable UITextView expanded
    // after send. Its old intrinsic content height can survive clearing value;
    // an empty draft has a known resting height, independent of that cache.
    inputExpandedEmpty: { height: 46 },
    toolbar: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      paddingBottom: 6,
      paddingHorizontal: 8,
      paddingTop: 2,
    },
    toolbarLeft: { flexDirection: "row", alignItems: "center", gap: 4 },
    toolbarRight: { flexDirection: "row", alignItems: "center", gap: 8 },
    miniModelPickerTrigger: {
      alignItems: "center",
      flexDirection: "row",
      gap: 4,
      height: 30,
      maxWidth: 154,
      paddingHorizontal: 10,
    },
    miniModelPickerTriggerPressed: {
      opacity: 0.55,
    },
    miniModelPickerLabel: {
      color: colors.textMuted,
      flexShrink: 1,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: -0.15,
    },
    pillTrailingCluster: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    dictationRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 6,
      paddingBottom: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: fadeHex(colors.border, 0.5),
    },
    // Insets so the transcript lands where expanded input text sits
    // (`inputExpanded`: 16 across, 14 down) and the waveform row where the
    // toolbar sits, with the same resting height as an empty expanded shell.
    dictationInlineBlock: {
      paddingHorizontal: 12,
      paddingTop: 13,
      paddingBottom: 8,
    },
    dictationInlineTranscript: { minHeight: 30 },
    addButton: {
      alignItems: "center",
      backgroundColor: fadeHex(colors.text, 0.06),
      borderRadius: 16,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    submitButton: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: 16,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    micButton: {
      alignItems: "center",
      backgroundColor: "transparent",
      borderRadius: 16,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    micButtonActive: { backgroundColor: colors.accent },
    realtimeVoiceButton: {
      alignItems: "center",
      backgroundColor: "transparent",
      borderRadius: 16,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    realtimeVoiceButtonPressed: {
      opacity: 0.55,
      transform: [{ scale: 0.96 }],
    },
  } as const);
