import type { RefObject } from "react";
import { Image } from "expo-image";
import {
  Gesture,
  GestureDetector,
  type GestureType,
} from "react-native-gesture-handler";
import { StyleSheet, View, type ScrollView } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import type { Colors } from "../../theme/colors";

/**
 * A before/after pair as one frame, wiped by a finger.
 *
 * The divider is a Reanimated shared value the pan gesture writes on the UI
 * thread, so the wipe stays at display rate while the JS thread is busy with a
 * streaming reply. A per-move round trip through React state would be exactly
 * the jank this is meant to avoid.
 *
 * The wipe and the row it sits in both read horizontal drags, so the frame
 * blocks the row's scroll while a finger is on it, and a tap that never
 * becomes a drag opens the pair full screen.
 */
export function CompareFrame({
  beforeUri,
  afterUri,
  width,
  height,
  colors,
  label,
  rowRef,
  onOpen,
}: {
  beforeUri: string;
  afterUri: string;
  width: number;
  height: number;
  colors: Colors;
  label: string;
  rowRef?: RefObject<ScrollView | null>;
  onOpen?: () => void;
}) {
  const split = useSharedValue(width * 0.55);

  let pan = Gesture.Pan()
    .minDistance(0)
    .onBegin((event) => {
      split.value = Math.max(0, Math.min(width, event.x));
    })
    .onChange((event) => {
      split.value = Math.max(0, Math.min(width, event.x));
    });
  if (rowRef) {
    pan = pan.blocksExternalGesture(
      rowRef as unknown as RefObject<GestureType>,
    );
  }
  const tap = Gesture.Tap().onEnd((_event, success) => {
    if (success && onOpen) onOpen();
  });
  const gesture = Gesture.Exclusive(pan, tap);

  const clipStyle = useAnimatedStyle(() => ({ width: split.value }));
  const handleStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: split.value - 1 }],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <View
        accessibilityRole="adjustable"
        accessibilityLabel={`${label}, drag to compare`}
        style={[styles.frame, { width, height }]}
      >
        <Image
          source={{ uri: afterUri }}
          style={[styles.layer, { width, height }]}
          contentFit="cover"
          cachePolicy="memory-disk"
        />
        <Animated.View style={[styles.clip, { height }, clipStyle]}>
          <Image
            source={{ uri: beforeUri }}
            style={[styles.layer, { width, height }]}
            contentFit="cover"
            cachePolicy="memory-disk"
          />
        </Animated.View>
        <Animated.View
          pointerEvents="none"
          style={[styles.handle, { height, backgroundColor: colors.card }, handleStyle]}
        />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  clip: { left: 0, overflow: "hidden", position: "absolute", top: 0 },
  frame: { overflow: "hidden" },
  handle: { left: 0, opacity: 0.9, position: "absolute", top: 0, width: 2 },
  layer: { left: 0, position: "absolute", top: 0 },
});
