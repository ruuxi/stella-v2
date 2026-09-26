import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";
import { useColors } from "../theme/theme-context";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  disabled?: boolean;
};

export type SegmentedControlProps<T extends string> = {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  accessibilityLabel: string;
  disabled?: boolean;
};

/**
 * One-of-many choice as a single segmented track: the system control on iOS
 * (`SegmentedControl.ios.tsx`), this drawn equivalent elsewhere.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
  disabled = false,
}: SegmentedControlProps<T>) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      style={styles.track}
    >
      {options.map((option) => {
        const selected = option.value === value;
        const off = disabled || option.disabled === true;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled: off }}
            disabled={off}
            onPress={() => onChange(option.value)}
            style={[
              styles.segment,
              selected && styles.segmentSelected,
              off && styles.segmentDisabled,
            ]}
          >
            <Text
              numberOfLines={1}
              style={[styles.label, selected && styles.labelSelected]}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    track: {
      backgroundColor: fadeHex(colors.text, 0.06),
      borderRadius: 10,
      flexDirection: "row",
      padding: 2,
    },
    segment: {
      alignItems: "center",
      borderRadius: 8,
      flex: 1,
      justifyContent: "center",
      minHeight: 30,
      paddingHorizontal: 8,
    },
    segmentSelected: {
      backgroundColor: colors.surface,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.12,
      shadowRadius: 3,
    },
    segmentDisabled: { opacity: 0.45 },
    label: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
    },
    labelSelected: { color: colors.text },
  });
