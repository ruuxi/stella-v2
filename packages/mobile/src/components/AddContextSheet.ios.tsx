import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BottomSheet, Group, Host, RNHostView } from "@expo/ui/swift-ui";
import {
  presentationDetents,
  presentationDragIndicator,
} from "@expo/ui/swift-ui/modifiers";
import { AddContextSheetBody, ADD_CONTEXT_BODY_HEIGHT } from "./AddContextSheetBody";
import type { AddContextSheetProps } from "./AddContextSheet.types";
import { useTheme } from "../theme/theme-context";

/**
 * The composer's plus button opens iOS's own sheet, so it gets the system
 * glass, the grabber, and swipe-to-dismiss for free.
 */
export function AddContextSheet(props: AddContextSheetProps) {
  const { isDark } = useTheme();
  const insets = useSafeAreaInsets();
  const height = ADD_CONTEXT_BODY_HEIGHT + Math.max(insets.bottom, 16);
  return (
    <Host
      colorScheme={isDark ? "dark" : "light"}
      style={{ position: "absolute", width: 1, height: 1 }}
    >
      <BottomSheet
        isPresented={props.visible}
        onIsPresentedChange={(presented) => {
          if (!presented) props.onClose();
        }}
        onDismiss={props.onDismissed}
      >
        <Group
          modifiers={[
            presentationDetents([{ height }]),
            presentationDragIndicator("visible"),
          ]}
        >
          <RNHostView>
            <View style={{ flex: 1 }}>
              <AddContextSheetBody {...props} />
            </View>
          </RNHostView>
        </Group>
      </BottomSheet>
    </Host>
  );
}
