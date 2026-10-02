import { useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  Animated,
  Easing,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { useReducedMotion } from "react-native-reanimated";
import { useColors } from "../theme/theme-context";

type Pop = { side: "left" | "right"; rise: number; scale: number };

export const SENT_BUBBLE_POP: Pop = { side: "right", rise: 14, scale: 0.84 };
const ARRIVING_BUBBLE_POP: Pop = { side: "left", rise: 10, scale: 0.9 };

/**
 * iMessage-style entry shared by the sent bubble and the arriving reply: the
 * bubble springs up out of its tail corner while the fade finishes early, so
 * it reads as solid by the time it lands. Same spring as the desktop
 * `--bubble-spring` (stiffness 420, damping 30).
 *
 * `animate` is read once, at mount: callers flip it off on the next render
 * (the row is "seen" by then), and that must not cut the pop short.
 */
export function useBubblePop(animate: boolean, pop: Pop) {
  const reducedMotion = useReducedMotion();
  const play = useRef(animate).current && !reducedMotion;
  const progress = useRef(new Animated.Value(play ? 0 : 1)).current;
  const opacity = useRef(new Animated.Value(play ? 0 : 1)).current;

  useEffect(() => {
    if (!play) {
      progress.setValue(1);
      opacity.setValue(1);
      return;
    }
    const animation = Animated.parallel([
      Animated.spring(progress, {
        toValue: 1,
        stiffness: 420,
        damping: 30,
        mass: 1,
        useNativeDriver: true,
      }),
      Animated.timing(opacity, {
        toValue: 1,
        duration: pop.side === "right" ? 120 : 140,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [play, progress, opacity, pop.side]);

  return useMemo(
    () => ({
      opacity,
      transformOrigin: pop.side === "right" ? "bottom right" : "bottom left",
      transform: [
        {
          translateY: progress.interpolate({
            inputRange: [0, 1],
            outputRange: [pop.rise, 0],
          }),
        },
        {
          scale: progress.interpolate({
            inputRange: [0, 1],
            outputRange: [pop.scale, 1],
          }),
        },
      ],
    }),
    [opacity, progress, pop.side, pop.rise, pop.scale],
  );
}

/** The reply bubble, popping in once if it mounts with `animate`. */
export function AssistantBubble({
  children,
  style,
  animate,
}: {
  children: ReactNode;
  style: StyleProp<ViewStyle>;
  animate: boolean;
}) {
  const colors = useColors();
  const pop = useBubblePop(animate, ARRIVING_BUBBLE_POP);
  return (
    <Animated.View style={[style, pop]}>
      <LinearGradient
        pointerEvents="none"
        colors={[colors.assistantBubbleFillTop, colors.assistantBubbleFillBottom]}
        style={StyleSheet.absoluteFill}
      />
      {children}
    </Animated.View>
  );
}
