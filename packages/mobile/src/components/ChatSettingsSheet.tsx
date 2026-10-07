import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TopSheet } from "./TopSheet";
import { GlassSurface } from "./glass";
import { ModelSettingsPanel } from "./ModelSettingsPanel";
import { SegmentedControl } from "./SegmentedControl";
import { ComputerSection } from "./settings/ComputerSection";
import { makeSettingsStyles } from "./settings/settings-styles";
import { authClient } from "../lib/auth-client";
import { isGuest } from "../lib/guest-mode";
import { useComputerControl } from "../lib/main-shell-store";
import { fadeHex } from "../theme/oklch";
import { useColors } from "../theme/theme-context";

/** Which brain, or which machine. The two are peers, not one long scroll. */
type SheetView = "models" | "device";

const VIEW_OPTIONS: { value: SheetView; label: string }[] = [
  { value: "models", label: "Models" },
  { value: "device", label: "Device" },
];

/**
 * One height for both views, set by where the switch has to land rather than
 * by how much content there is.
 *
 * The switch hangs off the sheet's bottom edge, so the sheet's height decides
 * its reachability: a shorter sheet walks the switch back up the screen,
 * undoing the reason it sits low at all. This puts the sheet's edge around
 * 700pt on a 874pt screen, which leaves the switch in the thumb zone and
 * still clear of the composer beneath. Air inside the sheet is the expected
 * outcome, not a problem to pack out.
 */
const CHAT_SETTINGS_HEIGHT_FRACTION = 0.8;

/**
 * The chat's own settings, opened from the gear at the top right of the chat.
 *
 * Two views rather than one scroll: Models (the engine, how hard it thinks,
 * which model, and that engine's account) and Device (where turns run and
 * which computers are paired). They are peers — one picks the brain, the
 * other the machine — and interleaving them made the sheet dense.
 *
 * The switch floats just beneath the sheet's bottom edge. This sheet hangs
 * from the top, so that space is really there; the control sits near the
 * thumb rather than at the top edge, and it belongs to one deliberate visit
 * rather than taxing every screen the way a permanent tab bar would.
 *
 * Both views share one fixed height. Content-sizing made the sheet jump when
 * switching tabs, moving the switch out from under the thumb that just
 * pressed it; Device simply has room to spare below its rows, which costs
 * nothing next to stable geometry.
 */
export function ChatSettingsSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const settingsStyles = useMemo(() => makeSettingsStyles(colors), [colors]);
  const session = authClient.useSession();
  const computer = useComputerControl();
  const signedIn = Boolean(session.data?.user) && !isGuest();
  const [view, setView] = useState<SheetView>("models");

  return (
    <TopSheet
      visible={visible}
      onClose={onClose}
      heightFraction={CHAT_SETTINGS_HEIGHT_FRACTION}
      floatingFooter={
        <GlassSurface
          glass="regular"
          radius={999}
          ringed
          legible
          fallbackColor={fadeHex(colors.surface, 0.96)}
          style={styles.switcher}
        >
          <SegmentedControl<SheetView>
            accessibilityLabel="Chat settings view"
            value={view}
            onChange={setView}
            options={VIEW_OPTIONS}
          />
        </GlassSurface>
      }
    >
      <View style={{ paddingTop: insets.top + 8 }}>
        <ScrollView contentContainerStyle={styles.content}>
          {view === "models" ? (
            computer?.model ? (
              <ModelSettingsPanel
                settings={computer.model.settings}
                composerModelPinned={computer.composerModelPinned}
                onComposerModelPinnedChange={
                  computer.onComposerModelPinnedChange
                }
                styles={settingsStyles}
              />
            ) : null
          ) : (
            <ComputerSection
              control={computer}
              signedIn={signedIn}
              styles={settingsStyles}
            />
          )}
        </ScrollView>
      </View>
    </TopSheet>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 20, paddingHorizontal: 16 },
  switcher: {
    minWidth: 240,
    padding: 5,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.16,
    shadowRadius: 16,
  },
});
