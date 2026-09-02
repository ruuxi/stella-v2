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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../../src/components/Icon";
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
import { unregisterForPushNotifications } from "../../src/lib/notifications";
import { type Colors } from "../../src/theme/colors";
import { useColors } from "../../src/theme/theme-context";
import { fonts } from "../../src/theme/fonts";
import { useT } from "../../src/i18n";

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
 * Who you are, what you pay for, and the legal text — everything about the
 * account rather than the app. Reached from the sidebar's Account button;
 * Settings keeps appearance, notifications, and paired computers.
 */
export default function AccountScreen() {
  const colors = useColors();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const session = authClient.useSession();
  const guest = isGuest();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [emailRevealed, setEmailRevealed] = useState(false);

  const user = session.data?.user;
  const email = user?.email ?? "";
  const userName = user?.name?.trim() ?? "";

  useEffect(() => {
    setEmailRevealed(false);
  }, [email]);

  const isSignedIn = Boolean(user) && !guest;
  const showLoadingHeader = !guest && session.isPending && !user;

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

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.scrollContent,
        { paddingBottom: 32 + insets.bottom },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>{t("mobile.account.title")}</Text>

      {isSignedIn ? (
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

      <View style={styles.legalBlock}>
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
