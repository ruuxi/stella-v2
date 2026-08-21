import { useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { type Colors } from "../theme/colors";
import { useColors } from "../theme/theme-context";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Extra hide distance so the drop shadow clears the bottom edge too. */
const SHADOW_CLEARANCE = 40;

type BottomSheetProps = {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /**
   * Fraction of the screen height the sheet occupies. Defaults to filling
   * the screen down to the status bar — a near-full-height panel whose
   * remaining top sliver stays a tappable scrim (the dismissal affordance,
   * mirroring the top sheets' bottom scrim).
   */
  heightFraction?: number;
};

/**
 * A page-sheet anchored to the bottom of the screen that slides up into
 * view — the bottom-anchored twin of `TopSheet`, sharing its animation and
 * surface language (rounded top corners, soft hairline on the leading edge).
 * Used by the activity hub, whose controls live in a bottom tab bar.
 */
export function BottomSheet({
  visible,
  onClose,
  children,
  heightFraction = 0.94,
}: BottomSheetProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { height } = useWindowDimensions();
  const maxSheetHeight = Math.round(height * heightFraction);

  const progress = useRef(new Animated.Value(0)).current;
  const [rendered, setRendered] = useState(visible);

  useEffect(() => {
    if (visible) {
      setRendered(true);
      Animated.timing(progress, {
        toValue: 1,
        duration: 300,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(progress, {
        toValue: 0,
        duration: 220,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setRendered(false);
      });
    }
    // `progress` is a stable ref; only react to visibility changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const hideDistance = maxSheetHeight + SHADOW_CLEARANCE;
  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [hideDistance, 0],
  });
  const backdropOpacity = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, 0.4],
  });

  return (
    <Modal
      visible={rendered}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.fill}>
        <AnimatedPressable
          style={[styles.backdrop, { opacity: backdropOpacity }]}
          onPress={onClose}
          accessibilityLabel="Close"
        />
        <Animated.View
          style={[
            styles.shadow,
            { height: maxSheetHeight },
            { transform: [{ translateY }] },
          ]}
          pointerEvents="box-none"
        >
          <View style={styles.sheet}>{children}</View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    fill: {
      flex: 1,
    },
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: "#000000",
    },
    shadow: {
      bottom: 0,
      left: 0,
      position: "absolute",
      right: 0,
      shadowColor: "#000000",
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: 0.18,
      shadowRadius: 24,
    },
    sheet: {
      backgroundColor: colors.background,
      // Soft hairline on the leading edge (and up the sides, where the sheet
      // meets the page) so the sheet's boundary reads instead of dissolving
      // into a same-color background. Bottom edge is offscreen.
      borderColor: colors.border,
      borderBottomWidth: 0,
      borderTopLeftRadius: 26,
      borderTopRightRadius: 26,
      borderWidth: StyleSheet.hairlineWidth,
      flex: 1,
      overflow: "hidden",
    },
  });
