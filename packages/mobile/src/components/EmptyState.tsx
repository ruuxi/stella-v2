import { useEffect, useId, useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import Svg, {
  Circle,
  Defs,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop,
} from "react-native-svg";
import { useAppVisible } from "../lib/use-app-visible";
import { tapLight } from "../lib/haptics";
import { CONTENT_MAX_FONT_SCALE } from "../lib/setup-text-defaults";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";
import { useColors, useTheme } from "../theme/theme-context";
import { GlassSurface } from "./glass";
import { Icon } from "./Icon";
import { StellaMarkHero } from "./stella-mark/StellaMarkHero";

export type EmptyStateMotif = "files" | "schedule" | "apps";

const ART = 184;
const CENTER = ART / 2;
const MARK = 74;
/** One clock drives every motif; each motion completes a whole number of cycles in it. */
const CLOCK_MS = 60_000;
const TAU = Math.PI * 2;

const BRAND = ["#00aad8", "#3493d9", "#4878db", "#7449c5", "#be57a4"] as const;

/**
 * The empty page: Stella's own character, breathing and looking about, with a
 * quiet motif behind it for the page it sits on (pages of files, a clock
 * dial, a ring of apps), one line saying what will appear here, and the
 * obvious next step when there is one.
 */
export function EmptyState({
  motif,
  message,
  action,
  paused = false,
}: {
  motif: EmptyStateMotif;
  message: string;
  action?: { label: string; onPress: () => void };
  /** Holds every loop still, e.g. while the page is hidden. */
  paused?: boolean;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const reduceMotion = useReducedMotion();
  const appVisible = useAppVisible();
  const running = appVisible && !paused && !reduceMotion;
  const clock = useSharedValue(0);

  useEffect(() => {
    if (!running) {
      cancelAnimation(clock);
      return;
    }
    const start = clock.value % 1;
    clock.value = start;
    clock.value = withTiming(
      1,
      { duration: CLOCK_MS * (1 - start), easing: Easing.linear },
      (finished) => {
        if (!finished) return;
        clock.value = 0;
        clock.value = withRepeat(
          withTiming(1, { duration: CLOCK_MS, easing: Easing.linear }),
          -1,
          false,
        );
      },
    );
    return () => cancelAnimation(clock);
  }, [clock, running]);

  return (
    <View style={styles.root} accessibilityRole="summary">
      <Animated.View
        entering={reduceMotion ? undefined : FadeIn.duration(520)}
        style={styles.art}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Halo clock={clock} />
        {motif === "files" ? <FilesMotif clock={clock} colors={colors} /> : null}
        {motif === "schedule" ? (
          <ScheduleMotif clock={clock} colors={colors} />
        ) : null}
        {motif === "apps" ? <AppsMotif clock={clock} colors={colors} /> : null}
        <View
          style={[
            styles.mark,
            motif === "files" ? styles.markLow : null,
          ]}
        >
          <StellaMarkHero
            size={MARK}
            faceColor={colors.background}
            paused={!running}
          />
        </View>
      </Animated.View>
      <Animated.View
        entering={
          reduceMotion ? undefined : FadeInDown.duration(480).delay(140)
        }
        style={styles.copy}
      >
        <Text
          style={styles.message}
          maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
        >
          {message}
        </Text>
        {action ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={action.label}
            onPress={() => {
              tapLight();
              action.onPress();
            }}
            style={({ pressed }) => [
              styles.actionPress,
              pressed && styles.actionPressed,
            ]}
          >
            <GlassSurface
              legible
              ringed
              interactive
              radius={20}
              style={styles.action}
            >
              <Icon name="sparkles" size={14} color={colors.accent} />
              <Text
                style={styles.actionLabel}
                maxFontSizeMultiplier={CONTENT_MAX_FONT_SCALE}
              >
                {action.label}
              </Text>
            </GlassSurface>
          </Pressable>
        ) : (
          <View style={styles.actionSpace} />
        )}
      </Animated.View>
    </View>
  );
}

function Halo({ clock }: { clock: SharedValue<number> }) {
  const { isDark } = useTheme();
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, "");
  const style = useAnimatedStyle(() => {
    const wave = Math.sin(clock.value * TAU * 10);
    return {
      opacity: 0.85 + 0.15 * wave,
      transform: [{ scale: 1 + 0.05 * wave }],
    };
  });
  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]}>
      <Svg width={ART} height={ART}>
        <Defs>
          <RadialGradient id={`${uid}-halo`} cx="50%" cy="50%" r="50%">
            <Stop offset={0} stopColor={BRAND[2]} stopOpacity={isDark ? 0.34 : 0.22} />
            <Stop offset={0.55} stopColor={BRAND[3]} stopOpacity={isDark ? 0.12 : 0.08} />
            <Stop offset={1} stopColor={BRAND[3]} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={CENTER} cy={CENTER} r={CENTER} fill={`url(#${uid}-halo)`} />
      </Svg>
    </Animated.View>
  );
}

const PAGE_W = 58;
const PAGE_H = 74;

const PAGES = [
  { x: -42, y: -30, rotate: -15, phase: 0, variant: "lines" },
  { x: 42, y: -30, rotate: 15, phase: 2.1, variant: "media" },
  { x: 0, y: -42, rotate: 0, phase: 4.2, variant: "image" },
] as const;

function FilesMotif({
  clock,
  colors,
}: {
  clock: SharedValue<number>;
  colors: Colors;
}) {
  return (
    <>
      {PAGES.map((page) => (
        <FilePage key={page.variant} page={page} clock={clock} colors={colors} />
      ))}
    </>
  );
}

function FilePage({
  page,
  clock,
  colors,
}: {
  page: (typeof PAGES)[number];
  clock: SharedValue<number>;
  colors: Colors;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, "");
  const style = useAnimatedStyle(() => {
    const angle = clock.value * TAU * 15 + page.phase;
    return {
      transform: [
        { translateX: page.x },
        { translateY: page.y - 3.5 * Math.sin(angle) },
        { rotate: `${page.rotate + 1.6 * Math.cos(angle)}deg` },
      ],
    };
  });
  const line = fadeHex(colors.textMuted, 0.28);
  return (
    <Animated.View style={[styles.page, style]}>
      <Svg width={PAGE_W} height={PAGE_H}>
        <Defs>
          <LinearGradient id={`${uid}-fill`} x1="0" y1="1" x2="1" y2="0">
            <Stop offset={0} stopColor={BRAND[0]} />
            <Stop offset={0.5} stopColor={BRAND[2]} />
            <Stop offset={1} stopColor={BRAND[4]} />
          </LinearGradient>
        </Defs>
        <Rect
          x={0.5}
          y={0.5}
          width={PAGE_W - 1}
          height={PAGE_H - 1}
          rx={11}
          fill={colors.surface}
          stroke={colors.border}
          strokeWidth={1}
        />
        {page.variant === "image" ? (
          <>
            <Rect x={8} y={8} width={PAGE_W - 16} height={30} rx={6} fill={`url(#${uid}-fill)`} opacity={0.9} />
            <Circle cx={PAGE_W - 18} cy={17} r={3.2} fill="#ffffff" opacity={0.85} />
            <Path d={`M8 34 L22 22 L32 31 L38 26 L${PAGE_W - 8} 36 L${PAGE_W - 8} 38 L8 38 Z`} fill="#ffffff" opacity={0.35} />
            <Rect x={8} y={47} width={34} height={4} rx={2} fill={line} />
            <Rect x={8} y={56} width={24} height={4} rx={2} fill={line} />
          </>
        ) : null}
        {page.variant === "lines" ? (
          <>
            <Rect x={8} y={10} width={24} height={5} rx={2.5} fill={`url(#${uid}-fill)`} opacity={0.85} />
            <Rect x={8} y={23} width={PAGE_W - 16} height={4} rx={2} fill={line} />
            <Rect x={8} y={32} width={PAGE_W - 22} height={4} rx={2} fill={line} />
            <Rect x={8} y={41} width={PAGE_W - 18} height={4} rx={2} fill={line} />
            <Rect x={8} y={50} width={22} height={4} rx={2} fill={line} />
          </>
        ) : null}
        {page.variant === "media" ? (
          <>
            <Circle cx={PAGE_W / 2} cy={28} r={13} fill={`url(#${uid}-fill)`} opacity={0.9} />
            <Path d={`M${PAGE_W / 2 - 3.5} 22.5 L${PAGE_W / 2 + 5.5} 28 L${PAGE_W / 2 - 3.5} 33.5 Z`} fill="#ffffff" />
            <Rect x={8} y={50} width={PAGE_W - 16} height={4} rx={2} fill={line} />
            <Rect x={14} y={59} width={PAGE_W - 28} height={4} rx={2} fill={line} />
          </>
        ) : null}
      </Svg>
    </Animated.View>
  );
}

const DIAL_R = 70;
const TICKS = Array.from({ length: 12 }, (_, index) => index);

function ScheduleMotif({
  clock,
  colors,
}: {
  clock: SharedValue<number>;
  colors: Colors;
}) {
  const uid = useId().replace(/[^a-zA-Z0-9-]/g, "");
  const sweep = useAnimatedStyle(() => ({
    transform: [{ rotate: `${((clock.value * 5) % 1) * 360}deg` }],
  }));
  const trailStart = (-110 * Math.PI) / 180;
  const trail = `M ${CENTER + DIAL_R * Math.sin(trailStart)} ${CENTER - DIAL_R * Math.cos(trailStart)} A ${DIAL_R} ${DIAL_R} 0 0 1 ${CENTER} ${CENTER - DIAL_R}`;
  return (
    <>
      <Svg width={ART} height={ART} style={StyleSheet.absoluteFill}>
        <Circle
          cx={CENTER}
          cy={CENTER}
          r={DIAL_R}
          fill="none"
          stroke={colors.border}
          strokeWidth={1.25}
        />
        {TICKS.map((index) => {
          const angle = (index / 12) * TAU;
          const major = index % 3 === 0;
          const r = DIAL_R - (major ? 10 : 9);
          return (
            <Circle
              key={index}
              cx={CENTER + r * Math.sin(angle)}
              cy={CENTER - r * Math.cos(angle)}
              r={major ? 2.2 : 1.3}
              fill={fadeHex(colors.textMuted, major ? 0.55 : 0.32)}
            />
          );
        })}
      </Svg>
      <Animated.View style={[StyleSheet.absoluteFill, sweep]}>
        <Svg width={ART} height={ART}>
          <Defs>
            <LinearGradient
              id={`${uid}-trail`}
              x1={CENTER + DIAL_R * Math.sin(trailStart)}
              y1={CENTER - DIAL_R * Math.cos(trailStart)}
              x2={CENTER}
              y2={CENTER - DIAL_R}
              gradientUnits="userSpaceOnUse"
            >
              <Stop offset={0} stopColor={BRAND[0]} stopOpacity={0} />
              <Stop offset={0.6} stopColor={BRAND[2]} stopOpacity={0.5} />
              <Stop offset={1} stopColor={BRAND[4]} stopOpacity={1} />
            </LinearGradient>
            <RadialGradient id={`${uid}-glow`} cx="50%" cy="50%" r="50%">
              <Stop offset={0} stopColor={BRAND[4]} stopOpacity={0.45} />
              <Stop offset={1} stopColor={BRAND[4]} stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Path
            d={trail}
            fill="none"
            stroke={`url(#${uid}-trail)`}
            strokeWidth={3}
            strokeLinecap="round"
          />
          <Circle cx={CENTER} cy={CENTER - DIAL_R} r={13} fill={`url(#${uid}-glow)`} />
          <Circle cx={CENTER} cy={CENTER - DIAL_R} r={5} fill={BRAND[4]} />
          <Circle cx={CENTER} cy={CENTER - DIAL_R} r={2} fill="#ffffff" opacity={0.9} />
        </Svg>
      </Animated.View>
    </>
  );
}

const TILE = 32;
const TILE_R = 70;
const TILES = Array.from({ length: 6 }, (_, index) => index);
const GLYPHS = ["circle", "square", "triangle", "circle", "square", "triangle"] as const;

function AppsMotif({
  clock,
  colors,
}: {
  clock: SharedValue<number>;
  colors: Colors;
}) {
  const orbit = useAnimatedStyle(() => ({
    transform: [{ rotate: `${clock.value * 360}deg` }],
  }));
  return (
    <Animated.View style={[StyleSheet.absoluteFill, orbit]}>
      {TILES.map((index) => (
        <AppTile key={index} index={index} clock={clock} colors={colors} />
      ))}
    </Animated.View>
  );
}

function AppTile({
  index,
  clock,
  colors,
}: {
  index: number;
  clock: SharedValue<number>;
  colors: Colors;
}) {
  const angle = (index / 6) * TAU;
  const x = TILE_R * Math.sin(angle);
  const y = -TILE_R * Math.cos(angle);
  const color = BRAND[index % BRAND.length];
  const style = useAnimatedStyle(() => {
    const wave = Math.sin(clock.value * TAU * 15 - (index * TAU) / 6);
    const lift = wave > 0 ? wave * wave : 0;
    return {
      opacity: 0.62 + 0.38 * lift,
      transform: [
        { translateX: x },
        { translateY: y },
        { rotate: `${-clock.value * 360}deg` },
        { scale: 0.94 + 0.12 * lift },
      ],
    };
  });
  const glyph = GLYPHS[index];
  const c = TILE / 2;
  return (
    <Animated.View style={[styles.tile, style]}>
      <Svg width={TILE} height={TILE}>
        <Rect
          x={0.5}
          y={0.5}
          width={TILE - 1}
          height={TILE - 1}
          rx={9}
          fill={colors.surface}
          stroke={colors.border}
          strokeWidth={1}
        />
        {glyph === "circle" ? <Circle cx={c} cy={c} r={6} fill={color} /> : null}
        {glyph === "square" ? (
          <Rect x={c - 5.5} y={c - 5.5} width={11} height={11} rx={3} fill={color} />
        ) : null}
        {glyph === "triangle" ? (
          <Path d={`M${c} ${c - 6.5} L${c + 6.5} ${c + 5} L${c - 6.5} ${c + 5} Z`} fill={color} strokeLinejoin="round" />
        ) : null}
      </Svg>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  page: {
    height: PAGE_H,
    left: CENTER - PAGE_W / 2,
    position: "absolute",
    top: CENTER - PAGE_H / 2,
    width: PAGE_W,
  },
  tile: {
    height: TILE,
    left: CENTER - TILE / 2,
    position: "absolute",
    top: CENTER - TILE / 2,
    width: TILE,
  },
});

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    root: {
      alignItems: "center",
      flex: 1,
      justifyContent: "center",
      paddingBottom: 56,
      paddingHorizontal: 32,
    },
    art: {
      height: ART,
      width: ART,
    },
    mark: {
      height: MARK,
      left: CENTER - MARK / 2,
      position: "absolute",
      top: CENTER - MARK / 2,
      width: MARK,
    },
    markLow: {
      top: CENTER - MARK / 2 + 26,
    },
    copy: {
      alignItems: "center",
      gap: 18,
      marginTop: 22,
    },
    message: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 17,
      letterSpacing: -0.35,
      lineHeight: 23,
      maxWidth: 300,
      textAlign: "center",
    },
    actionPress: {
      borderRadius: 20,
    },
    actionPressed: {
      opacity: 0.7,
      transform: [{ scale: 0.97 }],
    },
    action: {
      alignItems: "center",
      flexDirection: "row",
      gap: 7,
      height: 40,
      paddingHorizontal: 18,
    },
    actionSpace: {
      height: 40,
    },
    actionLabel: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 15,
      letterSpacing: -0.25,
    },
  });
