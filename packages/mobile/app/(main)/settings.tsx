import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GlassToggle } from "../../src/components/glass";
import { authClient } from "../../src/lib/auth-client";
import { clearCachedDesktopBridge } from "../../src/lib/desktop-bridge-chat";
import { isGuest } from "../../src/lib/guest-mode";
import { useCloudBrowserActions } from "../../src/lib/cloud-browser";
import { tapLight } from "../../src/lib/haptics";
import {
  clearStoredPhoneAccess,
  listStoredPairedPhoneAccess,
  type StoredPhoneAccess,
} from "../../src/lib/phone-access";
import { useDesktopPlatforms } from "../../src/lib/use-desktop-platforms";
import {
  getNotificationsMuted,
  setNotificationsMuted,
  subscribeNotificationsMuted,
} from "../../src/lib/notifications-prefs";
import { type Colors } from "../../src/theme/colors";
import {
  useColors,
  useTheme,
  type GradientMode,
  type ThemePreference,
} from "../../src/theme/theme-context";
import { resolveThemeColors } from "@stella/theme";
import { fonts } from "../../src/theme/fonts";
import { useT } from "../../src/i18n";

const APPEARANCE_OPTIONS: { value: ThemePreference; labelKey: string }[] = [
  { value: "system", labelKey: "mobile.settings.appearance.system" },
  { value: "light", labelKey: "mobile.settings.appearance.light" },
  { value: "dark", labelKey: "mobile.settings.appearance.dark" },
];

const GRADIENT_OPTIONS: { value: GradientMode; labelKey: string }[] = [
  { value: "soft", labelKey: "mobile.settings.background.soft" },
  { value: "flat", labelKey: "mobile.settings.background.flat" },
];

function platformLabelFor(
  t: (key: string, params?: Record<string, string | number>) => string,
  access: StoredPhoneAccess,
  platform: string | null | undefined,
): string {
  const base = platform?.trim();
  if (base) return base;
  return t("mobile.settings.paired.unnamedComputer", {
    id: access.desktopDeviceId.slice(0, 4).toUpperCase(),
  });
}

export default function SettingsScreen() {
  const colors = useColors();
  const t = useT();
  const {
    preference,
    setPreference,
    selectedThemeId,
    setThemeId,
    themes,
    isDark,
    flat,
    gradientPreference,
    setGradientPreference,
  } = useTheme();
  // Flat themes (Default) paint no blob — disable the Soft option so the
  // toggle reflects the actual rendered surface instead of misleading the user.
  const gradientLocked = flat;
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const session = authClient.useSession();
  const guest = isGuest();
  const [isResettingCloudBrowser, setIsResettingCloudBrowser] = useState(false);
  const { resetProfile: resetCloudBrowserProfile } = useCloudBrowserActions();
  const [pairedDesktops, setPairedDesktops] = useState<StoredPhoneAccess[]>([]);
  const desktopPlatforms = useDesktopPlatforms(pairedDesktops);
  const [removingDesktopId, setRemovingDesktopId] = useState<string | null>(
    null,
  );
  const [notificationsMuted, setMutedLocal] = useState(() =>
    getNotificationsMuted(),
  );

  useEffect(() => subscribeNotificationsMuted(setMutedLocal), []);

  const user = session.data?.user;

  // The whole "you have an account" surface — name/email header, upgrade card,
  // paired computers, sign-out, delete — only makes sense when the user has a
  // real session. Settings, appearance, notifications, and legal all work
  // without one, so we render the page either way and just hide the bits
  // that need an identity.
  const isSignedIn = Boolean(user) && !guest;

  const refreshPaired = useCallback(async () => {
    const next = await listStoredPairedPhoneAccess();
    setPairedDesktops(next);
  }, []);

  useEffect(() => {
    void refreshPaired();
  }, [refreshPaired]);

  const confirmForgetDesktop = (access: StoredPhoneAccess) => {
    const label = platformLabelFor(
      t,
      access,
      desktopPlatforms[access.desktopDeviceId],
    );
    Alert.alert(
      t("mobile.settings.forgetConfirmTitle", { name: label }),
      t("mobile.settings.forgetConfirmBody"),
      [
        { text: t("mobile.common.cancel"), style: "cancel" },
        {
          text: t("mobile.settings.forget"),
          style: "destructive",
          onPress: () => {
            setRemovingDesktopId(access.desktopDeviceId);
            clearCachedDesktopBridge(access.desktopDeviceId);
            void clearStoredPhoneAccess(access.desktopDeviceId)
              .then(() => refreshPaired())
              .finally(() => setRemovingDesktopId(null));
          },
        },
      ],
    );
  };

  const runResetCloudBrowser = async () => {
    if (isResettingCloudBrowser) return;
    setIsResettingCloudBrowser(true);
    try {
      await resetCloudBrowserProfile();
      Alert.alert(
        t("cloudBrowser.settings.title"),
        t("cloudBrowser.settings.resetComplete"),
      );
    } catch {
      Alert.alert(
        t("cloudBrowser.settings.title"),
        t("cloudBrowser.settings.resetFailed"),
      );
    } finally {
      setIsResettingCloudBrowser(false);
    }
  };

  const confirmResetCloudBrowser = () => {
    Alert.alert(
      t("cloudBrowser.settings.confirmTitle"),
      t("cloudBrowser.settings.confirmBody"),
      [
        { text: t("mobile.common.cancel"), style: "cancel" },
        {
          text: t("cloudBrowser.settings.reset"),
          style: "destructive",
          onPress: () => void runResetCloudBrowser(),
        },
      ],
    );
  };

  const toggleNotifications = (next: boolean) => {
    setMutedLocal(!next);
    void setNotificationsMuted(!next);
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.scrollContent,
        { paddingBottom: 32 + insets.bottom },
      ]}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="never"
      automaticallyAdjustContentInsets={false}
    >
      <View style={styles.sheetHeader}>
        <Text style={styles.title}>{t("mobile.settings.title")}</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.dismissTo("/chat")}
          style={styles.doneButton}
        >
          <Text style={styles.doneText}>{t("mobile.common.done")}</Text>
        </Pressable>
      </View>

      {isSignedIn ? (
        <>
          <Text style={styles.sectionLabel}>
            {t("mobile.cloudHome.settingsSection")}
          </Text>
          <Pressable
            onPress={() => router.push("/cloud-home")}
            accessibilityLabel={t("mobile.cloudHome.openSettingsLabel")}
            style={({ pressed }) => [
              styles.legalRow,
              pressed && styles.legalRowPressed,
            ]}
          >
            <View style={styles.toggleCopy}>
              <Text style={styles.legalLabel}>
                {t("mobile.cloudHome.settingsRowTitle")}
              </Text>
              <Text style={styles.toggleSub}>
                {t("mobile.cloudHome.settingsRowBody")}
              </Text>
            </View>
            <Text style={styles.legalChevron}>›</Text>
          </Pressable>

          <View style={styles.separator} />
          <Text style={styles.sectionLabel}>
            {t("cloudBrowser.settings.title")}
          </Text>
          <View style={styles.toggleRow}>
            <View style={styles.toggleCopy}>
              <Text style={styles.toggleLabel}>
                {t("cloudBrowser.settings.defaultProfile")}
              </Text>
              <Text style={styles.toggleSub}>
                {t("cloudBrowser.settings.description")}
              </Text>
            </View>
            <Pressable
              onPress={confirmResetCloudBrowser}
              disabled={isResettingCloudBrowser}
              accessibilityRole="button"
              accessibilityLabel={t("cloudBrowser.settings.reset")}
              style={({ pressed }) => [
                styles.forgetButton,
                pressed && styles.forgetButtonPressed,
                isResettingCloudBrowser && styles.forgetButtonDisabled,
              ]}
            >
              <Text style={styles.resetBrowserText}>
                {isResettingCloudBrowser
                  ? t("cloudBrowser.settings.resetting")
                  : t("cloudBrowser.settings.reset")}
              </Text>
            </Pressable>
          </View>
        </>
      ) : null}

      {isSignedIn ? <View style={styles.separator} /> : null}

      <Text style={styles.sectionLabel}>
        {t("mobile.settings.appearanceSection")}
      </Text>
      <View style={styles.themeRow}>
        {APPEARANCE_OPTIONS.map((opt) => (
          <Pressable
            key={opt.value}
            onPress={() => {
              tapLight();
              setPreference(opt.value);
            }}
            accessibilityLabel={t("mobile.settings.useAppearanceLabel", {
              name: t(opt.labelKey),
            })}
            style={[
              styles.themeOption,
              preference === opt.value && styles.themeOptionActive,
            ]}
          >
            <Text
              style={[
                styles.themeOptionText,
                preference === opt.value && styles.themeOptionTextActive,
              ]}
            >
              {t(opt.labelKey)}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.themeRow}>
        {GRADIENT_OPTIONS.map((opt) => {
          const isSelected = gradientLocked
            ? opt.value === "flat"
            : gradientPreference === opt.value;
          const disabled = gradientLocked && opt.value !== "flat";
          return (
            <Pressable
              key={opt.value}
              onPress={() => {
                if (disabled) return;
                tapLight();
                setGradientPreference(opt.value);
              }}
              disabled={disabled}
              accessibilityLabel={t("mobile.settings.useBackgroundLabel", {
                name: t(opt.labelKey),
              })}
              accessibilityState={{ selected: isSelected, disabled }}
              style={[
                styles.themeOption,
                isSelected && styles.themeOptionActive,
                disabled && styles.themeOptionDisabled,
              ]}
            >
              <Text
                style={[
                  styles.themeOptionText,
                  isSelected && styles.themeOptionTextActive,
                ]}
              >
                {t(opt.labelKey)}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.themeDots}>
        {themes.map((th) => {
          // Resolve through the shared catalog so forced-mode themes preview
          // in the appearance they actually render.
          const preview = resolveThemeColors(th, isDark).colors;
          const isActive = th.id === selectedThemeId;
          return (
            <Pressable
              key={th.id}
              onPress={() => {
                tapLight();
                setThemeId(th.id);
              }}
              accessibilityLabel={t("mobile.settings.useThemeLabel", {
                name: th.name,
              })}
              accessibilityState={{ selected: isActive }}
              style={[
                styles.themeDotOuter,
                isActive && { borderColor: colors.accent },
              ]}
            >
              <View
                style={[
                  styles.themeDotSwatch,
                  {
                    backgroundColor: preview.background,
                    borderColor: preview.border,
                  },
                ]}
              >
                <View
                  style={[
                    styles.themeDotAccent,
                    { backgroundColor: preview.primary },
                  ]}
                />
              </View>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.separator} />

      <Text style={styles.sectionLabel}>
        {t("mobile.settings.notificationsSection")}
      </Text>
      <View style={styles.toggleRow}>
        <View style={styles.toggleCopy}>
          <Text style={styles.toggleLabel}>
            {t("mobile.settings.pushToggleLabel")}
          </Text>
          <Text style={styles.toggleSub}>
            {t("mobile.settings.pushToggleSub")}
          </Text>
        </View>
        <GlassToggle
          value={!notificationsMuted}
          onValueChange={toggleNotifications}
          accessibilityLabel={t("mobile.settings.pushToggleA11y")}
        />
      </View>

      {isSignedIn ? (
        <>
          <View style={styles.separator} />

          <Text style={styles.sectionLabel}>
            {t("mobile.settings.pairedSection")}
          </Text>
          {pairedDesktops.length === 0 ? (
            <Text style={styles.emptyHint}>
              {t("mobile.settings.pairedEmpty")}
            </Text>
          ) : (
            <View style={styles.pairedList}>
              {pairedDesktops.map((access) => {
                const label = platformLabelFor(
                  t,
                  access,
                  desktopPlatforms[access.desktopDeviceId],
                );
                const removing = removingDesktopId === access.desktopDeviceId;
                return (
                  <View key={access.desktopDeviceId} style={styles.pairedRow}>
                    <View style={styles.pairedCopy}>
                      <Text style={styles.pairedName}>{label}</Text>
                      <Text style={styles.pairedSub}>
                        {t("mobile.settings.pairedOn", {
                          date: new Date(access.approvedAt).toLocaleDateString(
                            undefined,
                            {
                              month: "short",
                              day: "numeric",
                            },
                          ),
                        })}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => confirmForgetDesktop(access)}
                      disabled={removing}
                      accessibilityLabel={t("mobile.settings.forgetLabel", {
                        name: label,
                      })}
                      style={({ pressed }) => [
                        styles.forgetButton,
                        pressed && styles.forgetButtonPressed,
                        removing && styles.forgetButtonDisabled,
                      ]}
                    >
                      <Text style={styles.forgetText}>
                        {removing ? "\u2026" : t("mobile.settings.forget")}
                      </Text>
                    </Pressable>
                  </View>
                );
              })}
            </View>
          )}
        </>
      ) : null}

      <View style={styles.separator} />

      <View style={styles.legalBlock}>
        <Pressable
          onPress={() => router.push("/carplay-diagnostics")}
          accessibilityLabel={t("mobile.settings.openCarPlayDiagnosticsLabel")}
          style={({ pressed }) => [
            styles.legalRow,
            pressed && styles.legalRowPressed,
          ]}
        >
          <Text style={styles.legalLabel}>
            {t("mobile.settings.carPlayDiagnostics")}
          </Text>
          <Text style={styles.legalChevron}>›</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: colors.background,
    },
    scrollContent: {
      paddingHorizontal: 20,
      paddingTop: 8,
      paddingBottom: 32,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.display.regular,
      fontSize: 28,
      letterSpacing: -1.2,
      flex: 1,
    },
    sheetHeader: {
      flexDirection: "row",
      alignItems: "center",
      paddingTop: 20,
      paddingBottom: 12,
    },
    doneButton: {
      minHeight: 44,
      justifyContent: "center",
      paddingHorizontal: 12,
    },
    doneText: {
      color: colors.accent,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
    },
    body: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 15,
      letterSpacing: -0.2,
      marginTop: 4,
    },
    separator: {
      backgroundColor: colors.border,
      height: StyleSheet.hairlineWidth,
      marginVertical: 20,
    },
    sectionLabel: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: 0.3,
      marginBottom: 10,
      textTransform: "uppercase",
    },
    themeRow: {
      flexDirection: "row",
      gap: 8,
      marginBottom: 16,
    },
    themeOption: {
      borderColor: colors.border,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      paddingHorizontal: 16,
      paddingVertical: 9,
    },
    themeOptionActive: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
    themeOptionDisabled: {
      opacity: 0.4,
    },
    themeOptionText: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.2,
    },
    themeOptionTextActive: {
      color: colors.accentForeground,
    },
    themeDots: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 12,
    },
    themeDotOuter: {
      alignItems: "center",
      borderColor: "transparent",
      borderRadius: 20,
      borderWidth: 2,
      justifyContent: "center",
      padding: 2,
    },
    themeDotSwatch: {
      alignItems: "center",
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      height: 28,
      justifyContent: "center",
      overflow: "hidden",
      width: 28,
    },
    themeDotAccent: {
      borderRadius: 7,
      height: 14,
      width: 14,
    },
    toggleRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 16,
    },
    toggleCopy: {
      flex: 1,
      gap: 2,
    },
    toggleLabel: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    toggleSub: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      lineHeight: 18,
    },
    emptyHint: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 20,
    },
    pairedList: {
      gap: 6,
    },
    pairedRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      paddingVertical: 10,
    },
    pairedCopy: {
      flex: 1,
      gap: 2,
    },
    pairedName: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    pairedSub: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
    },
    forgetButton: {
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    forgetButtonPressed: {
      opacity: 0.6,
    },
    forgetButtonDisabled: {
      opacity: 0.4,
    },
    forgetText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: -0.1,
    },
    resetBrowserText: {
      color: colors.danger,
      fontFamily: fonts.sans.medium,
      fontSize: 13,
      letterSpacing: -0.1,
    },
    legalBlock: {
      gap: 2,
      marginBottom: 12,
      marginTop: 4,
    },
    legalRow: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      paddingVertical: 10,
    },
    legalRowPressed: {
      opacity: 0.85,
    },
    legalLabel: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    legalChevron: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 18,
    },
  } as const);
