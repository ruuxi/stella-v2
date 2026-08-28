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
import {
  TOP_SHEET_HEIGHT_FRACTION,
  topSheetMaxHeight,
} from "../lib/top-sheet-metrics";
import { useColors } from "../theme/theme-context";
import { type Colors } from "../theme/colors";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const SHADOW_CLEARANCE = 40;

type TopSheetProps = {
  visible: boolean;
  onClose: () => void;
  children: React.ReactNode;

  heightFraction?: number;

  contentSized?: boolean;
};

export function TopSheet({
  visible,
  onClose,
  children,
  heightFraction = TOP_SHEET_HEIGHT_FRACTION,
  contentSized = false,
}: TopSheetProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { height } = useWindowDimensions();
  const maxSheetHeight = topSheetMaxHeight(height, heightFraction);

  const progress = useRef(new Animated.Value(0)).current;
  const [rendered, setRendered] = useState(visible);

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

  }, [visible, progress]);

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

      borderColor: colors.border,
      borderTopWidth: 0,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: "hidden",
    },
    sheetFill: {
      flex: 1,
    },
  });
