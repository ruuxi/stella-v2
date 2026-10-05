import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Animated,
  Dimensions,
  Modal,
  Pressable,
  StyleSheet,
  Text,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReducedMotion } from "react-native-reanimated";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";
import { Icon, type IconName } from "./Icon";

export type MessageMenuRect = { x: number; y: number; width: number; height: number };

export type MessageMenuAction = {
  id: string;
  label: string;
  icon: IconName;
  onSelect: () => void;
};

const MENU_WIDTH = 250;
const GAP = 8;
const EDGE = 12;
/** The held bubble shrinks to this while the press is held (see ChatMessageRow). */
export const MESSAGE_PRESS_SCALE = 0.96;

/**
 * The iOS Messages context menu: the held bubble lifts out of a dimmed
 * screen and the actions sit under it, aligned to the bubble's side. It is a
 * modal so the dim also covers the native top bar and composer. The
 * bubble is re-rendered at its measured window position (the original is
 * hidden while the menu is up), then moved up just enough that bubble and menu
 * both fit on screen. A bubble too tall to fit is clipped, like iOS.
 */
export function MessageContextMenu({
  rect,
  side,
  bubble,
  actions,
  colors,
  onDismiss,
}: {
  /** The held bubble's frame in window coordinates. */
  rect: MessageMenuRect;
  side: "left" | "right";
  bubble: ReactNode;
  actions: readonly MessageMenuAction[];
  colors: Colors;
  onDismiss: () => void;
}) {
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const [menuHeight, setMenuHeight] = useState<number | null>(null);
  const progress = useRef(new Animated.Value(0)).current;
  const closingRef = useRef(false);

  const ready = menuHeight !== null;
  useEffect(() => {
    if (!ready) return;
    if (reducedMotion) {
      progress.setValue(1);
      return;
    }
    Animated.spring(progress, {
      toValue: 1,
      stiffness: 380,
      damping: 28,
      mass: 0.8,
      useNativeDriver: true,
    }).start();
  }, [ready, progress, reducedMotion]);

  const close = useCallback(
    (after?: () => void) => {
      if (closingRef.current) return;
      closingRef.current = true;
      after?.();
      Animated.timing(progress, {
        toValue: 0,
        duration: reducedMotion ? 0 : 160,
        useNativeDriver: true,
      }).start(() => onDismiss());
    },
    [onDismiss, progress, reducedMotion],
  );

  const screen = Dimensions.get("window");
  const top = insets.top + EDGE;
  const bottom = screen.height - Math.max(insets.bottom, EDGE) - EDGE;
  const menuH = menuHeight ?? 0;
  // The bubble keeps its place unless the menu would run off the bottom; then
  // the pair moves up together, clipping a bubble taller than the room left.
  const maxBubbleHeight = Math.max(80, bottom - top - menuH - GAP);
  const bubbleHeight = Math.min(rect.height, maxBubbleHeight);
  const bubbleTop = Math.max(
    top,
    Math.min(rect.y, bottom - menuH - GAP - bubbleHeight),
  );
  const shift = bubbleTop - rect.y;
  const menuLeft =
    side === "left"
      ? Math.max(EDGE, Math.min(rect.x, screen.width - MENU_WIDTH - EDGE))
      : Math.max(EDGE, Math.min(rect.x + rect.width, screen.width - EDGE) - MENU_WIDTH);

  const bubbleStyle = {
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: bubbleHeight,
    transformOrigin: side === "left" ? "bottom left" : "bottom right",
    transform: [
      {
        translateY: progress.interpolate({
          inputRange: [0, 1],
          outputRange: [0, shift],
        }),
      },
      {
        scale: progress.interpolate({
          inputRange: [0, 1],
          outputRange: [MESSAGE_PRESS_SCALE, 1],
        }),
      },
    ],
  };
  const menuStyle = {
    left: menuLeft,
    top: bubbleTop + bubbleHeight + GAP,
    width: MENU_WIDTH,
    opacity: ready ? progress : 0,
    transformOrigin: side === "left" ? "top left" : "top right",
    transform: [
      {
        scale: progress.interpolate({
          inputRange: [0, 1],
          outputRange: [0.5, 1],
        }),
      },
    ],
  };

  return (
    <Modal
      transparent
      visible
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={() => close()}
    >
      <Animated.View pointerEvents="none" style={[styles.scrim, { opacity: progress }]} />
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={() => close()}
        accessibilityRole="button"
        accessibilityLabel="Dismiss menu"
      />
      <Animated.View pointerEvents="none" style={[styles.bubble, bubbleStyle]}>
        {bubble}
      </Animated.View>
      <Animated.View
        style={[styles.menu, menuStyle]}
        onLayout={(event) => setMenuHeight(event.nativeEvent.layout.height)}
      >
        {actions.map((action) => (
          <Pressable
            key={action.id}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            onPress={() => close(action.onSelect)}
            style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
          >
            <Icon name={action.icon} size={21} color={colors.text} style={styles.itemIcon} />
            <Text style={styles.itemLabel} numberOfLines={1}>
              {action.label}
            </Text>
          </Pressable>
        ))}
      </Animated.View>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    scrim: {
      ...StyleSheet.absoluteFill,
      backgroundColor: "rgba(0, 0, 0, 0.45)",
    },
    bubble: {
      position: "absolute",
      overflow: "hidden",
      borderRadius: 22,
      borderCurve: "continuous",
    },
    menu: {
      position: "absolute",
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 22,
      borderCurve: "continuous",
      overflow: "hidden",
      paddingVertical: 6,
    },
    item: {
      alignItems: "center",
      flexDirection: "row",
      gap: 14,
      paddingHorizontal: 20,
      paddingVertical: 13,
    },
    itemPressed: { backgroundColor: fadeHex(colors.text, 0.08) },
    itemIcon: { width: 24 },
    itemLabel: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 17,
      letterSpacing: -0.3,
    },
  });
