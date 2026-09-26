import { View } from "react-native";
import { Host, Picker, Text } from "@expo/ui/swift-ui";
import {
  accessibilityLabel as a11yLabel,
  disabled as disabledModifier,
  pickerStyle,
  tag,
} from "@expo/ui/swift-ui/modifiers";
import { useTheme } from "../theme/theme-context";
import type { SegmentedControlProps } from "./SegmentedControl";

export type { SegmentedOption, SegmentedControlProps } from "./SegmentedControl";

/** The iOS 26 segmented control's intrinsic height. */
const SEGMENTED_HEIGHT = 36;

/** The system segmented control, in Stella's colour scheme. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
  disabled = false,
}: SegmentedControlProps<T>) {
  const { isDark } = useTheme();
  // The host's measured height can arrive as zero on first layout inside a
  // sheet, which let the rows below slide under the control. A plain wrapper
  // reserves the height; sizing the host itself stops SwiftUI drawing it.
  return (
    <View style={{ alignSelf: "stretch", height: SEGMENTED_HEIGHT }}>
      <Host
        colorScheme={isDark ? "dark" : "light"}
        matchContents={{ vertical: true }}
        style={{ alignSelf: "stretch" }}
      >
        <Picker<string>
          selection={value}
          onSelectionChange={(next) => {
            const option = options.find((entry) => entry.value === next);
            if (option && !option.disabled) onChange(option.value);
          }}
          modifiers={[
            pickerStyle("segmented"),
            a11yLabel(accessibilityLabel),
            disabledModifier(disabled),
          ]}
        >
          {options.map((option) => (
            <Text key={option.value} modifiers={[tag(option.value)]}>
              {option.label}
            </Text>
          ))}
        </Picker>
      </Host>
    </View>
  );
}
