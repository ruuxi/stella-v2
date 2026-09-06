import { Pressable } from "react-native";
import { GlassSurface } from "./glass";
import type { NativeMenuProps } from "./NativeMenu.types";

/** Android fallback; iOS uses the system SwiftUI Menu implementation. */
export function NativeMenu(props: NativeMenuProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      disabled={props.disabled}
      onPress={props.onFallbackPress}
    >
      <GlassSurface
        radius={props.circular ? props.height / 2 : 14}
        legible
        style={{
          width: props.width,
          height: props.height,
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        {props.label}
      </GlassSurface>
    </Pressable>
  );
}
