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
import { authClient } from "../../src/lib/auth-client";
import { clearCachedToken } from "../../src/lib/auth-token";
import { clearCachedDesktopBridge } from "../../src/lib/desktop-bridge-chat";
import { isGuest } from "../../src/lib/guest-mode";
import { userFacingError } from "../../src/lib/user-facing-error";
import { tapLight } from "../../src/lib/haptics";
import {
  clearStoredPhoneAccess,
  getDesktopBridgeStatus,
  listStoredPairedPhoneAccess,
  type StoredPhoneAccess,
} from "../../src/lib/phone-access";
import {
  getNotificationsMuted,
  setNotificationsMuted,
  subscribeNotificationsMuted,
} from "../../src/lib/notifications-prefs";
import { unregisterForPushNotifications } from "../../src/lib/notifications";
import { type Colors } from "../../src/theme/colors";
import {
  useColors,
  useTheme,
  type GradientMode,
  type ThemePreference,
} from "../../src/theme/theme-context";
import { fonts } from "../../src/theme/fonts";

const APPEARANCE_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

const GRADIENT_OPTIONS: { value: GradientMode; label: string }[] = [
  { value: "soft", label: "Soft" },
  { value: "flat", label: "Flat" },
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
  access: StoredPhoneAccess,
  platform: string | null | undefined,
): string {
  const base = platform?.trim();
  if (base) return base;
  return `Computer · ${access.desktopDeviceId.slice(0, 4).toUpperCase()}`;
}

export default function AccountScreen() {
  const colors = useColors();
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
  // Pearl/Noir force flat — disable the Soft option so the toggle reflects
  // the actual rendered surface instead of misleading the user.
  const gradientLocked = Boolean(activeTheme.forcedMode);
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const session = authClient.useSession();
  const guest = isGuest();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [pairedDesktops, setPairedDesktops] = useState<StoredPhoneAccess[]>([]);
  const [desktopPlatforms, setDesktopPlatforms] = useState<
    Record<string, string | null>
  >({});
  const [removingDesktopId, setRemovingDesktopId] = useState<string | null>(
    null,
  );
  const [notificationsMuted, setMutedLocal] = useState(() =>
    getNotificationsMuted(),
  );
  const [emailRevealed, setEmailRevealed] = useState(false);

  useEffect(() => subscribeNotificationsMuted(setMutedLocal), []);

  const user = session.data?.user;
  const email = user?.email ?? "";
  const userName = user?.name?.trim() ?? "";

  useEffect(() => {
    setEmailRevealed(false);
  }, [email]);
  // The whole "you have an account" surface — name/email header, upgrade card,
  // paired computers, sign-out, delete — only makes sense when the user has a
  // real session. Settings, appearance, notifications, and legal all work
  // without one, so we render the page either way and just hide the bits
  // that need an identity.
  const isSignedIn = Boolean(user) && !guest;
  const showLoadingHeader = !guest && session.isPending && !user;

  const refreshPaired = useCallback(async () => {
    const next = await listStoredPairedPhoneAccess();
    setPairedDesktops(next);
  }, []);

  useEffect(() => {
    void refreshPaired();
  }, [refreshPaired]);

  useEffect(() => {
    let cancelled = false;
    const missing = pairedDesktops.filter(
      (access) => !(access.desktopDeviceId in desktopPlatforms),
    );
    if (missing.length === 0) return;
    void Promise.all(
      missing.map(async (access) => {
        try {
          const status = await getDesktopBridgeStatus(access.desktopDeviceId);
          return [access.desktopDeviceId, status.platform ?? null] as const;
        } catch {
          return [access.desktopDeviceId, null] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setDesktopPlatforms((prev) => {
        const next = { ...prev };
        for (const [id, platform] of entries) {
          next[id] = platform;
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [desktopPlatforms, pairedDesktops]);

  const signOut = async () => {
    setIsSigningOut(true);
    try {
      await unregisterForPushNotifications();
      await authClient.signOut();
      clearCachedToken();
      clearCachedDesktopBridge();
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
    } catch (e) {
      Alert.alert("Could not delete account", userFacingError(e));
    } finally {
      setIsDeletingAccount(false);
    }
  };

  const confirmDeleteAccount = () => {
    Alert.alert(
      "Delete account",
      "This permanently deletes your Stella account and removes cloud data associated with it on our servers. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => void runDeleteAccount(),
        },
      ],
    );
  };

  const confirmForgetDesktop = (access: StoredPhoneAccess) => {
    const label = platformLabelFor(
      access,
      desktopPlatforms[access.desktopDeviceId],
    );
    Alert.alert(
      `Forget ${label}?`,
      "This phone will stop reconnecting to that computer until you pair it again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Forget",
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
      <Text style={styles.title}>Settings</Text>

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
                    emailRevealed ? "Hide email" : "Show email"
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
        <Text style={styles.body}>Loading session…</Text>
      ) : (
        <View style={styles.signInBlock}>
          <Text style={styles.signInTitle}>Sign in to Stella</Text>
          <Pressable
            onPress={() => router.replace("/login")}
            accessibilityLabel="Sign in to Stella"
            style={({ pressed }) => [
              styles.signInButton,
              pressed && styles.signInButtonPressed,
            ]}
          >
            <Text style={styles.signInButtonText}>Sign in</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.separator} />

      <Text style={styles.sectionLabel}>Appearance</Text>
      <View style={styles.themeRow}>
        {APPEARANCE_OPTIONS.map((opt) => (
          <Pressable
            key={opt.value}
            onPress={() => {
              tapLight();
              setPreference(opt.value);
            }}
            accessibilityLabel={`Use ${opt.label} appearance`}
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
              {opt.label}
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
              accessibilityLabel={`Use ${opt.label} background`}
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
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.themeDots}>
        {themes.map((th) => {
          // Honor pinned-mode themes (Pearl/Noir) when previewing — otherwise
          // the swatch shows a palette the user can never actually land on.
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
              accessibilityLabel={`Use ${th.name} theme`}
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

      <Text style={styles.sectionLabel}>Notifications</Text>
      <View style={styles.toggleRow}>
        <View style={styles.toggleCopy}>
          <Text style={styles.toggleLabel}>Allow push notifications</Text>
          <Text style={styles.toggleSub}>
            Get notified when your computer finishes a request.
          </Text>
        </View>
        <GlassToggle
          value={!notificationsMuted}
          onValueChange={toggleNotifications}
          accessibilityLabel="Toggle push notifications"
        />
      </View>

      {isSignedIn ? (
        <>
          <View style={styles.separator} />

          <Text style={styles.sectionLabel}>Paired computers</Text>
          {pairedDesktops.length === 0 ? (
            <Text style={styles.emptyHint}>
              No computers paired yet. Pair from the Computer tab.
            </Text>
          ) : (
            <View style={styles.pairedList}>
              {pairedDesktops.map((access) => {
                const label = platformLabelFor(
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
                        Paired{" "}
                        {new Date(access.approvedAt).toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => confirmForgetDesktop(access)}
                      disabled={removing}
                      accessibilityLabel={`Forget ${label}`}
                      style={({ pressed }) => [
                        styles.forgetButton,
                        pressed && styles.forgetButtonPressed,
                        removing && styles.forgetButtonDisabled,
                      ]}
                    >
                      <Text style={styles.forgetText}>
                        {removing ? "\u2026" : "Forget"}
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
          accessibilityLabel="Open CarPlay diagnostics"
          style={({ pressed }) => [
            styles.legalRow,
            pressed && styles.legalRowPressed,
          ]}
        >
          <Text style={styles.legalLabel}>CarPlay diagnostics</Text>
          <Text style={styles.legalChevron}>›</Text>
        </Pressable>
        <Pressable
          onPress={() => void Linking.openURL("https://stella.sh/terms")}
          accessibilityLabel="Open Terms of Service"
          style={({ pressed }) => [
            styles.legalRow,
            pressed && styles.legalRowPressed,
          ]}
        >
          <Text style={styles.legalLabel}>Terms of Service</Text>
          <Text style={styles.legalChevron}>›</Text>
        </Pressable>
        <Pressable
          onPress={() => void Linking.openURL("https://stella.sh/privacy")}
          accessibilityLabel="Open Privacy Policy"
          style={({ pressed }) => [
            styles.legalRow,
            pressed && styles.legalRowPressed,
          ]}
        >
          <Text style={styles.legalLabel}>Privacy Policy</Text>
          <Text style={styles.legalChevron}>›</Text>
        </Pressable>
      </View>

      {isSignedIn ? (
        <>
          <Pressable
            onPress={() => void signOut()}
            disabled={isSigningOut || isDeletingAccount}
            accessibilityLabel="Sign out of Stella"
            style={({ pressed }) => [
              styles.signOut,
              pressed && styles.signOutPressed,
              (isSigningOut || isDeletingAccount) && styles.signOutDisabled,
            ]}
          >
            <Text style={styles.signOutText}>
              {isSigningOut ? "Signing out\u2026" : "Sign out"}
            </Text>
          </Pressable>

          <Pressable
            onPress={confirmDeleteAccount}
            disabled={isDeletingAccount || isSigningOut}
            accessibilityLabel="Delete your Stella account"
            style={({ pressed }) => [
              styles.deleteAccountLink,
              pressed && styles.deleteAccountLinkPressed,
            ]}
          >
            <Text style={styles.deleteAccountLinkText}>
              {isDeletingAccount ? "Deleting account\u2026" : "Delete account"}
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
      alignItems: "center",
      alignSelf: "flex-start",
      backgroundColor: colors.accent,
      borderRadius: 22,
      marginTop: 10,
      paddingHorizontal: 24,
      paddingVertical: 11,
    },
    signInButtonPressed: {
      backgroundColor: colors.accentHover,
    },
    signInButtonText: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.semiBold,
      fontSize: 15,
      letterSpacing: -0.3,
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
