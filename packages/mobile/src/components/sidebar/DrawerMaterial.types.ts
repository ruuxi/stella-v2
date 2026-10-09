import type { AnimatedStyle } from "react-native-reanimated";
import type { StyleProp, ViewStyle } from "react-native";

export type DrawerMaterialProps = {
  material: "ultraThin" | "thin" | "regular" | "thick";
  style?: StyleProp<AnimatedStyle<StyleProp<ViewStyle>>>;
};
