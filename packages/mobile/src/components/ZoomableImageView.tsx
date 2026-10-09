import { useState, type ReactNode } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Image } from "expo-image";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

export type SwipeDirection = "previous" | "next";

const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
/** Fraction of the width a drag must cover to step to the next image. */
const SWIPE_DISTANCE_FRACTION = 0.22;
const SWIPE_VELOCITY = 700;
/** How far an edge drag follows the finger when there is nothing beyond it. */
const EDGE_RESISTANCE = 0.3;
const SETTLE = { damping: 26, stiffness: 260, mass: 0.9 };

/**
 * A full-bleed image that pinch-zooms around the fingers, pans while zoomed,
 * and double-taps between fit and 2.5x. At fit size a horizontal drag follows
 * the finger and, past a threshold, hands off to `onSwipe` so the viewer can
 * step to the neighbouring image.
 *
 * Every transform lives in Reanimated shared values written on the UI thread,
 * so zooming stays at display rate while the JS thread streams a reply.
 */
export function ZoomableImageView({
  uri,
  accessibilityLabel,
  hasPrevious = false,
  hasNext = false,
  onSwipe,
}: {
  uri: string;
  accessibilityLabel: string;
  hasPrevious?: boolean;
  hasNext?: boolean;
  onSwipe?: (direction: SwipeDirection) => void;
}) {
  const width = useSharedValue(0);
  const height = useSharedValue(0);
  // Natural width / height, for the size of the fitted ("contain") image.
  const aspect = useSharedValue(1);

  const scale = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const swipeX = useSharedValue(0);

  const startScale = useSharedValue(1);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const focalX = useSharedValue(0);
  const focalY = useSharedValue(0);

  const onLayout = (event: LayoutChangeEvent) => {
    width.value = event.nativeEvent.layout.width;
    height.value = event.nativeEvent.layout.height;
  };

  /** Largest translation that keeps the zoomed image covering the frame. */
  const bounds = (s: number) => {
    "worklet";
    const w = width.value;
    const h = height.value;
    const fittedW = Math.min(w, h * aspect.value);
    const fittedH = Math.min(h, w / aspect.value);
    return {
      maxX: Math.max(0, (fittedW * s - w) / 2),
      maxY: Math.max(0, (fittedH * s - h) / 2),
    };
  };

  const clampTo = (value: number, max: number) => {
    "worklet";
    return Math.min(max, Math.max(-max, value));
  };

  const settle = () => {
    "worklet";
    if (scale.value <= 1) {
      scale.value = withSpring(1, SETTLE);
      x.value = withSpring(0, SETTLE);
      y.value = withSpring(0, SETTLE);
      return;
    }
    const target = Math.min(MAX_SCALE, scale.value);
    const { maxX, maxY } = bounds(target);
    scale.value = withSpring(target, SETTLE);
    x.value = withSpring(clampTo(x.value, maxX), SETTLE);
    y.value = withSpring(clampTo(y.value, maxY), SETTLE);
  };

  const pinch = Gesture.Pinch()
    .onStart((event) => {
      startScale.value = scale.value;
      startX.value = x.value;
      startY.value = y.value;
      focalX.value = event.focalX - width.value / 2;
      focalY.value = event.focalY - height.value / 2;
    })
    .onUpdate((event) => {
      const next = Math.min(
        MAX_SCALE * 1.2,
        Math.max(0.6, startScale.value * event.scale),
      );
      const ratio = next / startScale.value;
      // Keep the point that started under the fingers under them, and let a
      // drifting focal point carry the image along.
      const fx = event.focalX - width.value / 2;
      const fy = event.focalY - height.value / 2;
      scale.value = next;
      x.value = fx - (focalX.value - startX.value) * ratio;
      y.value = fy - (focalY.value - startY.value) * ratio;
    })
    .onEnd(() => {
      settle();
    });

  const pan = Gesture.Pan()
    .averageTouches(true)
    .activeOffsetX([-10, 10])
    .activeOffsetY([-10, 10])
    .onStart(() => {
      startX.value = x.value;
      startY.value = y.value;
    })
    .onUpdate((event) => {
      if (event.numberOfPointers > 1) return;
      if (scale.value > 1) {
        x.value = startX.value + event.translationX;
        y.value = startY.value + event.translationY;
        return;
      }
      const dx = event.translationX;
      const blocked = (dx > 0 && !hasPrevious) || (dx < 0 && !hasNext);
      swipeX.value = blocked || !onSwipe ? dx * EDGE_RESISTANCE : dx;
    })
    .onEnd((event) => {
      if (scale.value > 1) {
        const { maxX, maxY } = bounds(scale.value);
        x.value = withSpring(clampTo(x.value, maxX), SETTLE);
        y.value = withSpring(clampTo(y.value, maxY), SETTLE);
        return;
      }
      const dx = event.translationX;
      const far =
        Math.abs(dx) > width.value * SWIPE_DISTANCE_FRACTION ||
        Math.abs(event.velocityX) > SWIPE_VELOCITY;
      const direction: SwipeDirection = dx < 0 ? "next" : "previous";
      const available = direction === "next" ? hasNext : hasPrevious;
      if (onSwipe && far && available && Math.abs(dx) > 10) {
        // Carry on off the edge; the next image replaces this view.
        swipeX.value = withTiming(Math.sign(dx) * width.value, {
          duration: 160,
        });
        runOnJS(onSwipe)(direction);
        return;
      }
      swipeX.value = withSpring(0, SETTLE);
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd((event, success) => {
      if (!success) return;
      if (scale.value > 1) {
        scale.value = withTiming(1, { duration: 220 });
        x.value = withTiming(0, { duration: 220 });
        y.value = withTiming(0, { duration: 220 });
        return;
      }
      const fx = event.x - width.value / 2;
      const fy = event.y - height.value / 2;
      const { maxX, maxY } = bounds(DOUBLE_TAP_SCALE);
      scale.value = withTiming(DOUBLE_TAP_SCALE, { duration: 220 });
      x.value = withTiming(clampTo(fx * (1 - DOUBLE_TAP_SCALE), maxX), {
        duration: 220,
      });
      y.value = withTiming(clampTo(fy * (1 - DOUBLE_TAP_SCALE), maxY), {
        duration: 220,
      });
    });

  const gesture = Gesture.Race(doubleTap, Gesture.Simultaneous(pinch, pan));

  const imageStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value + swipeX.value },
      { translateY: y.value },
      { scale: scale.value },
    ],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View style={styles.frame} onLayout={onLayout} collapsable={false}>
        <Animated.View style={[styles.fill, imageStyle]}>
          <Image
            source={{ uri }}
            style={styles.fill}
            contentFit="contain"
            accessibilityLabel={accessibilityLabel}
            onLoad={(event) => {
              const { width: w, height: h } = event.source;
              if (w > 0 && h > 0) aspect.value = w / h;
            }}
          />
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

/**
 * A plain horizontal-swipe surface for the image viewer's loading and error
 * states, so a quick run of swipes isn't stopped by an image still loading.
 */
export function SwipeArea({
  onSwipe,
  children,
}: {
  onSwipe?: (direction: SwipeDirection) => void;
  children: ReactNode;
}) {
  const [width, setWidth] = useState(0);
  const pan = Gesture.Pan()
    .enabled(Boolean(onSwipe))
    .activeOffsetX([-15, 15])
    .failOffsetY([-15, 15])
    .onEnd((event) => {
      const far =
        Math.abs(event.translationX) > width * SWIPE_DISTANCE_FRACTION ||
        Math.abs(event.velocityX) > SWIPE_VELOCITY;
      if (!far || !onSwipe) return;
      runOnJS(onSwipe)(event.translationX < 0 ? "next" : "previous");
    });
  return (
    <GestureDetector gesture={pan}>
      <View
        style={styles.frame}
        collapsable={false}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        {children}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
    width: "100%",
  },
  frame: {
    flex: 1,
    overflow: "hidden",
  },
});
