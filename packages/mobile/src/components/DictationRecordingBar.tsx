/**
 * Mobile mirror of desktop's DictationRecordingBar
 * (`desktop/src/features/dictation/components/DictationRecordingBar.tsx`).
 * The composer keeps its expanded shape while dictating: the cumulative
 * transcript fills the text area and the waveform row stays anchored
 * underneath, where the toolbar normally sits:
 *
 *   A live transcript that can wrap and revise
 *   [+]  [waveform — flex 1]   [0:24]   [X]   [✓]   [↑]
 *
 * The trailing send (↑) is optional: when `onSend` is given it stops dictation
 * and, once the transcript lands, auto-submits the message in one tap.
 *
 * Transcript, waveform and timer are separate leaves on external stores, so a
 * partial transcript never re-lays-out the waveform and a waveform tick never
 * re-renders the words. Word fades run on the native driver.
 */

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { Icon } from "./Icon";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";
import {
  getDictationMeterSnapshot,
  useDictationMeterStartedAt,
  useDictationMeterTick,
} from "../lib/dictation-meter";
import {
  tokenizeDictationTranscript,
  useDictationTranscriptPreview,
} from "../lib/dictation-transcript-preview";

const BAR_WIDTH = 2;
const BAR_GAP = 2;
const WAVEFORM_HEIGHT = 28;
const MIN_BAR_HEIGHT = 1;
const LEVEL_BUFFER_LENGTH = 64;
const TIMER_TICK_MS = 250;

type Props = {
  onCancel: () => void;
  onConfirm: () => void;
  /** When provided, stop dictation and auto-send once the transcript lands. */
  onSend?: () => void;
  /** Rendered at the leading edge of the waveform row (the composer's +). */
  leading?: ReactNode;
  /** Muted hint shown in the transcript area until the first words arrive. */
  placeholder?: string;
  /** Extra layout for the transcript area (the composer's text-area inset). */
  transcriptStyle?: StyleProp<ViewStyle>;
};

export const DictationRecordingBar = memo(function DictationRecordingBar({
  onCancel,
  onConfirm,
  onSend,
  leading,
  placeholder,
  transcriptStyle,
}: Props) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const reduceMotion = useReducedMotion();

  return (
    <View style={styles.recordingBar}>
      <LiveTranscript
        color={fadeHex(colors.text, 0.66)}
        placeholder={placeholder}
        placeholderColor={fadeHex(colors.textMuted, 0.35)}
        reduceMotion={reduceMotion}
        style={transcriptStyle}
      />
      <View style={styles.recordingRow}>
        {leading}
        <DictationWaveform color={fadeHex(colors.text, 0.7)} />
        <ElapsedTimer style={styles.timer} />
        <Pressable
          onPress={onCancel}
          accessibilityLabel="Cancel dictation"
          hitSlop={6}
          style={styles.control}
        >
          <Icon
            name="x"
            size={14}
            color={fadeHex(colors.text, 0.75)}
            weight="semibold"
          />
        </Pressable>
        <Pressable
          onPress={onConfirm}
          accessibilityLabel="Stop dictation and transcribe"
          hitSlop={6}
          style={styles.control}
        >
          <Icon name="check" size={16} color={colors.text} weight="semibold" />
        </Pressable>
        {onSend ? (
          <Pressable
            onPress={onSend}
            accessibilityLabel="Stop dictation and send"
            hitSlop={6}
            style={styles.sendControl}
          >
            <Icon
              name="arrow-up"
              size={15}
              color={colors.accentForeground}
              weight="heavy"
            />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
});

const LiveTranscript = memo(function LiveTranscript({
  color,
  placeholder,
  placeholderColor,
  reduceMotion,
  style,
}: {
  color: string;
  placeholder?: string;
  placeholderColor: string;
  reduceMotion: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { text, revision, stableWordCount } = useDictationTranscriptPreview();
  if (!text) {
    if (!placeholder) return null;
    return (
      <View style={[waveStyles.transcript, style]}>
        <Text style={[waveStyles.placeholder, { color: placeholderColor }]}>
          {placeholder}
        </Text>
      </View>
    );
  }
  const words = tokenizeDictationTranscript(text);
  return (
    <View
      style={[waveStyles.transcript, style]}
      accessible
      accessibilityLabel={text}
      accessibilityLiveRegion="polite"
    >
      {words.map((word, index) => (
        <AnimatedWord
          key={
            index < stableWordCount
              ? `${index}:${word}`
              : `${revision}:${index}:${word}`
          }
          color={color}
          animate={!reduceMotion}
          word={word}
        />
      ))}
    </View>
  );
});

const AnimatedWord = memo(function AnimatedWord({
  word,
  color,
  animate,
}: {
  word: string;
  color: string;
  animate: boolean;
}) {
  const progress = useRef(new Animated.Value(animate ? 0 : 1)).current;

  useEffect(() => {
    if (!animate) return;
    Animated.timing(progress, {
      toValue: 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [animate, progress]);

  return (
    <Animated.Text
      style={{
        color,
        fontFamily: fonts.sans.regular,
        fontSize: 15,
        fontStyle: "italic",
        lineHeight: 21,
        marginRight: 4,
        opacity: progress,
        transform: [
          {
            translateY: progress.interpolate({
              inputRange: [0, 1],
              outputRange: [2, 0],
            }),
          },
        ],
      }}
    >
      {word}
    </Animated.Text>
  );
});

const ElapsedTimer = memo(function ElapsedTimer({
  style,
}: {
  style: StyleProp<ViewStyle>;
}) {
  const startedAt = useDictationMeterStartedAt();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!startedAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), TIMER_TICK_MS);
    return () => clearInterval(timer);
  }, [startedAt]);

  const durationMs = startedAt ? Math.max(0, now - startedAt) : 0;
  return (
    <Text style={style} accessibilityLiveRegion="polite">
      {formatElapsed(durationMs)}
    </Text>
  );
});

/**
 * One bar per meter tick (~12.5 Hz), newest on the right, older bars
 * scrolling off the left once the buffer is full — the same series desktop
 * draws on its canvas.
 */
const DictationWaveform = memo(function DictationWaveform({
  color,
}: {
  color: string;
}) {
  const tick = useDictationMeterTick();
  const [levels, setLevels] = useState<number[]>([]);

  useEffect(() => {
    const { active, level } = getDictationMeterSnapshot();
    if (!active) return;
    setLevels((previous) =>
      previous.length < LEVEL_BUFFER_LENGTH
        ? [...previous, level]
        : [...previous.slice(previous.length - LEVEL_BUFFER_LENGTH + 1), level],
    );
  }, [tick]);

  return (
    <View style={waveStyles.container}>
      <View style={waveStyles.row}>
        {levels.map((level, idx) => {
          const h = Math.max(
            MIN_BAR_HEIGHT,
            Math.min(WAVEFORM_HEIGHT, level * WAVEFORM_HEIGHT),
          );
          return (
            <View
              key={idx}
              style={{
                width: BAR_WIDTH,
                marginRight: BAR_GAP,
                height: h,
                borderRadius: 1,
                backgroundColor: color,
              }}
            />
          );
        })}
      </View>
    </View>
  );
});

const waveStyles = StyleSheet.create({
  transcript: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 4,
    paddingTop: 1,
  },
  placeholder: {
    fontFamily: fonts.sans.regular,
    fontSize: 15,
    fontStyle: "italic",
    lineHeight: 21,
  },
  container: {
    flex: 1,
    height: WAVEFORM_HEIGHT,
    minWidth: 0,
    justifyContent: "center",
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    height: WAVEFORM_HEIGHT,
  },
});

const formatElapsed = (ms: number): string => {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
};

type ColorMap = ReturnType<typeof useColors>;

const makeStyles = (colors: ColorMap) =>
  StyleSheet.create({
    recordingBar: {
      flex: 1,
      gap: 7,
      minWidth: 0,
      paddingVertical: 1,
    },
    recordingRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      minWidth: 0,
    },
    timer: {
      flexShrink: 0,
      color: fadeHex(colors.text, 0.7),
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      fontVariant: ["tabular-nums"],
      paddingHorizontal: 4,
    },
    control: {
      flexShrink: 0,
      alignItems: "center",
      justifyContent: "center",
      width: 26,
      height: 26,
      borderRadius: 13,
      backgroundColor: fadeHex(colors.text, 0.07),
    },
    sendControl: {
      flexShrink: 0,
      alignItems: "center",
      justifyContent: "center",
      width: 28,
      height: 28,
      marginLeft: 2,
      borderRadius: 14,
      backgroundColor: colors.accent,
    },
  });
