import { useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TopSheet } from "./TopSheet";
import { EngineAccountsSections } from "./EngineAccountsSettings";
import { ComputerSection } from "./settings/ComputerSection";
import { makeSettingsStyles } from "./settings/settings-styles";
import { authClient } from "../lib/auth-client";
import { isGuest } from "../lib/guest-mode";
import { useComputerControl } from "../lib/main-shell-store";
import { useColors } from "../theme/theme-context";

/**
 * The chat's own settings, opened from the gear at the top right of the chat:
 * the paired computer, where turns run, the model, pairing, and the Claude /
 * ChatGPT accounts those models run on. These belong to the conversation
 * rather than the app, so they live here instead of on the account tab.
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

  return (
    <TopSheet visible={visible} onClose={onClose} contentSized>
      <View style={{ paddingTop: insets.top + 8 }}>
        <ScrollView contentContainerStyle={styles.content}>
          <ComputerSection
            control={computer}
            signedIn={signedIn}
            styles={settingsStyles}
          />
          {signedIn ? <EngineAccountsSections /> : null}
        </ScrollView>
      </View>
    </TopSheet>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 20, paddingHorizontal: 16 },
});
