import { useEffect, type ReactNode } from "react";
import {
  BackHandler,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
} from "react-native-reanimated";
import {
  closeDrawer,
  drawerBlur,
  drawerProgress,
  drawerVeil,
  openDrawer,
  useDrawerLive,
  useDrawerMetrics,
  useDrawerOpen,
  useDrawerPan,
} from "../../lib/drawer";
import { tapLight } from "../../lib/haptics";
import { BlurView } from "expo-blur";
import { useColors, useTheme } from "../../theme/theme-context";
import { GlassIconButton } from "../GlassIconButton";

const CLAMP = Extrapolation.CLAMP;
const AnimatedBlur = Animated.createAnimatedComponent(BlurView);
const BLUR = Platform.OS === "ios";
const PAGE_BLUR = 30;
const PANEL_BLUR = 34;

export const DRAWER_CHEVRON_SIZE = 44;

export function DrawerStage({
  children,
  panel,
  enabled,
  chevron,
}: {
  children: ReactNode;
  panel: ReactNode;
  enabled: boolean;
  chevron: {
    left: number;
    top: number;
    openLabel: string;
    closeLabel: string;
  };
}) {
  const colors = useColors();
  const { isDark } = useTheme();
  const tint = isDark ? "dark" : "light";
  const { travel, scale, radius } = useDrawerMetrics();
  const reduce = useReducedMotion();
  const live = useDrawerLive();
  const open = useDrawerOpen();
  const p = drawerProgress;
  const floor = colors.background;

  const rest = useSharedValue(0);
  useAnimatedReaction(
    () => p.value,
    (v) => {
      if (rest.value === 0 && v >= 0.985) {
        rest.value = 1;
        runOnJS(tapLight)();
      } else if (rest.value === 1 && v <= 0.003) {
        rest.value = 0;
        runOnJS(tapLight)();
      }
    },
  );

  useEffect(() => {
    if (!open) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      closeDrawer();
      return true;
    });
    return () => sub.remove();
  }, [open]);

  const stage = useAnimatedStyle(() => {
    const v = p.value;
    const s = reduce ? 1 : 1 - (1 - scale) * Math.min(v, 1.2);
    return {
      transform: [{ translateX: v * travel }, { scale: s }],
      borderRadius: interpolate(v, [0, 0.12], [0, radius], CLAMP),
    };
  });
  const clip = useAnimatedStyle(() => ({
    borderRadius: interpolate(p.value, [0, 0.12], [0, radius], CLAMP),
  }));
  const fade = useAnimatedStyle(() => ({
    opacity: drawerVeil(p.value),
  }));
  const pageBlur = useAnimatedProps(() => ({
    intensity: reduce ? 0 : drawerBlur(p.value) * PAGE_BLUR,
  }));

  const panelStyle = useAnimatedStyle(() => {
    const v = Math.min(p.value, 1);
    return {
      opacity: interpolate(v, [0, 0.4], [0, 1], CLAMP),
      transform: reduce
        ? []
        : [
            {
              translateX: interpolate(v, [0, 1], [-travel * 0.18, 0], CLAMP),
            },
            { scale: interpolate(v, [0, 1], [0.95, 1], CLAMP) },
          ],
    };
  });
  const panelFocus = useAnimatedProps(() => ({
    intensity: reduce
      ? 0
      : interpolate(p.value, [0, 0.9], [PANEL_BLUR, 0], CLAMP),
  }));
  const panelFocusStyle = useAnimatedStyle(() => ({
    opacity: p.value > 0.97 ? 0 : 1,
  }));

  const openPan = useDrawerPan("open", enabled && !open);
  const closePan = useDrawerPan("close");
  const tap = Gesture.Tap().onEnd(() => {
    runOnJS(closeDrawer)();
  });
  const catcher = Gesture.Exclusive(closePan, tap);
  const panelPan = useDrawerPan("close");

  return (
    <View style={[styles.root, { backgroundColor: floor }]}>
      <GestureDetector gesture={panelPan}>
        <Animated.View
          style={[styles.panel, { width: travel }, panelStyle]}
          pointerEvents={open ? "auto" : "none"}
          accessibilityElementsHidden={!open}
          importantForAccessibility={open ? "auto" : "no-hide-descendants"}
          onAccessibilityEscape={closeDrawer}
        >
          {panel}
          {live && BLUR ? (
            <AnimatedBlur
              pointerEvents="none"
              tint={tint}
              animatedProps={panelFocus}
              style={[StyleSheet.absoluteFill, panelFocusStyle]}
            />
          ) : null}
        </Animated.View>
      </GestureDetector>

      <GestureDetector gesture={openPan}>
        <Animated.View
          style={[styles.stage, { backgroundColor: floor }, stage]}
          accessibilityElementsHidden={open}
          importantForAccessibility={open ? "no-hide-descendants" : "auto"}
        >
          <Animated.View style={[styles.clip, clip]}>
            {children}
            {live ? (
              <>
                {BLUR ? (
                  <AnimatedBlur
                    pointerEvents="none"
                    tint={tint}
                    animatedProps={pageBlur}
                    style={StyleSheet.absoluteFill}
                  />
                ) : null}
                <Animated.View
                  pointerEvents="none"
                  style={[
                    StyleSheet.absoluteFill,
                    { backgroundColor: floor },
                    fade,
                  ]}
                />
              </>
            ) : null}
          </Animated.View>
          {open ? (
            <GestureDetector gesture={catcher}>
              <View
                style={StyleSheet.absoluteFill}
                accessible={false}
                importantForAccessibility="no"
                testID="mobile-nav-close"
              />
            </GestureDetector>
          ) : null}
        </Animated.View>
      </GestureDetector>

      {live && enabled ? <FloatingChevron {...chevron} open={open} /> : null}
    </View>
  );
}

function FloatingChevron({
  left,
  top,
  open,
  openLabel,
  closeLabel,
}: {
  left: number;
  top: number;
  open: boolean;
  openLabel: string;
  closeLabel: string;
}) {
  const { width, height } = useWindowDimensions();
  const { travel, scale } = useDrawerMetrics();
  const reduce = useReducedMotion();
  const cx = left + DRAWER_CHEVRON_SIZE / 2;
  const cy = top + DRAWER_CHEVRON_SIZE / 2;
  const follow = useAnimatedStyle(() => {
    const v = drawerProgress.value;
    const s = reduce ? 1 : 1 - (1 - scale) * Math.min(v, 1.2);
    return {
      transform: [
        { translateX: (cx - width / 2) * (s - 1) + v * travel },
        { translateY: (cy - height / 2) * (s - 1) },
      ],
    };
  });
  const turn = useAnimatedStyle(() => ({
    transform: [
      {
        rotate: `${interpolate(drawerProgress.value, [0, 1], [0, 180], CLAMP)}deg`,
      },
    ],
  }));
  const press = open ? closeDrawer : openDrawer;
  const label = open ? closeLabel : openLabel;
  return (
    <Animated.View
      style={[styles.chevron, { left, top }, follow]}
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      onAccessibilityTap={press}
      accessibilityActions={[{ name: "activate" }]}
      onAccessibilityAction={press}
    >
      <GlassIconButton
        icon="chevron-right"
        size={DRAWER_CHEVRON_SIZE}
        iconSize={20}
        iconStyle={turn}
        accessibilityLabel={label}
        accessibilityHidden
        onPress={press}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  panel: {
    bottom: 0,
    left: 0,
    position: "absolute",
    top: 0,
  },
  stage: { flex: 1 },
  clip: { flex: 1, overflow: "hidden" },
  chevron: { position: "absolute" },
});
