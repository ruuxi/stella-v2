import { useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "./Icon";
import { GlassToggle } from "./glass";
import { PrimaryButton } from "./PrimaryButton";
import type { CloudConversationIdentity } from "../lib/cloud-conversation-auth";
import { useCloudMemoryPreference } from "../lib/use-cloud-memory-preference";
import { type Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { useColors } from "../theme/theme-context";
import { useT } from "../i18n";

type CloudHomeSettingsProps = {
  identity: CloudConversationIdentity | null;
  onBack: () => void;
  onSignIn: () => void;
};

export function CloudHomeSettings({
  identity,
  onBack,
  onSignIn,
}: CloudHomeSettingsProps) {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const memoryPreference = useCloudMemoryPreference(identity);

  const header = (
    <View style={styles.header}>
      <Pressable
        onPress={onBack}
        hitSlop={10}
        accessibilityLabel={t("mobile.cloudHome.backToSettingsLabel")}
        style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
      >
        <Icon name="chevron-left" size={22} color={colors.text} />
      </Pressable>
      <View style={styles.headerCopy}>
        <Text style={styles.title} numberOfLines={1}>
          {t("mobile.cloudHome.title")}
        </Text>
      </View>
    </View>
  );

  if (!identity) {
    return (
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[
          styles.content,
          { paddingBottom: 32 + insets.bottom },
        ]}
      >
        {header}
        <View style={styles.stateCard}>
          <Text style={styles.stateTitle}>
            {t("mobile.cloudHome.signInTitle")}
          </Text>
          <Text style={styles.stateBody}>
            {t("mobile.cloudHome.signInBody")}
          </Text>
          <PrimaryButton
            label={t("mobile.cloudHome.signIn")}
            onPress={onSignIn}
            style={styles.stateButton}
          />
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: 32 + insets.bottom },
      ]}
    >
      {header}
      <View style={styles.memoryPreferenceCard}>
        <View style={styles.memoryPreferenceCopy}>
          <Text style={styles.memoryPreferenceTitle}>
            {t("settings.memory.title")}
          </Text>
          <Text style={styles.memoryPreferenceBody}>
            {t("settings.memory.description")}
          </Text>
        </View>
        <View style={styles.memoryPreferenceControl}>
          {memoryPreference.status === "loading" ||
          memoryPreference.status === "saving" ? (
            <ActivityIndicator color={colors.accent} size="small" />
          ) : null}
          <GlassToggle
            value={memoryPreference.memoryEnabled}
            disabled={memoryPreference.disabled}
            onValueChange={memoryPreference.setMemoryEnabled}
            accessibilityLabel={t("settings.memory.title")}
          />
        </View>
      </View>
      {memoryPreference.issue ? (
        <View style={styles.messageCard}>
          <Text style={styles.errorText}>
            {t(
              memoryPreference.issue === "load"
                ? "settings.errors.loadMemory"
                : "settings.errors.saveMemory",
            )}
          </Text>
          <Pressable
            onPress={memoryPreference.retry}
            accessibilityLabel={t("common.tryAgain")}
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.secondaryButtonText}>
              {t("common.tryAgain")}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: { flex: 1 },
    content: { paddingBottom: 32, paddingTop: 8 },
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      marginBottom: 20,
    },
    backButton: {
      alignItems: "center",
      height: 40,
      justifyContent: "center",
      marginLeft: -8,
      width: 40,
    },
    headerCopy: { flex: 1 },
    title: {
      color: colors.text,
      fontFamily: fonts.display.regular,
      fontSize: 26,
      letterSpacing: -1,
    },
    stateCard: {
      backgroundColor: colors.card,
      borderColor: colors.border,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      padding: 18,
    },
    stateTitle: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 16,
    },
    stateBody: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 20,
      marginTop: 4,
    },
    stateButton: { alignSelf: "flex-start", marginTop: 16 },
    memoryPreferenceCard: {
      alignItems: "center",
      backgroundColor: colors.card,
      borderColor: colors.border,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 14,
      marginBottom: 12,
      padding: 16,
    },
    memoryPreferenceCopy: { flex: 1 },
    memoryPreferenceTitle: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 16,
    },
    memoryPreferenceBody: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 4,
    },
    memoryPreferenceControl: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
    },
    pressed: { opacity: 0.68 },
    messageCard: {
      backgroundColor: colors.card,
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      gap: 9,
      marginBottom: 12,
      padding: 12,
    },
    errorText: {
      color: colors.danger,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      lineHeight: 18,
    },
    secondaryButton: {
      alignSelf: "flex-start",
      borderColor: colors.borderStrong,
      borderRadius: 18,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 13,
      paddingVertical: 8,
    },
    secondaryButtonText: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
    },
  } as const);
