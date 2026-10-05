import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppBackdrop, TOP_BAR_BAR_HEIGHT } from "./AppBackdrop";

/**
 * The padded content box every `(main)` route sits in. Routes apply it
 * themselves rather than inheriting it from the shell so a route pushed over
 * the chat can paint its own edge-to-edge canvas (see `MainDetailSurface`).
 */
export const mainContentStyles = StyleSheet.create({
  content: {
    flex: 1,
    minHeight: 0,
    paddingHorizontal: 20,
    paddingTop: 4,
  },
});

/**
 * Height of the shell's top bar, safe area included. The bar floats over
 * every `(main)` route, so a route starts its content this far down; the
 * chat instead runs its transcript underneath it.
 */
export function useShellTopInset(): number {
  return useSafeAreaInsets().top + TOP_BAR_BAR_HEIGHT;
}

/**
 * Opaque canvas for a detail route (Settings, Account, Cloud Home) pushed
 * over the chat. The chat stays mounted underneath the push so it keeps its
 * scroll position, draft, and journal socket; this surface carries the same
 * backdrop the shell paints so nothing of the chat shows through the slide.
 */
export function MainDetailSurface({ children }: { children: ReactNode }) {
  const topInset = useShellTopInset();
  return (
    <View style={styles.root}>
      <AppBackdrop />
      <View
        style={[
          mainContentStyles.content,
          { paddingTop: topInset + mainContentStyles.content.paddingTop },
        ]}
      >
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
  },
});
