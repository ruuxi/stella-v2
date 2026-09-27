import { useEffect, useRef } from "react";
import { Modal, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AddContextSheetBody } from "./AddContextSheetBody";
import type { AddContextSheetProps } from "./AddContextSheet.types";
import { useColors } from "../theme/theme-context";

/** Matches the Modal's slide-out, so a picker opens after the sheet is gone. */
const DISMISS_MS = 320;

/** Android and web: a sliding sheet with the same content as the iOS one. */
export function AddContextSheet(props: AddContextSheetProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { visible, onDismissed } = props;
  const wasVisible = useRef(visible);
  useEffect(() => {
    if (wasVisible.current && !visible) {
      const timer = setTimeout(onDismissed, DISMISS_MS);
      wasVisible.current = visible;
      return () => clearTimeout(timer);
    }
    wasVisible.current = visible;
    return undefined;
  }, [visible, onDismissed]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={props.onClose}
      statusBarTranslucent
    >
      <Pressable style={styles.scrim} onPress={props.onClose} />
      <View
        style={[
          styles.sheet,
          {
            backgroundColor: colors.background,
            paddingBottom: Math.max(insets.bottom, 16),
          },
        ]}
      >
        <View style={[styles.grabber, { backgroundColor: colors.border }]} />
        <AddContextSheetBody {...props} />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1 },
  sheet: { borderTopLeftRadius: 32, borderTopRightRadius: 32 },
  grabber: {
    alignSelf: "center",
    borderRadius: 3,
    height: 5,
    marginTop: 8,
    width: 36,
  },
});
