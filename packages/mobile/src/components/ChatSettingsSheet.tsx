import { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TopSheet } from "./TopSheet";
import { GlassToggle } from "./glass";
import { DestinationChips } from "./chat-settings/DestinationChips";
import { ProviderCards } from "./chat-settings/ProviderCards";
import { makeSettingsStyles } from "./settings/settings-styles";
import { authClient } from "../lib/auth-client";
import { isGuest } from "../lib/guest-mode";
import { useComputerControl } from "../lib/main-shell-store";
import { useT } from "../i18n";
import { useColors } from "../theme/theme-context";

/**
 * The chat's own settings, opened from the gear at the top right of the chat.
 *
 * One page, read top to bottom: where turns run (Cloud and every computer, as
 * a row of chips), then which brain runs them (one card per provider, the
 * chosen one open with its models, thinking and accounts), then the composer
 * shortcut. Where and which brain change together, so they share a page
 * instead of hiding behind each other's tab.
 *
 * The sheet hugs its content up to the usual cap, leaving the scrim band
 * below it as the way out.
 */
export function ChatSettingsSheet({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const colors = useColors();
  const t = useT();
  const insets = useSafeAreaInsets();
  const settingsStyles = useMemo(() => makeSettingsStyles(colors), [colors]);
  const session = authClient.useSession();
  const computer = useComputerControl();
  const signedIn = Boolean(session.data?.user) && !isGuest();
  const showDestinations = computer !== null || signedIn;

  return (
    <TopSheet visible={visible} onClose={onClose} contentSized>
      <View style={[styles.frame, { paddingTop: insets.top + 8 }]}>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          {showDestinations ? (
            <>
              <Text style={[settingsStyles.sectionLabel, styles.firstLabel]}>
                {t("mobile.settings.computer.sectionLabel")}
              </Text>
              <DestinationChips control={computer} signedIn={signedIn} />
            </>
          ) : null}

          {computer?.model ? (
            <>
              <ProviderCards settings={computer.model.settings} />
              <View style={[settingsStyles.group, styles.composerGroup]}>
                <View style={settingsStyles.row}>
                  <Text style={[settingsStyles.rowLabel, styles.flex]}>
                    Show in composer
                  </Text>
                  <GlassToggle
                    value={computer.composerModelPinned}
                    onValueChange={computer.onComposerModelPinnedChange}
                    accessibilityLabel="Show model picker in composer"
                  />
                </View>
              </View>
            </>
          ) : null}
        </ScrollView>
      </View>
    </TopSheet>
  );
}

const styles = StyleSheet.create({
  frame: { flexShrink: 1 },
  scroll: { flexGrow: 0, flexShrink: 1 },
  content: { paddingBottom: 20, paddingHorizontal: 16 },
  firstLabel: { marginTop: 4 },
  composerGroup: { marginTop: 4 },
  flex: { flex: 1 },
});
