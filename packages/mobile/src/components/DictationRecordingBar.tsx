import { memo, useEffect, useMemo, useState } from "react";
import { type AudioRecorder, useAudioRecorderState } from "expo-audio";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Icon } from "./Icon";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";

const BAR_WIDTH = 2;
const BAR_GAP = 2;
const WAVEFORM_HEIGHT = 28;
const MIN_BAR_HEIGHT = 1;
const LEVEL_BUFFER_LENGTH = 64;

const RECORDER_TICK_MS = 80;

type Props = {
  recorder: AudioRecorder;
  onCancel: () => void;
  onConfirm: () => void;

  onSend?: () => void;
};

export const DictationRecordingBar = memo(function DictationRecordingBar({
  recorder,
  onCancel,
  onConfirm,
  onSend,
}: Props) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const recorderState = useAudioRecorderState(recorder, RECORDER_TICK_MS);
  const [levels, setLevels] = useState<number[]>([]);

  useEffect(() => {
    if (!recorderState.isRecording) return;
    const amp = normalizeMetering(recorderState.metering);
    setLevels((previous) => [
      ...previous.slice(-(LEVEL_BUFFER_LENGTH - 1)),
      amp,
    ]);
  }, [
    recorderState.durationMillis,
    recorderState.isRecording,
    recorderState.metering,
  ]);

  return (
    <>
      <DictationWaveform
        levels={levels}
        color={fadeHex(colors.text, 0.7)}
      />
      <Text style={styles.timer} accessibilityLiveRegion="polite">
        {formatElapsed(recorderState.durationMillis)}
      </Text>
      <Pressable
        onPress={onCancel}
        accessibilityLabel="Cancel dictation"
        hitSlop={6}
        style={styles.control}
      >
        <Icon name="x" size={14} color={fadeHex(colors.text, 0.75)} weight="semibold" />
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
    </>
  );
});

const normalizeMetering = (db: number | undefined): number => {
  if (db === undefined || !isFinite(db)) return 0;
  const clamped = Math.max(-50, Math.min(0, db));
  return (clamped + 50) / 50;
};

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
