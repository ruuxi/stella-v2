import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Icon } from "../Icon";
import { configurePlaybackAudioSession } from "../../lib/mobile-audio-session";
import { evidenceAudioFileUri } from "../../lib/chat-evidence-previews";
import type { StoredPhoneAccess } from "../../lib/phone-access";
import type { Colors } from "../../theme/colors";

const BAR_COUNT = 44;
const BAR_WIDTH = 2;
const BAR_GAP = 2;

/**
 * Collapse the stored ~200 peaks into the bars this card actually draws. The
 * numbers come from the native extractor; nothing here reads the audio.
 */
const barsFrom = (peaks: readonly number[]): number[] => {
  if (peaks.length === 0) return [];
  const bars: number[] = [];
  const span = peaks.length / BAR_COUNT;
  for (let index = 0; index < BAR_COUNT; index += 1) {
    const start = Math.floor(index * span);
    const end = Math.max(start + 1, Math.floor((index + 1) * span));
    let peak = 0;
    for (
      let cursor = start;
      cursor < end && cursor < peaks.length;
      cursor += 1
    ) {
      peak = Math.max(peak, peaks[cursor] ?? 0);
    }
    bars.push(peak);
  }
  const loudest = Math.max(...bars, 0.0001);
  return bars.map((value) => Math.max(0.06, value / loudest));
};

/**
 * An audio attachment as its own waveform, with a cursor that runs along it.
 *
 * The bars are drawn from the peaks array alone — the file itself is not
 * touched until the first press, when a player is created for it and torn down
 * with the card. The cursor is a Reanimated timing animation over the known
 * duration rather than a per-frame position read, so playback costs the JS
 * thread nothing while it runs.
 */
export function WaveformCard({
  filePath,
  conversationId,
  access,
  peaks,
  durationMs,
  width,
  height,
  colors,
  label,
}: {
  filePath: string;
  conversationId: string;
  access: StoredPhoneAccess | null;
  peaks: readonly number[];
  durationMs: number;
  width: number;
  height: number;
  colors: Colors;
  label: string;
}) {
  const bars = useMemo(() => barsFrom(peaks), [peaks]);
  const trackWidth = BAR_COUNT * BAR_WIDTH + (BAR_COUNT - 1) * BAR_GAP;
  const progress = useSharedValue(0);
  const playerRef = useRef<AudioPlayer | null>(null);
  const subscriptionRef = useRef<{ remove: () => void } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);

  const attachCompletion = useCallback(
    (player: AudioPlayer) => {
      const subscription = player.addListener(
        "playbackStatusUpdate",
        (status) => {
          if (!status.didJustFinish) return;
          cancelAnimation(progress);
          progress.value = 0;
          setPlaying(false);
          void player.seekTo(0);
        },
      );
      subscriptionRef.current = subscription;
    },
    [progress],
  );

  useEffect(
    () => () => {
      cancelAnimation(progress);
      subscriptionRef.current?.remove();
      subscriptionRef.current = null;
      const player = playerRef.current;
      playerRef.current = null;
      if (player) {
        try {
          player.pause();
          player.remove();
        } catch {
          // Already torn down by the module's own cleanup.
        }
      }
    },
    [progress],
  );

  const toggle = useCallback(() => {
    const existing = playerRef.current;
    if (existing && existing.playing) {
      existing.pause();
      cancelAnimation(progress);
      setPlaying(false);
      return;
    }
    if (existing) {
      const from =
        existing.duration > 0 ? existing.currentTime / existing.duration : 0;
      const remaining = Math.max(120, durationMs * (1 - from));
      void configurePlaybackAudioSession()
        .then(() => {
          if (!playerRef.current) return;
          if (from >= 0.999) {
            void playerRef.current.seekTo(0);
            progress.value = 0;
          }
          playerRef.current.play();
          setPlaying(true);
          progress.value = withTiming(1, {
            duration: from >= 0.999 ? durationMs : remaining,
            easing: Easing.linear,
          });
        })
        .catch(() => undefined);
      return;
    }
    setLoading(true);
    void evidenceAudioFileUri({
      filePath,
      kind: "audio",
      conversationId,
      access,
    })
      .then(async (uri) => {
        if (!(await configurePlaybackAudioSession())) return;
        const player = createAudioPlayer({ uri });
        playerRef.current = player;
        attachCompletion(player);
        player.play();
        setPlaying(true);
        progress.value = 0;
        progress.value = withTiming(1, {
          duration: Math.max(120, durationMs),
          easing: Easing.linear,
        });
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [
    access,
    attachCompletion,
    conversationId,
    durationMs,
    filePath,
    progress,
  ]);

  const cursorStyle = useAnimatedStyle(() => ({
    width: progress.value * trackWidth,
  }));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${playing ? "Pause" : "Play"} ${label}`}
      onPress={toggle}
      style={({ pressed }) => [
        styles.card,
        {
          width,
          height,
          backgroundColor: colors.surface,
          opacity: pressed ? 0.78 : 1,
        },
      ]}
    >
      <View style={[styles.button, { backgroundColor: colors.accent }]}>
        <Icon
          name={loading ? "waveform" : playing ? "pause" : "play"}
          size={14}
          color={colors.accentForeground}
        />
      </View>
      <View style={[styles.track, { width: trackWidth }]}>
        <View style={styles.bars}>
          {bars.map((value, index) => (
            <View
              key={index}
              style={[
                styles.bar,
                {
                  height: Math.max(2, value * (height - 44)),
                  backgroundColor: colors.borderStrong,
                },
              ]}
            />
          ))}
        </View>
        <Animated.View style={[styles.played, cursorStyle]}>
          <View style={[styles.bars, { width: trackWidth }]}>
            {bars.map((value, index) => (
              <View
                key={index}
                style={[
                  styles.bar,
                  {
                    height: Math.max(2, value * (height - 44)),
                    backgroundColor: colors.accent,
                  },
                ]}
              />
            ))}
          </View>
        </Animated.View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { borderRadius: BAR_WIDTH, width: BAR_WIDTH },
  bars: {
    alignItems: "center",
    flexDirection: "row",
    gap: BAR_GAP,
    height: "100%",
  },
  button: {
    alignItems: "center",
    borderRadius: 13,
    height: 26,
    justifyContent: "center",
    width: 26,
  },
  card: {
    alignItems: "center",
    borderRadius: 14,
    flexDirection: "row",
    gap: 10,
    overflow: "hidden",
    paddingHorizontal: 12,
  },
  played: {
    left: 0,
    overflow: "hidden",
    position: "absolute",
    top: 0,
    bottom: 0,
  },
  track: { flexDirection: "row", height: "54%", justifyContent: "flex-start" },
});
