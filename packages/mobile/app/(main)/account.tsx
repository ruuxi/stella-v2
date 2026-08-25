import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../../src/components/Icon";
import { GlassToggle } from "../../src/components/glass";
import { PrimaryButton } from "../../src/components/PrimaryButton";
import { SubscriptionSection } from "../../src/components/SubscriptionSection";
import { authClient } from "../../src/lib/auth-client";
import { clearAiConsent } from "../../src/lib/ai-consent";
import { clearCachedToken } from "../../src/lib/auth-token";
import { clearCachedDesktopBridge } from "../../src/lib/desktop-bridge-chat";
import { isGuest } from "../../src/lib/guest-mode";
import { clearAccountChatData } from "../../src/lib/chat-account-cleanup";
import { userFacingError } from "../../src/lib/user-facing-error";
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
import {
  getVoiceTargetPreference,
  loadVoiceTargetPreference,
  setVoiceTargetPreference,
  subscribeVoiceTargetPreference,
  type VoiceTargetPreference,
} from "../../src/lib/voice-target";
import { unregisterForPushNotifications } from "../../src/lib/notifications";
import { type Colors } from "../../src/theme/colors";
import {
  useColors,
  useTheme,
  type GradientMode,
  type ThemePreference,
} from "../../src/theme/theme-context";
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

const VOICE_TARGET_OPTIONS: {
  value: VoiceTargetPreference;
  labelKey: string;
}[] = [
  { value: "auto", labelKey: "mobile.settings.voiceTarget.auto" },
  { value: "phone", labelKey: "mobile.settings.voiceTarget.phone" },
  { value: "computer", labelKey: "mobile.settings.voiceTarget.computer" },
];

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "••••••••";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const head = local.slice(0, 1);
  const asterisks = "*".repeat(Math.max(local.length - 1, 4));
  return `${head}${asterisks}${domain}`;
}

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

export default function AccountScreen() {
  const colors = useColors();
  const t = useT();
  const {
    preference,
    setPreference,
    theme: activeTheme,
    setThemeId,
    themes,
    isDark,
    gradientPreference,
    setGradientPreference,
  } = useTheme();

  const gradientLocked = Boolean(activeTheme.forcedMode);
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const session = authClient.useSession();
  const guest = isGuest();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [pairedDesktops, setPairedDesktops] = useState<StoredPhoneAccess[]>([]);
  const desktopPlatforms = useDesktopPlatforms(pairedDesktops);
  const [removingDesktopId, setRemovingDesktopId] = useState<string | null>(
    null,
  );
  const [notificationsMuted, setMutedLocal] = useState(() =>
    getNotificationsMuted(),
  );
  const [emailRevealed, setEmailRevealed] = useState(false);

  useEffect(() => subscribeNotificationsMuted(setMutedLocal), []);

  const [voiceTarget, setVoiceTargetLocal] = useState<VoiceTargetPreference>(
    () => getVoiceTargetPreference(),
  );
  useEffect(() => {
    const unsubscribe = subscribeVoiceTargetPreference(setVoiceTargetLocal);
    void loadVoiceTargetPreference();
    return unsubscribe;
  }, []);
  const chooseVoiceTarget = (value: VoiceTargetPreference) => {
    setVoiceTargetLocal(value);
    void setVoiceTargetPreference(value);
  };

  const user = session.data?.user;
  const email = user?.email ?? "";
  const userName = user?.name?.trim() ?? "";

  useEffect(() => {
    setEmailRevealed(false);
  }, [email]);

  const isSignedIn = Boolean(user) && !guest;
  const showLoadingHeader = !guest && session.isPending && !user;

  const refreshPaired = useCallback(async () => {
    const next = await listStoredPairedPhoneAccess();
    setPairedDesktops(next);
  }, []);

  useEffect(() => {
    void refreshPaired();
  }, [refreshPaired]);

  const clearLocalAccountState = async () => {
    const paired = await listStoredPairedPhoneAccess().catch(
      () => [] as StoredPhoneAccess[],
    );
    await Promise.all(
      paired.map((access) =>
        clearStoredPhoneAccess(access.desktopDeviceId).catch(() => {}),
      ),
    );
    await clearAccountChatData();
    await refreshPaired();
  };

  const signOut = async () => {
    setIsSigningOut(true);
    try {
      await unregisterForPushNotifications();
      await authClient.signOut();
      clearCachedToken();
      clearCachedDesktopBridge();
      await clearLocalAccountState();
    } catch (e) {
      Alert.alert(t("mobile.settings.signOutLabel"), userFacingError(e));
    } finally {
      setIsSigningOut(false);
    }
  };

  const runDeleteAccount = async () => {
    setIsDeletingAccount(true);
    try {
      const client = authClient as unknown as {
        deleteUser?: (args?: { callbackURL?: string }) => Promise<unknown>;
      };
      if (typeof client.deleteUser !== "function") {
        throw new Error("Account deletion is not available in this build.");
      }
      await unregisterForPushNotifications();
      await client.deleteUser({});
      clearCachedToken();
      clearCachedDesktopBridge();
      await authClient.signOut();
      await clearLocalAccountState();
      clearAiConsent();
    } catch (e) {
      Alert.alert(t("mobile.settings.deleteFailedTitle"), userFacingError(e));
    } finally {
      setIsDeletingAccount(false);
    }
  };

  const confirmDeleteAccount = () => {
    Alert.alert(
      t("mobile.settings.deleteConfirmTitle"),
      t("mobile.settings.deleteConfirmBody"),
      [
        { text: t("mobile.common.cancel"), style: "cancel" },
        {
          text: t("mobile.common.delete"),
          style: "destructive",
          onPress: () => void runDeleteAccount(),
        },
      ],
    );
  };

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
    >
      <Text style={styles.title}>{t("mobile.settings.title")}</Text>

      {isSignedIn ? (
        <>
          <View style={styles.identityBlock}>
            {userName ? (
              <Text style={styles.identityName} numberOfLines={1}>
                {userName}
              </Text>
            ) : null}
            {email ? (
              <View
                style={[
                  styles.identityEmailRow,
                  !userName && styles.identityEmailRowPrimary,
                ]}
              >
                <Text
                  style={[
                    styles.identityEmail,
                    !userName && styles.identityEmailPrimary,
                  ]}
                  numberOfLines={1}
                >
                  {emailRevealed ? email : maskEmail(email)}
                </Text>
                <Pressable
                  onPress={() => {
                    tapLight();
                    setEmailRevealed((revealed) => !revealed);
                  }}
                  hitSlop={10}
                  accessibilityLabel={
                    emailRevealed
                      ? t("mobile.settings.hideEmailLabel")
                      : t("mobile.settings.showEmailLabel")
                  }
                  style={styles.identityEmailToggle}
                >
                  <Icon
                    name={emailRevealed ? "eye-off" : "eye"}
                    size={18}
                    color={colors.textMuted}
                  />
                </Pressable>
              </View>
            ) : null}
          </View>

        </>
      ) : showLoadingHeader ? (
        <Text style={styles.body}>{t("mobile.settings.loadingSession")}</Text>
      ) : (
        <View style={styles.signInBlock}>
          <Text style={styles.signInTitle}>
            {t("mobile.settings.signInTitle")}
          </Text>
          <PrimaryButton
            label={t("mobile.settings.signIn")}
            onPress={() => router.replace("/login")}
            accessibilityLabel={t("mobile.settings.signInTitle")}
            style={styles.signInButton}
          />
        </View>
      )}

      <SubscriptionSection />

      <View style={styles.separator} />

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

          const previewDark = th.forcedMode
            ? th.forcedMode === "dark"
            : isDark;
          const preview = previewDark ? th.dark : th.light;
          const isActive = th.id === activeTheme.id;
          return (
            <Pressable
              key={th.id}
              onPress={() => {
                tapLight();
                setThemeId(th.id);
              }}
              accessibilityLabel={t("mobile.settings.useThemeLabel", { name: th.name })}
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
                    { backgroundColor: preview.accent },
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

      {pairedDesktops.length > 0 ? (
        <>
          <View style={styles.separator} />

          <Text style={styles.sectionLabel}>
            {t("mobile.settings.voiceSection")}
          </Text>
          <Text style={styles.emptyHint}>
            {t("mobile.settings.voiceSectionHint")}
          </Text>
          <View style={styles.themeRow}>
            {VOICE_TARGET_OPTIONS.map((opt) => (
              <Pressable
                key={opt.value}
                onPress={() => {
                  tapLight();
                  chooseVoiceTarget(opt.value);
                }}
                accessibilityLabel={t("mobile.settings.voiceTargetLabel", {
                  name: t(opt.labelKey),
                })}
                accessibilityState={{ selected: voiceTarget === opt.value }}
                style={[
                  styles.themeOption,
                  voiceTarget === opt.value && styles.themeOptionActive,
                ]}
              >
                <Text
                  style={[
                    styles.themeOptionText,
                    voiceTarget === opt.value && styles.themeOptionTextActive,
                  ]}
                >
                  {t(opt.labelKey)}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}

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
                const removing =
                  removingDesktopId === access.desktopDeviceId;
                return (
                  <View key={access.desktopDeviceId} style={styles.pairedRow}>
                    <View style={styles.pairedCopy}>
                      <Text style={styles.pairedName}>{label}</Text>
                      <Text style={styles.pairedSub}>
                        {t("mobile.settings.pairedOn", {
                          date: new Date(
                            access.approvedAt,
                          ).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          }),
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
                        {removing
                          ? "\u2026"
                          : t("mobile.settings.forget")}
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
        <Pressable
          onPress={() => void Linking.openURL("https://stella.sh/terms")}
          accessibilityLabel={t("mobile.settings.openTermsLabel")}
          style={({ pressed }) => [
            styles.legalRow,
            pressed && styles.legalRowPressed,
          ]}
        >
          <Text style={styles.legalLabel}>
            {t("mobile.settings.termsOfService")}
          </Text>
          <Text style={styles.legalChevron}>›</Text>
        </Pressable>
        <Pressable
          onPress={() => void Linking.openURL("https://stella.sh/privacy")}
          accessibilityLabel={t("mobile.settings.openPrivacyLabel")}
          style={({ pressed }) => [
            styles.legalRow,
            pressed && styles.legalRowPressed,
          ]}
        >
          <Text style={styles.legalLabel}>
            {t("mobile.settings.privacyPolicy")}
          </Text>
          <Text style={styles.legalChevron}>›</Text>
        </Pressable>
      </View>

      {isSignedIn ? (
        <>
          <Pressable
            onPress={() => void signOut()}
            disabled={isSigningOut || isDeletingAccount}
            accessibilityLabel={t("mobile.settings.signOutLabel")}
            style={({ pressed }) => [
              styles.signOut,
              pressed && styles.signOutPressed,
              (isSigningOut || isDeletingAccount) && styles.signOutDisabled,
            ]}
          >
            <Text style={styles.signOutText}>
              {isSigningOut
                ? t("mobile.settings.signingOut")
                : t("mobile.settings.signOut")}
            </Text>
          </Pressable>

          <Pressable
            onPress={confirmDeleteAccount}
            disabled={isDeletingAccount || isSigningOut}
            accessibilityLabel={t("mobile.settings.deleteAccountLabel")}
            style={({ pressed }) => [
              styles.deleteAccountLink,
              pressed && styles.deleteAccountLinkPressed,
            ]}
          >
            <Text style={styles.deleteAccountLinkText}>
              {isDeletingAccount
                ? t("mobile.settings.deletingAccount")
                : t("mobile.settings.deleteAccount")}
            </Text>
          </Pressable>
        </>
      ) : null}
    </ScrollView>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: {
      flex: 1,
    },
    scrollContent: {
      paddingTop: 8,
      paddingBottom: 32,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.display.regular,
      fontSize: 28,
      letterSpacing: -1.2,
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
    identityBlock: {
      gap: 2,
      marginTop: 10,
    },
    identityName: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 17,
      letterSpacing: -0.3,
    },
    identityEmailRow: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      marginTop: 1,
    },
    identityEmailRowPrimary: {
      marginTop: 0,
    },
    identityEmail: {
      color: colors.textMuted,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      letterSpacing: -0.1,
    },
    identityEmailPrimary: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 17,
      letterSpacing: -0.3,
    },
    identityEmailToggle: {
      alignItems: "center",
      height: 28,
      justifyContent: "center",
      width: 28,
    },
    signInBlock: {
      gap: 6,
      marginTop: 14,
      marginBottom: 4,
    },
    signInTitle: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 17,
      letterSpacing: -0.3,
    },
    signInButton: {
      alignSelf: "flex-start",
      marginTop: 10,
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
    signOut: {
      alignItems: "center",
      alignSelf: "flex-start",
      borderColor: colors.border,
      borderRadius: 22,
      borderWidth: StyleSheet.hairlineWidth,
      marginTop: 8,
      paddingHorizontal: 24,
      paddingVertical: 12,
    },
    signOutPressed: {
      opacity: 0.8,
    },
    signOutDisabled: {
      opacity: 0.5,
    },
    signOutText: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.3,
    },
    deleteAccountLink: {
      alignSelf: "flex-start",
      marginTop: 20,
      paddingVertical: 8,
    },
    deleteAccountLinkPressed: {
      opacity: 0.6,
    },
    deleteAccountLinkText: {
      color: colors.danger,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      letterSpacing: -0.1,
      textDecorationLine: "underline",
    },
  } as const);
