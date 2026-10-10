import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { GlassSurface } from "../glass";
import { Icon, type IconName } from "../Icon";
import { type Colors } from "../../theme/colors";
import { fadeHex } from "../../theme/oklch";
import { fonts } from "../../theme/fonts";

// ---------------------------------------------------------------------------
// "+" menu — single source of truth for composer attach actions across both
// the chat and the computer chat. The chat has both Attach + View computer;
// the computer chat skips Attach since it doesn't accept image input.
//
// The menu renders as a small popover anchored just above the `+` button
// (drop-up, since the composer is at the bottom of the screen) rather than
// a center-screen action sheet. This mirrors the desktop's `+` menu
// behavior and feels more native for an inline composer affordance.
// ---------------------------------------------------------------------------

export type PlusMenuOption = {
  id: string;
  label: string;
  icon: IconName;
  onSelect: () => void;
  disabled?: boolean;
  selected?: boolean;
  trailingLabel?: string;
  /** When set, tapping opens this list instead of calling `onSelect`. */
  submenu?: PlusMenuOption[];
  /** Header shown above a submenu (defaults to the parent row label). */
  submenuTitle?: string;
};

type PlusMenuLevel = {
  title: string;
  options: PlusMenuOption[];
};

export type AnchorRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const PLUS_MENU_GAP = 10;
const PLUS_MENU_MIN_WIDTH = 200;
// Roomier minimum for the focused message context menu (the `large` variant).
const PLUS_MENU_LARGE_MIN_WIDTH = 268;
const PLUS_MENU_EDGE_PADDING = 12;

export function PlusMenuPopover({
  visible,
  anchor,
  options,
  onDismiss,
  colors,
  containerRef,
  headerLabel = null,
  scrim = false,
  large = false,
  wrapLabels = false,
  minWidth,
}: {
  visible: boolean;
  anchor: AnchorRect | null;
  options: PlusMenuOption[];
  onDismiss: () => void;
  colors: Colors;
  /**
   * The chat root the menu overlays. Anchors are captured in window space; we
   * render *in-tree* (not in a `Modal`) so Liquid Glass can actually sample the
   * chat behind the menu — a `Modal` is a separate window with nothing to
   * refract, which leaves the glass clear and its materialize animation inert.
   * We translate window anchors into this container's local space.
   */
  containerRef: React.RefObject<View | null>;
  /**
   * Non-interactive header shown above the options (the message menu passes the
   * message timestamp, e.g. "Aug 7, 12:56 PM"). Omitted when null.
   */
  headerLabel?: string | null;
  /**
   * Focused context-menu treatment (message menu): a LIGHT non-glass scrim
   * behind the card plus a frostier tint on the card's Liquid Glass, so the
   * menu itself is the authentic frosted-glass surface. The backdrop stays a
   * plain scrim (never a `GlassView`): a second glass layer beneath the in-tree
   * menu triggers Apple's glass-on-glass suppression and renders the menu clear,
   * so the frost must come from the single glass card, not the backdrop.
   */
  scrim?: boolean;
  /**
   * Roomier rows/typography/width for the focused message context menu, to match
   * the reference (a small dense popover like the +/model menus reads too
   * cramped as a primary context menu).
   */
  large?: boolean;
  /** Allow long model names to remain readable. */
  wrapLabels?: boolean;
  minWidth?: number;
}) {
  const styles = useMemo(() => makePlusMenuStyles(colors), [colors]);
  const [menuLayout, setMenuLayout] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [origin, setOrigin] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const [submenuStack, setSubmenuStack] = useState<PlusMenuLevel[]>([]);
  // Snappy entrance: the menu springs up from the anchor once it has been
  // measured, instead of the slow flat fade of the RN Modal.
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!visible) {
      setMenuLayout(null);
      setSubmenuStack([]);
      anim.setValue(0);
      return;
    }
    // Snapshot the container's window offset so window-space anchors land in
    // the right spot once we re-base them into local coordinates.
    containerRef.current?.measureInWindow((x, y) => setOrigin({ x, y }));
  }, [visible, anim, containerRef]);

  useEffect(() => {
    if (visible && menuLayout) {
      Animated.spring(anim, {
        toValue: 1,
        damping: 24,
        stiffness: 520,
        mass: 0.5,
        useNativeDriver: true,
      }).start();
    }
  }, [visible, menuLayout, anim]);

  const activeLevel = submenuStack[submenuStack.length - 1];
  const visibleOptions = activeLevel?.options ?? options;
  const submenuTitle = activeLevel?.title ?? null;

  const handleRequestClose = useCallback(() => {
    if (submenuStack.length > 0) {
      setSubmenuStack((prev) => prev.slice(0, -1));
      setMenuLayout(null);
      return;
    }
    onDismiss();
  }, [onDismiss, submenuStack.length]);

  const goBack = useCallback(() => {
    setSubmenuStack((prev) => prev.slice(0, -1));
    setMenuLayout(null);
  }, []);

  const onSelectOption = useCallback(
    (option: PlusMenuOption) => {
      const submenu = option.submenu;
      if (submenu && submenu.length > 0) {
        setSubmenuStack((prev) => [
          ...prev,
          {
            title: option.submenuTitle ?? option.label,
            options: submenu,
          },
        ]);
        setMenuLayout(null);
        return;
      }
      setSubmenuStack([]);
      onDismiss();
      option.onSelect();
    },
    [onDismiss],
  );

  if (!visible || !anchor) {
    return null;
  }

  const screen = Dimensions.get("window");
  const measured = menuLayout;
  const menuMinWidth =
    minWidth ?? (large ? PLUS_MENU_LARGE_MIN_WIDTH : PLUS_MENU_MIN_WIDTH);
  // Cap the options list so a tall menu scrolls instead of overflowing the
  // screen; short menus (the common case) still size to their content.
  const menuMaxOptionsHeight = Math.round(screen.height * 0.55);
  const desiredWidth = Math.max(menuMinWidth, measured?.width ?? 0);
  // Left-align with the anchor, clamped inside the screen so the bubble
  // never spills past the edge of the device. Computed in window space, then
  // re-based into the container's local space (we render in-tree, not modal).
  const windowLeft = Math.min(
    Math.max(PLUS_MENU_EDGE_PADDING, anchor.x),
    screen.width - desiredWidth - PLUS_MENU_EDGE_PADDING,
  );
  const left = windowLeft - origin.x;
  // Drop-up by default; fall back to drop-down if the menu wouldn't fit
  // above the anchor.
  const menuHeight = measured?.height ?? 0;
  const dropUpTop = anchor.y - menuHeight - PLUS_MENU_GAP;
  const isDropDown = Boolean(measured) && dropUpTop < PLUS_MENU_EDGE_PADDING;
  const windowTop = isDropDown
    ? anchor.y + anchor.height + PLUS_MENU_GAP
    : dropUpTop;
  const top = windowTop - origin.y;
  // Emerge from the anchor: a drop-up menu rises into place, a drop-down
  // menu settles down into place.
  const enterTranslateY = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [isDropDown ? -8 : 8, 0],
  });
  const enterScale = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.96, 1],
  });

  return (
    <View style={styles.overlay} pointerEvents="box-none">
      {scrim ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.scrim, { opacity: anim }]}
        />
      ) : null}
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={handleRequestClose}
        accessibilityLabel="Dismiss menu"
      />
      <Animated.View
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setMenuLayout({ width, height });
        }}
        style={[
          styles.menu,
          {
            left,
            minWidth: menuMinWidth,
            top: measured ? top : anchor.y - PLUS_MENU_GAP - origin.y,
            transform: [{ translateY: enterTranslateY }, { scale: enterScale }],
          },
        ]}
      >
        <GlassSurface
          glass="regular"
          // The menu card is the ONE Liquid Glass surface (expo-glass-effect
          // GlassView / UIGlassEffect on iOS 26). The focused message menu
          // (`scrim` variant) leans into a frostier, more refractive tint so it
          // reads as genuine Liquid Glass — its backdrop scrim keeps labels
          // legible, so it needn't carry `legible`'s heavier opaque surface tint
          // the way the inline +/model menus (over undimmed live chat) do.
          {...(scrim
            ? { tintColor: fadeHex(colors.surface, 0.66) }
            : { legible: true })}
          present={Boolean(measured)}
          radius={large ? 18 : 14}
          ringed
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
        />
        {/* Fade the menu *contents* — never the glass or its parent. Animating
              opacity on a GlassView ancestor makes iOS drop the Liquid Glass
              material entirely (renders clear). The glass itself fades via its
              own `present`-driven materialize animation; the spring lives on the
              transform above. */}
        <Animated.View style={{ opacity: measured ? anim : 0 }}>
          {headerLabel && !submenuTitle ? (
            <View
              style={[
                styles.menuItem,
                large && styles.menuItemLarge,
                styles.menuHeader,
              ]}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              <Text
                style={[
                  styles.menuHeaderLabel,
                  large && styles.menuHeaderLabelLarge,
                ]}
                numberOfLines={1}
              >
                {headerLabel}
              </Text>
            </View>
          ) : null}
          {submenuTitle ? (
            <Pressable
              accessibilityLabel="Back to menu"
              onPress={goBack}
              style={({ pressed }) => [
                styles.menuItem,
                styles.menuItemFirst,
                styles.submenuHeader,
                pressed && styles.menuItemPressed,
              ]}
            >
              <Icon
                name="chevron-left"
                size={16}
                color={colors.textMuted}
                style={styles.menuItemIcon}
              />
              <Text style={styles.submenuHeaderLabel} numberOfLines={1}>
                {submenuTitle}
              </Text>
            </Pressable>
          ) : null}
          <ScrollView
            style={{ maxHeight: menuMaxOptionsHeight }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            bounces={false}
          >
            {visibleOptions.map((option, index) => {
              const isFirst = !submenuTitle && index === 0;
              const isLast = index === visibleOptions.length - 1;
              const hasSubmenu = Boolean(option.submenu?.length);
              return (
                <Pressable
                  key={option.id}
                  accessibilityLabel={option.label}
                  disabled={option.disabled}
                  onPress={() => onSelectOption(option)}
                  style={({ pressed }) => [
                    styles.menuItem,
                    large && styles.menuItemLarge,
                    isFirst && styles.menuItemFirst,
                    isLast && styles.menuItemLast,
                    pressed && styles.menuItemPressed,
                    option.disabled && styles.menuItemDisabled,
                  ]}
                >
                  <Icon
                    name={option.icon}
                    size={large ? 20 : 16}
                    color={option.disabled ? colors.textMuted : colors.text}
                    style={
                      large ? styles.menuItemIconLarge : styles.menuItemIcon
                    }
                  />
                  <Text
                    style={[
                      styles.menuItemLabel,
                      large && styles.menuItemLabelLarge,
                      option.disabled && styles.menuItemLabelMuted,
                    ]}
                    numberOfLines={wrapLabels ? 2 : 1}
                  >
                    {option.label}
                  </Text>
                  {option.trailingLabel ? (
                    <Text style={styles.menuItemTrailing} numberOfLines={1}>
                      {option.trailingLabel}
                    </Text>
                  ) : hasSubmenu ? (
                    <Icon
                      name="chevron-right"
                      size={15}
                      color={colors.textMuted}
                      style={styles.menuItemCheck}
                    />
                  ) : option.selected ? (
                    <Icon
                      name="check"
                      size={15}
                      color={colors.accent}
                      style={styles.menuItemCheck}
                    />
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const makePlusMenuStyles = (colors: Colors) =>
  StyleSheet.create({
    overlay: {
      // In-tree overlay covering the chat root (no Modal), so Liquid Glass can
      // sample the content behind the menu. `box-none` lets taps fall through
      // to the backdrop / menu children only.
      ...StyleSheet.absoluteFill,
      zIndex: 50,
    },
    scrim: {
      // Non-glass backdrop behind the focused message menu: a LIGHT plain dark
      // scrim (the app's sheet/modal convention — see TopSheet), kept subtle so
      // the menu's Liquid Glass refracts near-live chat and reads as authentic
      // frost instead of a muddied dark panel. It must NOT be a GlassView — a
      // second glass layer beneath the menu triggers Apple's glass-on-glass
      // suppression and renders the menu clear — so the frost comes entirely
      // from the single glass surface (the menu card), never from the backdrop.
      ...StyleSheet.absoluteFill,
      backgroundColor: "rgba(0, 0, 0, 0.2)",
    },
    menuHeader: {
      borderBottomColor: fadeHex(colors.border, 0.55),
      borderBottomWidth: StyleSheet.hairlineWidth,
      justifyContent: "center",
      marginBottom: 4,
      paddingBottom: 10,
      paddingVertical: 8,
    },
    menuHeaderLabel: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 12,
      letterSpacing: -0.1,
      textAlign: "center",
    },
    menuHeaderLabelLarge: { fontSize: 13, paddingVertical: 2 },
    // `large` variant — roomier rows/typography for the focused message menu.
    menuItemLarge: {
      gap: 14,
      paddingHorizontal: 18,
      paddingVertical: 15,
    },
    menuItemIconLarge: { width: 24 },
    menuItemLabelLarge: { fontSize: 17, letterSpacing: -0.3 },
    menu: {
      borderRadius: 14,
      paddingVertical: 6,
      position: "absolute",
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.05,
      shadowRadius: 6,
      elevation: 2,
    },
    menuItem: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 11,
    },
    menuItemFirst: {},
    menuItemLast: {},
    menuItemPressed: { backgroundColor: fadeHex(colors.text, 0.06) },
    menuItemDisabled: { opacity: 0.55 },
    menuItemIcon: { width: 20 },
    menuItemLabel: {
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    menuItemLabelMuted: { color: colors.textMuted },
    menuItemTrailing: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: -0.15,
      marginLeft: 12,
      maxWidth: 136,
    },
    menuItemCheck: { marginLeft: 12 },
    submenuHeader: {
      borderBottomColor: fadeHex(colors.border, 0.55),
      borderBottomWidth: StyleSheet.hairlineWidth,
      marginBottom: 4,
      paddingBottom: 10,
    },
    submenuHeaderLabel: {
      color: colors.textMuted,
      flex: 1,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.15,
    },
  });
