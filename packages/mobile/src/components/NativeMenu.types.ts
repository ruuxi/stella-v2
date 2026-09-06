import type { ButtonProps } from "@expo/ui/swift-ui";
import type { ReactNode } from "react";

export type NativeMenuItem = {
  id: string;
  title: string;
  onPress: () => void;
  selected?: boolean;
  disabled?: boolean;
  systemImage?: ButtonProps["systemImage"];
  separatorBefore?: boolean;
};

export type NativeMenuProps = {
  label: ReactNode;
  accessibilityLabel: string;
  items: NativeMenuItem[];
  width: number;
  height: number;
  circular?: boolean;
  disabled?: boolean;
  onFallbackPress: () => void;
};
