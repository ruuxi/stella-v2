import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { AppBackdrop } from "./AppBackdrop";

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
 * Opaque canvas for a detail route (Settings, Account, Cloud Home) pushed
 * over the chat. The chat stays mounted underneath the push so it keeps its
 * scroll position, draft, and journal socket; this surface carries the same
 * backdrop the shell paints so nothing of the chat shows through the slide.
 */
export function MainDetailSurface({ children }: { children: ReactNode }) {
  return (
    <View style={styles.root}>
      <AppBackdrop />
      <View style={mainContentStyles.content}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
  },
});
