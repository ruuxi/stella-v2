/**
 * Mobile mirror of desktop's DictationRecordingBar
 * (`desktop/src/features/dictation/components/DictationRecordingBar.tsx`).
 * The composer pill grows as cumulative text wraps, while the waveform
 * and controls remain anchored underneath:
 *
 *   A live transcript that can wrap and revise
 *   [waveform — flex 1]   [0:24]   [X]   [✓]   [↑]
 *
 * The trailing send (↑) is optional: when `onSend` is given it stops dictation
 * and, once the transcript lands, auto-submits the message in one tap.
 *
 * Both transcript and meter use leaf-level external stores. The waveform stays
 * in RN's native render path, and word fades run on the native driver.
 */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { useReducedMotion } from "react-native-reanimated";
import { Icon } from "./Icon";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";
import { useDictationMeter } from "../lib/dictation-meter";
import {
  tokenizeDictationTranscript,
  useDictationTranscriptPreview,
} from "../lib/dictation-transcript-preview";

const BAR_WIDTH = 2;
const BAR_GAP = 2;
const WAVEFORM_HEIGHT = 28;
const MIN_BAR_HEIGHT = 1;
const LEVEL_BUFFER_LENGTH = 64;

type Props = {
  onCancel: () => void;
  onConfirm: () => void;
  /** When provided, stop dictation and auto-send once the transcript lands. */
  onSend?: () => void;
};

export const DictationRecordingBar = memo(function DictationRecordingBar({
  onCancel,
  onConfirm,
  onSend,
}: Props) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const meter = useDictationMeter();
  const transcript = useDictationTranscriptPreview();
  const reduceMotion = useReducedMotion();
  const [now, setNow] = useState(Date.now());
  const [levels, setLevels] = useState<number[]>([]);

  useEffect(() => {
    setLevels((previous) => [
      ...previous.slice(-(LEVEL_BUFFER_LENGTH - 1)),
      meter.level,
    ]);
  }, [meter.level, meter.revision]);

  useEffect(() => {
    if (!meter.active) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [meter.active]);
  const durationMs = meter.active ? Math.max(0, now - meter.startedAt) : 0;

  return (
    <View style={styles.recordingBar}>
      <LiveTranscript
        text={transcript.text}
        revision={transcript.revision}
        stableWordCount={transcript.stableWordCount}
        color={fadeHex(colors.text, 0.66)}
        reduceMotion={reduceMotion}
      />
      <View style={styles.recordingRow}>
        <DictationWaveform levels={levels} color={fadeHex(colors.text, 0.7)} />
        <Text style={styles.timer} accessibilityLiveRegion="polite">
          {formatElapsed(durationMs)}
        </Text>
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

function LiveTranscript({
  text,
  revision,
  stableWordCount,
  color,
  reduceMotion,
}: {
  text: string;
  revision: number;
  stableWordCount: number;
  color: string;
  reduceMotion: boolean;
}) {
  if (!text) return null;
  const words = tokenizeDictationTranscript(text);
  return (
    <View
      style={waveStyles.transcript}
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
}

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

function DictationWaveform({
  levels,
  color,
}: {
  levels: number[];
  color: string;
}) {
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
}

const waveStyles = StyleSheet.create({
  transcript: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 4,
    paddingTop: 1,
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
