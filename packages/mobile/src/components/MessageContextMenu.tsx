import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  Animated,
  Dimensions,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
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
/** Every menu row is this tall, so the menu's height is known before layout. */
const MENU_ITEM_HEIGHT = 48;
const MENU_PADDING = 6;
/** Caps label growth under large Dynamic Type so a row keeps its height. */
const MENU_LABEL_MAX_FONT_SCALE = 1.3;
const GAP = 8;
const EDGE = 12;
/** The least height kept for the message when the screen is short. */
const MIN_BUBBLE_VIEWPORT = 80;
/** The held bubble shrinks to this while the press is held (see ChatMessageRow). */
export const MESSAGE_PRESS_SCALE = 0.96;

/**
 * The iOS Messages context menu: the held bubble lifts out of a dimmed
 * screen and the actions sit under it, aligned to the bubble's side. It is a
 * modal so the dim also covers the native top bar and composer. The bubble is
 * re-rendered at its measured window position (the original is hidden while
 * the menu is up), then moved up just enough that bubble and menu both fit on
 * screen.
 *
 * A message taller than the room left keeps its normal size and scrolls in
 * a viewport that fills that room, starting at the part that was on screen.
 * It only slides into place: scaling a screen-sized text view every frame is
 * what made long messages stutter, so the lift's scale is kept for bubbles
 * that fit.
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
  const progress = useRef(new Animated.Value(0)).current;
  const closingRef = useRef(false);

  useEffect(() => {
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
  }, [progress, reducedMotion]);

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
  const menuHeight = MENU_PADDING * 2 + actions.length * MENU_ITEM_HEIGHT;
  const room = Math.max(MIN_BUBBLE_VIEWPORT, bottom - top - menuHeight - GAP);
  const viewportHeight = Math.min(rect.height, room);
  const scrolls = rect.height > viewportHeight;
  // The bubble keeps its place unless the menu would run off the bottom; then
  // the pair moves up together.
  const bubbleTop = Math.max(
    top,
    Math.min(rect.y, bottom - menuHeight - GAP - viewportHeight),
  );
  // A scrolling message opens on the part that was on screen, so the text
  // under the finger stays where it was.
  const initialOffset = scrolls
    ? Math.min(Math.max(0, bubbleTop - rect.y), rect.height - viewportHeight)
    : 0;
  const startShift = rect.y + initialOffset - bubbleTop;
  const menuLeft =
    side === "left"
      ? Math.max(EDGE, Math.min(rect.x, screen.width - MENU_WIDTH - EDGE))
      : Math.max(EDGE, Math.min(rect.x + rect.width, screen.width - EDGE) - MENU_WIDTH);

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [startShift, 0],
  });
  const bubbleStyle = {
    left: rect.x,
    top: bubbleTop,
    width: rect.width,
    height: viewportHeight,
    transformOrigin: side === "left" ? "bottom left" : "bottom right",
    transform: scrolls
      ? [{ translateY }]
      : [
          { translateY },
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
    top: bubbleTop + viewportHeight + GAP,
    width: MENU_WIDTH,
    height: menuHeight,
    opacity: progress,
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
      <Animated.View
        style={[styles.bubble, bubbleStyle]}
        // A bubble that fits is drawn once and its bitmap scaled through the
        // lift, rather than re-masking its rounded corners on every frame.
        shouldRasterizeIOS={!scrolls}
        renderToHardwareTextureAndroid={!scrolls}
      >
        <ScrollView
          style={styles.bubbleViewport}
          contentOffset={{ x: 0, y: initialOffset }}
          scrollEnabled={scrolls}
          showsVerticalScrollIndicator={scrolls}
          bounces={scrolls}
          overScrollMode={scrolls ? "auto" : "never"}
        >
          <Pressable onPress={() => close()} accessible={false}>
            <View pointerEvents="none">{bubble}</View>
          </Pressable>
        </ScrollView>
      </Animated.View>
      <Animated.View style={[styles.menu, menuStyle]}>
        {actions.map((action) => (
          <Pressable
            key={action.id}
            accessibilityRole="button"
            accessibilityLabel={action.label}
            onPress={() => close(action.onSelect)}
            style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
          >
            <Icon name={action.icon} size={21} color={colors.text} style={styles.itemIcon} />
            <Text
              style={styles.itemLabel}
              numberOfLines={1}
              maxFontSizeMultiplier={MENU_LABEL_MAX_FONT_SCALE}
            >
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
    },
    bubbleViewport: {
      flex: 1,
    },
    menu: {
      position: "absolute",
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderWidth: StyleSheet.hairlineWidth,
      borderRadius: 22,
      borderCurve: "continuous",
      overflow: "hidden",
      paddingVertical: MENU_PADDING - StyleSheet.hairlineWidth,
    },
    item: {
      alignItems: "center",
      flexDirection: "row",
      gap: 14,
      height: MENU_ITEM_HEIGHT,
      paddingHorizontal: 20,
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
