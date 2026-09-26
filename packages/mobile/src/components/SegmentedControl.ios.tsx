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

/** The system segmented control, in Stella's colour scheme. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
  disabled = false,
}: SegmentedControlProps<T>) {
  const { isDark } = useTheme();
  return (
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
  );
}
