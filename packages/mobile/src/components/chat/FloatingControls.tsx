import { useEffect, useMemo, useRef } from "react";
import {
  ActivityIndicator,
  Animated,
  Pressable,
  StyleSheet,
  Text,
} from "react-native";
import { GlassSurface, liquidGlassSupported } from "../glass";
import { Icon } from "../Icon";
import { type Colors } from "../../theme/colors";
import { fadeHex } from "../../theme/oklch";
import { fonts } from "../../theme/fonts";

/**
 * Transient "Catching up" pill — top-center overlay while a catch-up sync
 * (landing / foreground return / Force Sync) is pulling turns the phone may
 * have missed. Non-interactive and absolutely positioned so it never shifts
 * the transcript; appearance/disappearance mirror the floating glass controls'
 * materialize/dissolve language.
 */
export function CatchUpPill({
  visible,
  top,
  colors,
}: {
  visible: boolean;
  top: number;
  colors: Colors;
}) {
  const styles = useMemo(() => makeCatchUpPillStyles(colors), [colors]);
  // Stays mounted so the glass can run its native materialize/dissolve
  // transition; the JS anim fades the content along with it.
  const anim = useRef(new Animated.Value(visible ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [anim, visible]);

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden={!visible}
      style={[
        styles.catchUpPill,
        {
          top,
          // Opacity on a Liquid Glass ancestor makes iOS drop the glass
          // material, so only fade the wrapper on the (non-glass) fallback.
          opacity: liquidGlassSupported ? 1 : anim,
          transform: [
            {
              translateY: anim.interpolate({
                inputRange: [0, 1],
                outputRange: [-8, 0],
              }),
            },
          ],
        },
      ]}
    >
      <GlassSurface
        glass="regular"
        legible
        present={visible}
        radius={15}
        fallbackColor={colors.surface}
        style={styles.catchUpPillGlass}
      >
        {/* Border + content are children of the glass, so fading them is safe. */}
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            styles.catchUpPillRing,
            { opacity: anim },
          ]}
        />
        <Animated.View style={[styles.catchUpPillRow, { opacity: anim }]}>
          <ActivityIndicator size="small" color={colors.textMuted} />
          <Text
            style={styles.catchUpPillText}
            accessibilityLabel="Catching up with your computer"
          >
            Catching up
          </Text>
        </Animated.View>
      </GlassSurface>
    </Animated.View>
  );
}

export function ScrollToBottomFab({
  visible,
  hasUnread,
  onPress,
  colors,
  bottomOffset,
}: {
  visible: boolean;
  hasUnread: boolean;
  onPress: () => void;
  colors: Colors;
  /** Distance in pt from the bottom of the viewport — sit just above the composer. */
  bottomOffset?: number;
}) {
  const styles = useMemo(() => makeScrollToBottomFabStyles(colors), [colors]);
  // Stays mounted across visibility changes so the glass can run its native
  // materialize/dissolve transition; the JS anim fades the icon along with it.
  const anim = useRef(new Animated.Value(visible ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: visible ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [anim, visible]);

  return (
    <Animated.View
      pointerEvents={visible ? "box-none" : "none"}
      style={[
        styles.scrollToBottomFab,
        bottomOffset !== undefined && { bottom: bottomOffset },
        {
          // Opacity on a Liquid Glass ancestor makes iOS drop the glass
          // material, so only fade the wrapper on the (non-glass) fallback. On
          // glass the material fades via `present` and the icon fades below.
          opacity: liquidGlassSupported ? 1 : anim,
          transform: [
            {
              translateY: anim.interpolate({
                inputRange: [0, 1],
                outputRange: [8, 0],
              }),
            },
          ],
        },
      ]}
    >
      <Pressable
        accessibilityLabel={
          hasUnread
            ? "Scroll to latest messages, new replies below"
            : "Scroll to latest messages"
        }
        accessibilityRole="button"
        hitSlop={6}
        onPress={onPress}
        style={({ pressed }) => [
          styles.scrollToBottomFabInner,
          pressed && styles.scrollToBottomFabPressed,
        ]}
      >
        <GlassSurface
          glass="clear"
          interactive
          present={visible}
          radius={16}
          fallbackColor={colors.surface}
          style={styles.scrollToBottomFabGlass}
        >
          {/* Border + icon are children of the glass, so fading them is safe —
              keeps the outline from lingering after the material dissolves. */}
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              styles.scrollToBottomFabRing,
              { opacity: anim },
            ]}
          />
          <Animated.View style={{ opacity: anim }}>
            <Icon
              name="chevron-down"
              size={16}
              color={colors.accent}
              weight="semibold"
            />
          </Animated.View>
        </GlassSurface>
        {hasUnread ? (
          <Animated.View
            style={[styles.scrollToBottomDot, { opacity: anim }]}
          />
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

const makeCatchUpPillStyles = (colors: Colors) =>
  StyleSheet.create({
    // "Catching up" pill — top-center, overlaid (no layout participation).
    catchUpPill: {
      alignSelf: "center",
      elevation: 2,
      position: "absolute",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.06,
      shadowRadius: 5,
    },
    catchUpPillGlass: {
      alignItems: "center",
      borderRadius: 15,
      height: 30,
      justifyContent: "center",
      overflow: "hidden",
      paddingHorizontal: 12,
    },
    // See scrollToBottomFabRing: fading overlay so the hairline dissolves with
    // the material instead of lingering as an outline.
    catchUpPillRing: {
      borderColor: fadeHex(colors.border, 0.6),
      borderRadius: 15,
      borderWidth: StyleSheet.hairlineWidth,
    },
    catchUpPillRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 7,
    },
    catchUpPillText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 12.5,
    },
  } as const);

const makeScrollToBottomFabStyles = (colors: Colors) =>
  StyleSheet.create({
    scrollToBottomFab: {
      bottom: 8,
      height: 32,
      position: "absolute",
      left: "50%",
      marginLeft: -16,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.06,
      shadowRadius: 5,
      elevation: 2,
      width: 32,
    },
    scrollToBottomFabInner: { flex: 1 },
    scrollToBottomFabGlass: {
      alignItems: "center",
      borderRadius: 16,
      flex: 1,
      justifyContent: "center",
      overflow: "hidden",
      width: 32,
    },
    // Hairline definition rendered as a fading overlay (not on the glass view
    // itself) so it dissolves with the material instead of lingering as a
    // visible outline once the button is hidden on Liquid Glass.
    scrollToBottomFabRing: {
      borderColor: fadeHex(colors.border, 0.6),
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
    },
    scrollToBottomFabPressed: { opacity: 0.88 },
    scrollToBottomDot: {
      backgroundColor: colors.accent,
      borderColor: colors.surface,
      borderRadius: 4,
      borderWidth: 1.5,
      height: 8,
      position: "absolute",
      right: 4,
      top: 4,
      width: 8,
    },
  } as const);
