/**
 * Shared motion for the onboarding conversation: one family of springs so
 * every card, row and button moves with the same physical feel, plus the
 * small primitives built on them (press scale, a 0→1 spring flag).
 *
 * Everything animates transforms and opacity through Reanimated on the UI
 * thread; React only re-renders when a flag flips, never per frame.
 */
import { useEffect, type ReactNode } from "react";
import {
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
  type SharedValue,
  type WithSpringConfig,
} from "react-native-reanimated";

/** Settles quickly with a hint of overshoot: cards, rows, chips. */
export const SPRING_SOFT: WithSpringConfig = {
  damping: 17,
  stiffness: 170,
  mass: 1,
};

/** Tight and quick: presses, toggles, small pops. */
export const SPRING_SNAPPY: WithSpringConfig = {
  damping: 20,
  stiffness: 340,
  mass: 0.7,
};

/** A card or block arriving under a message. */
export const cardEntering = (delay = 0) =>
  FadeInDown.springify()
    .damping(19)
    .stiffness(150)
    .mass(1)
    .withInitialValues({ opacity: 0, transform: [{ translateY: 18 }] })
    .delay(delay)
    .reduceMotion(ReduceMotion.System);

/** Rows inside a card, staggered by index. */
export const rowEntering = (index: number, base = 0) =>
  FadeInDown.springify()
    .damping(18)
    .stiffness(200)
    .withInitialValues({ opacity: 0, transform: [{ translateY: 10 }] })
    .delay(base + index * 55)
    .reduceMotion(ReduceMotion.System);

export const fadeEntering = (delay = 0, duration = 220) =>
  FadeIn.duration(duration).delay(delay).reduceMotion(ReduceMotion.System);

export const fadeExiting = (duration = 160) =>
  FadeOut.duration(duration).reduceMotion(ReduceMotion.System);

/**
 * A bubble-style pop: springs up from `fromScale` (around the view's
 * `transformOrigin`) while the fade finishes early, so it reads as solid by
 * the time it lands.
 */
export const popEntering =
  (fromScale: number, fromY = 0, delay = 0) =>
  () => {
    "worklet";
    const spring = {
      damping: 16,
      stiffness: 260,
      mass: 1,
      reduceMotion: ReduceMotion.System,
    };
    return {
      initialValues: {
        opacity: 0,
        transform: [{ translateY: fromY }, { scale: fromScale }],
      },
      animations: {
        opacity: withDelay(
          delay,
          withTiming(1, { duration: 150, reduceMotion: ReduceMotion.System }),
        ),
        transform: [
          { translateY: withDelay(delay, withSpring(0, spring)) },
          { scale: withDelay(delay, withSpring(1, spring)) },
        ],
      },
    };
  };

/** Siblings sliding to make room for a row that arrived or left. */
export const springLayout = LinearTransition.springify()
  .damping(20)
  .stiffness(190)
  .reduceMotion(ReduceMotion.System);

/**
 * A 0→1 spring that follows a boolean: the shared value every "this just
 * happened" moment in the demos hangs its transforms on.
 */
export function useSpringFlag(
  flag: boolean,
  config: WithSpringConfig = SPRING_SOFT,
): SharedValue<number> {
  const reduced = useReducedMotion();
  const value = useSharedValue(flag ? 1 : 0);
  useEffect(() => {
    const target = flag ? 1 : 0;
    value.value = reduced
      ? withTiming(target, { duration: 0 })
      : withSpring(target, config);
  }, [config, flag, reduced, value]);
  return value;
}

type SpringPressableProps = Omit<PressableProps, "style"> & {
  /** The surface that sinks (look and inner layout). */
  style?: StyleProp<ViewStyle>;
  /** Outer layout (flex, margins) for the touch target itself. */
  containerStyle?: StyleProp<ViewStyle>;
  /** How far the press sinks. */
  pressScale?: number;
  children?: ReactNode;
};

/**
 * A pressable that sinks under the finger and springs back: the tactile
 * answer every tappable surface in onboarding gives.
 */
export function SpringPressable({
  style,
  containerStyle,
  pressScale = 0.965,
  onPressIn,
  onPressOut,
  disabled,
  children,
  ...rest
}: SpringPressableProps) {
  const pressed = useSharedValue(0);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - (1 - pressScale) * pressed.value }],
  }));
  return (
    <Pressable
      {...rest}
      style={containerStyle}
      disabled={disabled}
      onPressIn={(event) => {
        pressed.value = withSpring(1, SPRING_SNAPPY);
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        pressed.value = withSpring(0, SPRING_SOFT);
        onPressOut?.(event);
      }}
    >
      <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>
    </Pressable>
  );
}
