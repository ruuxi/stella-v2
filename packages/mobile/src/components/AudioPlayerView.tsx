import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import {
  setAudioModeAsync,
  useAudioPlayer,
  useAudioPlayerStatus,
} from "expo-audio";
import { LinearGradient } from "expo-linear-gradient";
import { Icon } from "./Icon";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import { useColors } from "../theme/theme-context";
import { fonts } from "../theme/fonts";

type AudioPlayerViewProps = {
  /** `file://` URI of the decoded clip — see `writeArtifactMediaFile`. */
  uri: string;
  title: string;
  subtitle: string;
};

/** Matches the `gobackward.15` / `goforward.15` glyphs on the skip buttons. */
const SKIP_SECONDS = 15;

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const formatTime = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const paddedSecs = String(secs).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${paddedSecs}`
    : `${minutes}:${paddedSecs}`;
};

/**
 * Full-surface audio player for the artifact viewer: artwork tile, filename,
 * a draggable scrubber with elapsed/remaining times, and a transport row.
 *
 * Replaces the WebView `<audio controls>` bar the viewer used to show, which
 * rendered as a ~40px browser default control floating in an otherwise empty
 * dark screen.
 */
export function AudioPlayerView({ uri, title, subtitle }: AudioPlayerViewProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  // 200ms keeps the scrubber moving smoothly without churning the tree; the
  // expo-audio default (500ms) reads as a stuttering progress bar.
  const player = useAudioPlayer({ uri }, { updateInterval: 200 });
  const status = useAudioPlayerStatus(player);

  // Playback should be audible with the ringer switch flipped, the same way
  // read-aloud configures the session.
  useEffect(() => {
    void setAudioModeAsync({ playsInSilentMode: true }).catch(() => undefined);
  }, []);

  const duration =
    Number.isFinite(status.duration) && status.duration > 0
      ? status.duration
      : 0;
  const seekable = status.isLoaded && duration > 0;

  // While a drag is in flight the knob follows the finger, not the player.
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const position = clamp(scrubTime ?? status.currentTime, 0, duration || 0);
  const progress = duration > 0 ? position / duration : 0;

  // The pan responder is created once, so everything it reads lives in refs.
  const trackWidthRef = useRef(0);
  const durationRef = useRef(0);
  const seekableRef = useRef(false);
  durationRef.current = duration;
  seekableRef.current = seekable;

  const onTrackLayout = useCallback((event: LayoutChangeEvent) => {
    trackWidthRef.current = event.nativeEvent.layout.width;
  }, []);

  const seekTo = useCallback(
    (seconds: number) => {
      void player
        .seekTo(clamp(seconds, 0, durationRef.current))
        .catch(() => undefined);
    },
    [player],
  );

  const panResponder = useMemo(() => {
    // `locationX` is relative to the touch target; the track's children are
    // `pointerEvents="none"` so the target is always the track itself.
    const timeAt = (locationX: number) =>
      clamp(locationX / (trackWidthRef.current || 1), 0, 1) *
      durationRef.current;

    return PanResponder.create({
      onStartShouldSetPanResponder: () => seekableRef.current,
      onMoveShouldSetPanResponder: () => seekableRef.current,
      onPanResponderGrant: (event) => {
        setScrubTime(timeAt(event.nativeEvent.locationX));
      },
      onPanResponderMove: (event) => {
        setScrubTime(timeAt(event.nativeEvent.locationX));
      },
      onPanResponderRelease: (event) => {
        const target = timeAt(event.nativeEvent.locationX);
        setScrubTime(target);
        // Hold the scrubbed position until the player has actually moved,
        // otherwise the knob snaps back to the pre-seek time for one frame.
        void player
          .seekTo(clamp(target, 0, durationRef.current))
          .catch(() => undefined)
          .finally(() => setScrubTime(null));
      },
      onPanResponderTerminate: () => setScrubTime(null),
    });
  }, [player]);

  const togglePlayback = useCallback(() => {
    if (status.playing) {
      player.pause();
      return;
    }
    // Replaying a finished clip needs an explicit rewind; `play()` alone
    // leaves the player parked at the end.
    if (duration > 0 && status.currentTime >= duration - 0.25) {
      seekTo(0);
    }
    player.play();
  }, [duration, player, seekTo, status.currentTime, status.playing]);

  const skip = useCallback(
    (delta: number) => seekTo((scrubTime ?? status.currentTime) + delta),
    [scrubTime, seekTo, status.currentTime],
  );

  const remaining = duration > 0 ? duration - position : 0;

  return (
    <View style={styles.root}>
      <View style={styles.card}>
        <LinearGradient
          colors={[colors.backgroundStrong, colors.muted]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.artwork}
        >
          <Icon name="waveform" size={72} color={colors.textMuted} />
        </LinearGradient>

        <View style={styles.meta}>
          <Text
            style={styles.title}
            numberOfLines={2}
            maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
          >
            {title}
          </Text>
          {subtitle ? (
            <Text
              style={styles.subtitle}
              numberOfLines={1}
              maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
            >
              {subtitle}
            </Text>
          ) : null}
        </View>

        <View style={styles.scrubber}>
          <View
            style={styles.track}
            onLayout={onTrackLayout}
            hitSlop={{ bottom: 14, top: 14 }}
            accessibilityRole="adjustable"
            accessibilityLabel="Playback position"
            accessibilityValue={{
              min: 0,
              max: Math.round(duration),
              now: Math.round(position),
              text: `${formatTime(position)} of ${formatTime(duration)}`,
            }}
            {...panResponder.panHandlers}
          >
            <View style={styles.trackGroove} pointerEvents="none">
              <View
                style={[styles.trackFill, { width: `${progress * 100}%` }]}
              />
            </View>
            <View
              style={[styles.knob, { left: `${progress * 100}%` }]}
              pointerEvents="none"
            />
          </View>
          <View style={styles.times}>
            <Text style={styles.time} maxFontSizeMultiplier={1.2}>
              {formatTime(position)}
            </Text>
            <Text style={styles.time} maxFontSizeMultiplier={1.2}>
              {duration > 0 ? `-${formatTime(remaining)}` : "--:--"}
            </Text>
          </View>
        </View>

        <View style={styles.transport}>
          <Pressable
            onPress={() => skip(-SKIP_SECONDS)}
            disabled={!seekable}
            accessibilityRole="button"
            accessibilityLabel={`Back ${SKIP_SECONDS} seconds`}
            hitSlop={12}
            style={({ pressed }) => [
              styles.skipButton,
              pressed && styles.pressed,
              !seekable && styles.disabled,
            ]}
          >
            <Icon name="rewind-15" size={28} color={colors.text} />
          </Pressable>

          <Pressable
            onPress={togglePlayback}
            disabled={!status.isLoaded}
            accessibilityRole="button"
            accessibilityLabel={status.playing ? "Pause" : "Play"}
            style={({ pressed }) => [
              styles.playButton,
              pressed && styles.pressed,
            ]}
          >
            {status.isLoaded ? (
              <Icon
                name={status.playing ? "pause" : "play"}
                size={30}
                color={colors.accentForeground}
                // The play triangle reads as off-centre when centred on its
                // own bounding box; nudge it toward the optical centre.
                style={status.playing ? undefined : styles.playGlyph}
              />
            ) : (
              <ActivityIndicator color={colors.accentForeground} />
            )}
          </Pressable>

          <Pressable
            onPress={() => skip(SKIP_SECONDS)}
            disabled={!seekable}
            accessibilityRole="button"
            accessibilityLabel={`Forward ${SKIP_SECONDS} seconds`}
            hitSlop={12}
            style={({ pressed }) => [
              styles.skipButton,
              pressed && styles.pressed,
              !seekable && styles.disabled,
            ]}
          >
            <Icon name="forward-15" size={28} color={colors.text} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const KNOB_SIZE = 14;

const makeStyles = (colors: ReturnType<typeof useColors>) =>
  StyleSheet.create({
    root: {
      alignItems: "center",
      backgroundColor: colors.background,
      flex: 1,
      justifyContent: "center",
      padding: 24,
    },
    card: {
      alignItems: "center",
      alignSelf: "stretch",
      backgroundColor: colors.card,
      borderColor: colors.border,
      borderRadius: 28,
      borderWidth: StyleSheet.hairlineWidth,
      gap: 24,
      maxWidth: 420,
      paddingHorizontal: 24,
      paddingVertical: 32,
      width: "100%",
    },
    artwork: {
      alignItems: "center",
      aspectRatio: 1,
      borderColor: colors.borderWeak,
      borderRadius: 24,
      borderWidth: StyleSheet.hairlineWidth,
      justifyContent: "center",
      maxWidth: 200,
      width: "62%",
    },
    meta: {
      alignItems: "center",
      gap: 4,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 17,
      letterSpacing: -0.3,
      textAlign: "center",
    },
    subtitle: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      textAlign: "center",
    },
    scrubber: {
      alignSelf: "stretch",
      gap: 8,
    },
    track: {
      height: KNOB_SIZE,
      justifyContent: "center",
    },
    trackGroove: {
      backgroundColor: colors.muted,
      borderRadius: 2,
      height: 4,
      overflow: "hidden",
    },
    trackFill: {
      backgroundColor: colors.accent,
      height: "100%",
    },
    knob: {
      backgroundColor: colors.accent,
      borderRadius: KNOB_SIZE / 2,
      height: KNOB_SIZE,
      marginLeft: -KNOB_SIZE / 2,
      position: "absolute",
      width: KNOB_SIZE,
    },
    times: {
      flexDirection: "row",
      justifyContent: "space-between",
    },
    time: {
      color: colors.textMuted,
      fontFamily: fonts.mono.regular,
      fontSize: 12,
      fontVariant: ["tabular-nums"],
    },
    transport: {
      alignItems: "center",
      flexDirection: "row",
      gap: 28,
      justifyContent: "center",
    },
    skipButton: {
      alignItems: "center",
      height: 44,
      justifyContent: "center",
      width: 44,
    },
    playButton: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: 36,
      height: 72,
      justifyContent: "center",
      width: 72,
    },
    playGlyph: {
      marginLeft: 3,
    },
    pressed: {
      opacity: 0.6,
    },
    disabled: {
      opacity: 0.35,
    },
  });
