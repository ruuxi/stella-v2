import { useEffect, useMemo, useState } from "react";
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
import { GlassToggle } from "./glass";
import { Icon, type IconName } from "./Icon";
import { PrimaryButton } from "./PrimaryButton";
import { SubscriptionSection } from "./SubscriptionSection";
import {
  makeSettingsStyles,
  type SettingsStyles,
} from "./settings/settings-styles";
import { env } from "../config/env";
import { authClient } from "../lib/auth-client";
import { clearAiConsent } from "../lib/ai-consent";
import { clearCachedToken } from "../lib/auth-token";
import { clearAccountChatData } from "../lib/chat-account-cleanup";
import { isGuest } from "../lib/guest-mode";
import { useCloudBrowserActions } from "../lib/cloud-browser";
import { tapLight } from "../lib/haptics";
import { unregisterForPushNotifications } from "../lib/notifications";
import {
  getNotificationsMuted,
  setNotificationsMuted,
  subscribeNotificationsMuted,
} from "../lib/notifications-prefs";
import {
  getVoiceEnabled,
  setVoiceEnabled,
  subscribeVoiceEnabled,
} from "../lib/voice-visibility";
import {
  clearStoredPhoneAccess,
  listStoredPairedPhoneAccess,
  type StoredPhoneAccess,
} from "../lib/phone-access";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { userFacingError } from "../lib/user-facing-error";
import { type Colors } from "../theme/colors";
import {
  useColors,
  useTheme,
  type GradientColor,
  type GradientMode,
  type ThemePreference,
} from "../theme/theme-context";
import { resolveThemeColors } from "@stella/theme";
import { fonts } from "../theme/fonts";
import { useT } from "../i18n";
import { SegmentedControl } from "./SegmentedControl";

const APPEARANCE_OPTIONS: { value: ThemePreference; labelKey: string }[] = [
  { value: "system", labelKey: "mobile.settings.appearance.system" },
  { value: "light", labelKey: "mobile.settings.appearance.light" },
  { value: "dark", labelKey: "mobile.settings.appearance.dark" },
];

const GRADIENT_OPTIONS: { value: GradientMode; labelKey: string }[] = [
  { value: "soft", labelKey: "mobile.settings.background.soft" },
  { value: "flat", labelKey: "mobile.settings.background.flat" },
];

// Mirrors desktop's "Gradient Color" control (ThemePicker.tsx).
const GRADIENT_COLOR_OPTIONS: { value: GradientColor; labelKey: string }[] = [
  { value: "relative", labelKey: "mobile.settings.backgroundColor.relative" },
  { value: "strong", labelKey: "mobile.settings.backgroundColor.strong" },
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

/**
 * The Settings tab: everything about the account and the app on one page,
 * top to bottom from who you are to the fine print — Account (identity and
 * plan), Computer (status, where turns run, pairing), Cloud, Appearance,
 * Notifications, About, then sign-out and deletion. The Computer section's
 * live state is the chat's, published through the shell store.
 */
export function SettingsContent() {
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
    gradientColor,
    setGradientColor,
  } = useTheme();
  // Flat themes (Default) paint no blob — disable the Soft option so the
  // toggle reflects the actual rendered surface instead of misleading the user.
  const gradientLocked = flat;
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const settingsStyles = useMemo(() => makeSettingsStyles(colors), [colors]);
  const router = useRouter();
  const bottomInset = useSafeAreaInsets().bottom;
  const session = authClient.useSession();
  const guest = isGuest();
  const [isResettingCloudBrowser, setIsResettingCloudBrowser] = useState(false);
  const { resetProfile: resetCloudBrowserProfile } = useCloudBrowserActions();
  const [notificationsMuted, setMutedLocal] = useState(() =>
    getNotificationsMuted(),
  );
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [emailRevealed, setEmailRevealed] = useState(false);

  useEffect(() => subscribeNotificationsMuted(setMutedLocal), []);
  const [voiceEnabled, setVoiceEnabledLocal] = useState(() =>
    getVoiceEnabled(),
  );
  useEffect(() => subscribeVoiceEnabled(setVoiceEnabledLocal), []);

  const user = session.data?.user;
  const email = user?.email ?? "";
  const userName = user?.name?.trim() ?? "";

  useEffect(() => {
    setEmailRevealed(false);
  }, [email]);

  // Appearance, notifications, and legal work without a session; everything
  // that needs an identity (plan, computers, cloud, sign-out) hides.
  const isSignedIn = Boolean(user) && !guest;
  const showLoadingHeader = !guest && session.isPending && !user;

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

  // Local state carries the departing account's data — chat transcripts in
  // AsyncStorage and desktop pairing secrets in SecureStore. Wipe it so the
  // next sign-in on this device can't inherit (or re-send as chat history)
  // the previous user's messages or reconnect with their computers.
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
  };

  const signOut = async () => {
    setIsSigningOut(true);
    try {
      await unregisterForPushNotifications();
      await authClient.signOut();
      clearCachedToken();
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

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.scrollContent,
        { paddingBottom: 32 + bottomInset },
      ]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {/* Same key as the sidebar's destination, so the two can't drift. */}
      <Text style={styles.title} accessibilityRole="header">
        {t("mobile.nav.account")}
      </Text>

      {/* Account: who you are and what you pay for. The page title already
          says Account, so this first group needs no label of its own. */}
      <View style={settingsStyles.section}>
        <View style={settingsStyles.group}>
          {isSignedIn ? (
            <View style={settingsStyles.row}>
              <Icon
                name="user"
                size={26}
                color={colors.textMuted}
                style={styles.avatar}
              />
              <View style={settingsStyles.rowCopy}>
                {userName ? (
                  <Text style={styles.identityName} numberOfLines={1}>
                    {userName}
                  </Text>
                ) : null}
                {email ? (
                  <Text
                    style={userName ? settingsStyles.rowSub : styles.identityName}
                    numberOfLines={1}
                  >
                    {emailRevealed ? email : maskEmail(email)}
                  </Text>
                ) : null}
              </View>
              {email ? (
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
                  style={styles.emailToggle}
                >
                  <Icon
                    name={emailRevealed ? "eye-off" : "eye"}
                    size={18}
                    color={colors.textMuted}
                  />
                </Pressable>
              ) : null}
            </View>
          ) : showLoadingHeader ? (
            <Text style={settingsStyles.hint}>
              {t("mobile.settings.loadingSession")}
            </Text>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("mobile.settings.signInTitle")}
              onPress={() => {
                tapLight();
                router.replace("/login");
              }}
              style={({ pressed }) => [
                settingsStyles.row,
                pressed && settingsStyles.rowPressed,
              ]}
            >
              <Icon
                name="user"
                size={18}
                color={colors.accent}
                style={settingsStyles.rowIcon}
              />
              {/* The page's main action while signed out, so it takes the
                  accent like the subscribe button. */}
              <Text
                style={[
                  settingsStyles.rowLabel,
                  styles.flex,
                  { color: colors.accent },
                ]}
              >
                {t("mobile.settings.signIn")}
              </Text>
              <Icon name="chevron-right" size={16} color={colors.textMuted} />
            </Pressable>
          )}
        </View>
      </View>

      {isSignedIn ? (
        <View style={settingsStyles.section}>
          <SubscriptionSection />
        </View>
      ) : null}

      {isSignedIn ? (
        <View style={settingsStyles.section}>
          <Text style={settingsStyles.sectionLabel}>
            {t("mobile.cloudHome.settingsSection")}
          </Text>
          <View style={settingsStyles.group}>
            <LinkRow
              icon="file-text"
              label={t("mobile.cloudHome.settingsRowTitle")}
              sub={t("mobile.cloudHome.settingsRowBody")}
              accessibilityLabel={t("mobile.cloudHome.openSettingsLabel")}
              styles={settingsStyles}
              colors={colors}
              onPress={() => router.push("/cloud-home")}
            />
            {/* Claude & ChatGPT now live in the chat's settings sheet, next
                to the model that runs on them. */}
            <View style={[settingsStyles.row, settingsStyles.rowDivider]}>
              <Icon
                name="globe"
                size={18}
                color={colors.textMuted}
                style={settingsStyles.rowIcon}
              />
              <View style={settingsStyles.rowCopy}>
                <Text style={settingsStyles.rowLabel}>
                  {t("cloudBrowser.settings.defaultProfile")}
                </Text>
                <Text style={settingsStyles.rowSub}>
                  {t("cloudBrowser.settings.description")}
                </Text>
              </View>
              <Pressable
                onPress={confirmResetCloudBrowser}
                disabled={isResettingCloudBrowser}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t("cloudBrowser.settings.reset")}
                style={({ pressed }) => [
                  (pressed || isResettingCloudBrowser) && styles.dimmed,
                ]}
              >
                <Text style={settingsStyles.rowDanger}>
                  {isResettingCloudBrowser
                    ? t("cloudBrowser.settings.resetting")
                    : t("cloudBrowser.settings.reset")}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      <View style={settingsStyles.section}>
        <View style={styles.appearanceHeader}>
          <Text style={[settingsStyles.sectionLabel, styles.appearanceLabel]}>
            {t("mobile.settings.appearanceSection")}
          </Text>
          <View style={styles.modeControl}>
            <SegmentedControl<ThemePreference>
              accessibilityLabel="Mode"
              value={preference}
              onChange={(next) => {
                tapLight();
                setPreference(next);
              }}
              options={APPEARANCE_OPTIONS.map((opt) => ({
                value: opt.value,
                label: t(opt.labelKey),
              }))}
            />
          </View>
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

        {/* Secondary surface options, below the themes they tint. */}
        <View style={styles.surfaceControls}>
          <View style={styles.surfaceControl}>
            <SegmentedControl<GradientMode>
              accessibilityLabel="Background"
              disabled={gradientLocked}
              value={gradientLocked ? "flat" : gradientPreference}
              onChange={(next) => {
                tapLight();
                setGradientPreference(next);
              }}
              options={GRADIENT_OPTIONS.map((opt) => ({
                value: opt.value,
                label: t(opt.labelKey),
              }))}
            />
          </View>
          <View style={styles.surfaceControl}>
            <SegmentedControl<GradientColor>
              accessibilityLabel="Background color"
              disabled={gradientLocked}
              value={gradientColor}
              onChange={(next) => {
                tapLight();
                setGradientColor(next);
              }}
              options={GRADIENT_COLOR_OPTIONS.map((opt) => ({
                value: opt.value,
                label: t(opt.labelKey),
              }))}
            />
          </View>
        </View>
      </View>

      <View style={settingsStyles.section}>
        <Text style={settingsStyles.sectionLabel}>
          {t("mobile.settings.notificationsSection")}
        </Text>
        <View style={settingsStyles.group}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowCopy}>
              <Text style={settingsStyles.rowLabel}>
                {t("mobile.settings.pushToggleLabel")}
              </Text>
              <Text style={settingsStyles.rowSub}>
                {t("mobile.settings.pushToggleSub")}
              </Text>
            </View>
            <GlassToggle
              value={!notificationsMuted}
              onValueChange={toggleNotifications}
              accessibilityLabel={t("mobile.settings.pushToggleA11y")}
            />
          </View>
        </View>
      </View>

      <View style={settingsStyles.section}>
        <Text style={settingsStyles.sectionLabel}>
          {t("mobile.settings.voiceSection")}
        </Text>
        <View style={settingsStyles.group}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowCopy}>
              <Text style={settingsStyles.rowLabel}>
                {t("settings.voiceAgent.title")}
              </Text>
              <Text style={settingsStyles.rowSub}>
                {t("settings.voiceAgent.description")}
              </Text>
            </View>
            <GlassToggle
              value={voiceEnabled}
              onValueChange={(next) => void setVoiceEnabled(next)}
              accessibilityLabel={t("settings.voiceAgent.title")}
            />
          </View>
        </View>
      </View>

      <View style={settingsStyles.section}>
        <Text style={settingsStyles.sectionLabel}>
          {t("mobile.settings.aboutSection")}
        </Text>
        <View style={settingsStyles.group}>
          <LinkRow
            label={t("mobile.settings.termsOfService")}
            accessibilityLabel={t("mobile.settings.openTermsLabel")}
            styles={settingsStyles}
            colors={colors}
            onPress={() => void Linking.openURL(`${env.siteUrl}/terms`)}
          />
          <LinkRow
            label={t("mobile.settings.privacyPolicy")}
            accessibilityLabel={t("mobile.settings.openPrivacyLabel")}
            divided
            styles={settingsStyles}
            colors={colors}
            onPress={() => void Linking.openURL(`${env.siteUrl}/privacy`)}
          />
          <LinkRow
            label={t("mobile.settings.carPlayDiagnostics")}
            accessibilityLabel={t(
              "mobile.settings.openCarPlayDiagnosticsLabel",
            )}
            divided
            styles={settingsStyles}
            colors={colors}
            onPress={() => router.push("/carplay-diagnostics")}
          />
        </View>
      </View>

      {isSignedIn ? (
        <View style={settingsStyles.section}>
          <View style={settingsStyles.group}>
            <Pressable
              onPress={() => void signOut()}
              disabled={isSigningOut || isDeletingAccount}
              accessibilityRole="button"
              accessibilityLabel={t("mobile.settings.signOutLabel")}
              style={({ pressed }) => [
                settingsStyles.row,
                pressed && settingsStyles.rowPressed,
                (isSigningOut || isDeletingAccount) &&
                  settingsStyles.rowDisabled,
              ]}
            >
              <Text style={[settingsStyles.rowLabel, styles.centered]}>
                {isSigningOut
                  ? t("mobile.settings.signingOut")
                  : t("mobile.settings.signOut")}
              </Text>
            </Pressable>
          </View>

          <Pressable
            onPress={confirmDeleteAccount}
            disabled={isDeletingAccount || isSigningOut}
            accessibilityRole="button"
            accessibilityLabel={t("mobile.settings.deleteAccountLabel")}
            style={({ pressed }) => [
              styles.deleteAccountLink,
              pressed && styles.dimmed,
            ]}
          >
            <Text style={styles.deleteAccountLinkText}>
              {isDeletingAccount
                ? t("mobile.settings.deletingAccount")
                : t("mobile.settings.deleteAccount")}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
  );
}

function LinkRow({
  icon,
  label,
  sub,
  accessibilityLabel,
  divided = false,
  styles,
  colors,
  onPress,
}: {
  icon?: IconName;
  label: string;
  sub?: string;
  accessibilityLabel: string;
  divided?: boolean;
  styles: SettingsStyles;
  colors: Colors;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [
        styles.row,
        divided && styles.rowDivider,
        pressed && styles.rowPressed,
      ]}
    >
      {icon ? (
        <Icon
          name={icon}
          size={18}
          color={colors.textMuted}
          style={styles.rowIcon}
        />
      ) : null}
      <View style={styles.rowCopy}>
        <Text style={styles.rowLabel}>{label}</Text>
        {sub ? <Text style={styles.rowSub}>{sub}</Text> : null}
      </View>
      <Icon name="chevron-right" size={15} color={colors.textMuted} />
    </Pressable>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: {
      flex: 1,
    },
    scrollContent: {
      paddingTop: 0,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.display.regular,
      fontSize: 32,
      letterSpacing: -1.2,
      marginTop: 4,
    },
    avatar: {
      width: 30,
    },
    identityName: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 16,
      letterSpacing: -0.3,
    },
    emailToggle: {
      alignItems: "center",
      height: 28,
      justifyContent: "center",
      width: 28,
    },
    dimmed: {
      opacity: 0.6,
    },
    centered: {
      flex: 1,
      textAlign: "center",
    },
    appearanceHeader: {
      alignItems: "center",
      flexDirection: "row",
      gap: 12,
      marginBottom: 14,
    },
    // The label shares the row with the mode switch, so it drops its own
    // bottom gap and centres against the control.
    appearanceLabel: { flex: 1, marginBottom: 0 },
    modeControl: { width: 220 },
    surfaceControls: { flexDirection: "row", gap: 10, marginTop: 26 },
    surfaceControl: { flex: 1 },
    flex: { flex: 1 },
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
    deleteAccountLink: {
      alignSelf: "center",
      marginTop: 16,
      paddingVertical: 8,
    },
    deleteAccountLinkText: {
      color: colors.danger,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      letterSpacing: -0.1,
    },
  } as const);
