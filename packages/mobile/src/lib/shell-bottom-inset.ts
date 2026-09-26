import { createContext, useContext } from "react";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * How much of the screen's bottom edge the shell's floating tab bar covers,
 * measured from the screen bottom (home indicator included). Routes read it
 * instead of `insets.bottom` so their last row and the chat composer rest
 * above the bar, while their scroll content still passes under its glass.
 *
 * `null` outside the shell (or while the bar is hidden), where the plain
 * safe-area inset applies. It is deliberately a separate context rather than
 * an override of the safe-area provider, so modals opened from a route keep
 * their own, real insets.
 */
const ShellBottomInsetContext = createContext<number | null>(null);

export const ShellBottomInsetProvider = ShellBottomInsetContext.Provider;

export function useShellBottomInset(): number {
  const insets = useSafeAreaInsets();
  return useContext(ShellBottomInsetContext) ?? insets.bottom;
}
