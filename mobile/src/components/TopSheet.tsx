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
import { useColors } from "../theme/theme-context";
import { type Colors } from "../theme/colors";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Extra hide distance so the drop shadow clears the top edge too. */
const SHADOW_CLEARANCE = 40;

type TopSheetProps = {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /**
   * Fraction of the screen height the sheet occupies — or caps at, when
   * `contentSized`. Defaults to 80%.
   */
  heightFraction?: number;
  /**
   * Hug the content's natural height (up to `heightFraction`) instead of
   * always filling the fixed fraction. Used by sheets whose content is often
   * sparse (e.g. the activity hub with one or two tasks).
   */
  contentSized?: boolean;
};

/**
 * A page-sheet that anchors to the top of the screen and slides down into view.
 * Covers ~80% of the height (or hugs content when `contentSized`), leaving the
 * rest as a tappable scrim, with rounded bottom corners and a soft hairline on
 * the leading (bottom) edge so the sheet reads against the page beneath it.
 * Used for the artifact viewer, the activity hub, and the device sheet.
 */
export function TopSheet({
  visible,
  onClose,
  children,
  heightFraction = 0.8,
  contentSized = false,
}: TopSheetProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { height } = useWindowDimensions();
  const maxSheetHeight = Math.round(height * heightFraction);

  const progress = useRef(new Animated.Value(0)).current;
  const [rendered, setRendered] = useState(visible);
  // Actual laid-out height when content-sized; drives the slide distance so a
  // short sheet doesn't overshoot from way offscreen. Falls back to the max
  // before the first layout (always ≥ the real height, so never under-hides).
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);

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

  const hideDistance =
    (contentSized ? (measuredHeight ?? maxSheetHeight) : maxSheetHeight) +
    SHADOW_CLEARANCE;
  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [-hideDistance, 0],
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
            contentSized
              ? { maxHeight: maxSheetHeight }
              : { height: maxSheetHeight },
            { transform: [{ translateY }] },
          ]}
          pointerEvents="box-none"
          onLayout={
            contentSized
              ? (e) => setMeasuredHeight(e.nativeEvent.layout.height)
              : undefined
          }
        >
          <View
            style={[
              styles.sheet,
              contentSized ? { maxHeight: maxSheetHeight } : styles.sheetFill,
            ]}
          >
            {children}
          </View>
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
      left: 0,
      position: "absolute",
      right: 0,
      top: 0,
      shadowColor: "#000000",
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: 0.18,
      shadowRadius: 24,
    },
    sheet: {
      backgroundColor: colors.background,
      borderBottomLeftRadius: 26,
      borderBottomRightRadius: 26,
      // Soft hairline on the leading edge (and down the sides, where the sheet
      // meets the page) so the sheet's boundary reads instead of dissolving
      // into a same-color background. Top edge is offscreen, so no border.
      borderColor: colors.border,
      borderTopWidth: 0,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: "hidden",
    },
    sheetFill: {
      flex: 1,
    },
  });
