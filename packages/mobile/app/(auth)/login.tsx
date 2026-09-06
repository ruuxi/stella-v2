import { useState, useEffect, useMemo, useRef } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as SecureStore from "expo-secure-store";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Crypto from "expo-crypto";
import { useRouter } from "expo-router";
import Svg, { Path } from "react-native-svg";
import {
  authClient,
  MOBILE_SESSION_TOKEN_KEY,
} from "../../src/lib/auth-client";
import {
  claimSessionToken,
  generateClaimSecret,
  hashClaimSecret,
} from "../../src/lib/claim-secret";
import { env } from "../../src/config/env";
import { userFacingError } from "../../src/lib/user-facing-error";
import { setGuestMode } from "../../src/lib/guest-mode";
import { type Colors } from "../../src/theme/colors";
import { useColors, useTheme } from "../../src/theme/theme-context";
import { fadeHex } from "../../src/theme/oklch";
import { fonts } from "../../src/theme/fonts";
import {
  LEGAL_TITLES,
  TERMS_OF_SERVICE,
  PRIVACY_POLICY,
} from "../../src/lib/legal-text";
import { loadLastMainTabHref } from "../../src/lib/last-main-tab";
import { useT } from "../../src/i18n";
import { signInMobileAnonymous } from "../../src/lib/anonymous-sign-in";
import { buildMagicLinkHeaders } from "../../src/lib/auth-integrity-headers";
import {
  isIntegrityKeyUnknown,
  requestWithAppIntegrity,
} from "../../src/lib/app-integrity";

type LegalDoc = "terms" | "privacy" | null;

const POLL_INTERVAL_MS = 2500;
const RESEND_GRACE_MS = 15_000;

type SubmitState =
  | { type: "idle" }
  | { type: "sending" }
  | { type: "google" }
  | { type: "apple" }
  | { type: "sent"; requestId: string }
  | { type: "verifying" }
  | { type: "error"; message: string };

type SocialSignInResult = {
  error?: {
    message?: string;
    statusText?: string;
  } | null;
};

type MagicLinkSendResult = {
  response: Response;
  body: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readMagicLinkSendBody = (value: unknown) => {
  if (!isRecord(value)) {
    return { requestId: null, error: null };
  }
  return {
    requestId:
      typeof value.requestId === "string" && value.requestId.trim()
        ? value.requestId.trim()
        : null,
    error:
      typeof value.error === "string" && value.error.trim()
        ? value.error.trim()
        : null,
  };
};

export default function LoginScreen() {
  const colors = useColors();
  const t = useT();
  const { isDark } = useTheme();
  const router = useRouter();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [email, setEmail] = useState("");
  const [submitState, setSubmitState] = useState<SubmitState>({ type: "idle" });
  const [activeLegal, setActiveLegal] = useState<LegalDoc>(null);
  // Claim secret for the in-flight handoff. A ref so it never re-renders and
  // is never persisted.
  const claimSecretRef = useRef<string | null>(null);
  const [canResend, setCanResend] = useState(false);

  const continueAsGuest = async () => {
    setSubmitState({ type: "verifying" });
    try {
      const result = await signInMobileAnonymous();
      if (result.error) {
        throw new Error(
          result.error.message ?? "Could not start an anonymous session.",
        );
      }

      await setGuestMode(result.data?.user.isAnonymous === true);
      router.replace(await loadLastMainTabHref());
    } catch (error) {
      setSubmitState({ type: "error", message: userFacingError(error) });
    }
  };

  const sendMagicLink = async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      setSubmitState({
        type: "error",
        message: t("mobile.login.enterEmail"),
      });
      return;
    }

    setSubmitState({ type: "sending" });

    try {
      // In memory for this attempt only; the server stores just the hash.
      const claimSecret = generateClaimSecret();
      claimSecretRef.current = claimSecret;
      const claimHash = await hashClaimSecret(claimSecret);
      const { response, body } =
        await requestWithAppIntegrity<MagicLinkSendResult>({
          purpose: "magic-link",
          request: async (proof) => {
            const response = await fetch(
              `${env.convexSiteUrl}/api/auth/link/send`,
              {
                method: "POST",
                headers: buildMagicLinkHeaders(proof),
                body: JSON.stringify({ email: trimmed, claimHash }),
              },
            );
            return {
              response,
              body: await response.json().catch(() => null),
            };
          },
          isIntegrityKeyUnknown: (result) =>
            isIntegrityKeyUnknown(result.body),
        });
      const result = readMagicLinkSendBody(body);
      if (!response.ok || !result.requestId) {
        throw new Error(result.error || t("mobile.login.sendFailed"));
      }
      setSubmitState({ type: "sent", requestId: result.requestId });
    } catch (error) {
      setSubmitState({ type: "error", message: userFacingError(error) });
    }
  };

  const signInWithGoogle = async () => {
    setSubmitState({ type: "google" });

    try {
      const result = (await authClient.signIn.social({
        provider: "google",
        callbackURL: "/chat",
      })) as SocialSignInResult | undefined;

      if (result?.error) {
        setSubmitState({
          type: "error",
          message:
            result.error.message ||
            result.error.statusText ||
            t("mobile.login.googleStartFailed"),
        });
        return;
      }

      router.replace(await loadLastMainTabHref());
    } catch (error) {
      setSubmitState({ type: "error", message: userFacingError(error) });
    }
  };

  const signInWithApple = async () => {
    setSubmitState({ type: "apple" });

    try {
      if (Platform.OS === "ios") {
        // Apple echoes whatever string is passed as `nonce` into the
        // identity token's `nonce` claim. better-auth verifies it with a
        // literal string compare, so we must pass the SAME value to both
        // sides. We use the SHA-256 hash of a random UUID so the raw value
        // never traverses Apple's servers in the JWT.
        const rawNonce = Crypto.randomUUID();
        const hashedNonce = await Crypto.digestStringAsync(
          Crypto.CryptoDigestAlgorithm.SHA256,
          rawNonce,
        );

        const credential = await AppleAuthentication.signInAsync({
          requestedScopes: [
            AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
            AppleAuthentication.AppleAuthenticationScope.EMAIL,
          ],
          nonce: hashedNonce,
        });

        if (!credential.identityToken) {
          setSubmitState({
            type: "error",
            message: t("mobile.login.appleNoToken"),
          });
          return;
        }

        const result = (await authClient.signIn.social({
          provider: "apple",
          idToken: {
            token: credential.identityToken,
            nonce: hashedNonce,
          },
        })) as SocialSignInResult | undefined;

        if (result?.error) {
          setSubmitState({
            type: "error",
            message:
              result.error.message ||
              result.error.statusText ||
              t("mobile.login.appleCompleteFailed"),
          });
          return;
        }

        router.replace(await loadLastMainTabHref());
        return;
      }

      const result = (await authClient.signIn.social({
        provider: "apple",
        callbackURL: "/chat",
      })) as SocialSignInResult | undefined;

      if (result?.error) {
        setSubmitState({
          type: "error",
          message:
            result.error.message ||
            result.error.statusText ||
            t("mobile.login.appleStartFailed"),
        });
        return;
      }

      router.replace(await loadLastMainTabHref());
    } catch (error) {
      // User cancels surface as ERR_REQUEST_CANCELED — return silently.
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error as { code?: string }).code === "ERR_REQUEST_CANCELED"
      ) {
        setSubmitState({ type: "idle" });
        return;
      }
      setSubmitState({ type: "error", message: userFacingError(error) });
    }
  };

  // Enable "resend" after a short grace once the link is sent.
  useEffect(() => {
    if (submitState.type !== "sent") {
      setCanResend(false);
      return;
    }
    setCanResend(false);
    const id = setTimeout(() => setCanResend(true), RESEND_GRACE_MS);
    return () => clearTimeout(id);
  }, [submitState]);

  const editEmail = () => {
    // Leaving "sent" cancels the poll via the polling effect's cleanup.
    setSubmitState({ type: "idle" });
  };

  // Poll for magic link verification.
  useEffect(() => {
    if (submitState.type !== "sent") return;
    const { requestId } = submitState;
    // Scoped per effect run so a resend's new poll can't revive this one.
    let cancelled = false;

    const poll = async () => {
      while (!cancelled) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (cancelled) return;

        try {
          const res = await fetch(
            `${env.convexSiteUrl}/api/auth/link/status?requestId=${encodeURIComponent(requestId)}`,
          );
          if (!res.ok) continue;
          const data = (await res.json()) as { status: string };

          if (data.status === "completed") {
            if (cancelled) return;
            setSubmitState({ type: "verifying" });
            try {
              // /link/status carries no credential. Exchange the secret this
              // device generated, which is the only thing that can claim it.
              const secret = claimSecretRef.current;
              const token = secret
                ? await claimSessionToken(env.convexSiteUrl, requestId, secret)
                : null;
              if (!token) {
                throw new Error("Handoff could not be claimed.");
              }
              // The native bearer client attaches this token to every request.
              await SecureStore.setItemAsync(MOBILE_SESSION_TOKEN_KEY, token);
              claimSecretRef.current = null;
              // Nudge useSession() to re-fetch now that a credential exists.
              // The native bearer client's init hook attaches it to the
              // request, and the server returns valid session data.
              const store = (
                authClient as unknown as {
                  $store?: { notify: (s: string) => void };
                }
              ).$store;
              store?.notify("$sessionSignal");
            } catch {
              setSubmitState({
                type: "error",
                message: t("mobile.login.finishFailed"),
              });
            }
            return;
          }

          if (data.status === "expired") {
            if (cancelled) return;
            setSubmitState({
              type: "error",
              message: t("mobile.login.linkExpired"),
            });
            return;
          }
        } catch {
          // Retry silently on network errors.
        }
      }
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, [submitState, t]);

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style={isDark ? "light" : "dark"} />
      <KeyboardAvoidingView
        style={styles.keyboardAvoid}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={styles.hero} onPress={Keyboard.dismiss}>
          <Text style={styles.title} maxFontSizeMultiplier={1.2}>
            {t("mobile.login.heroTitle")}
          </Text>
          <Text style={styles.body}>{t("mobile.login.heroBody")}</Text>
        </Pressable>

        <View style={styles.formArea}>
          {Platform.OS === "ios" ? (
            <Pressable
              onPress={() => {
                void signInWithApple();
              }}
              disabled={
                submitState.type === "apple" ||
                submitState.type === "google" ||
                submitState.type === "sending" ||
                submitState.type === "verifying"
              }
              accessibilityLabel={t("mobile.login.continueWithApple")}
              style={({ pressed }) => [
                styles.socialButton,
                styles.appleButton,
                pressed ? styles.socialButtonPressed : null,
                submitState.type === "apple"
                  ? styles.primaryButtonDisabled
                  : null,
              ]}
            >
              <AppleIcon />
              <Text style={styles.appleButtonText}>
                {submitState.type === "apple"
                  ? t("mobile.login.openingApple")
                  : t("mobile.login.continueWithApple")}
              </Text>
            </Pressable>
          ) : null}

          <Pressable
            onPress={() => {
              void signInWithGoogle();
            }}
            disabled={
              submitState.type === "apple" ||
              submitState.type === "google" ||
              submitState.type === "sending" ||
              submitState.type === "verifying"
            }
            accessibilityLabel={t("mobile.login.continueWithGoogle")}
            style={({ pressed }) => [
              styles.socialButton,
              pressed ? styles.socialButtonPressed : null,
              submitState.type === "google"
                ? styles.primaryButtonDisabled
                : null,
            ]}
          >
            <GoogleIcon />
            <Text style={styles.googleButtonText}>
              {submitState.type === "google"
                ? t("mobile.login.openingGoogle")
                : t("mobile.login.continueWithGoogle")}
            </Text>
          </Pressable>

          <View style={styles.methodDivider}>
            <View style={styles.methodDividerLine} />
            <Text style={styles.methodDividerText}>
              {t("mobile.login.orUseEmail")}
            </Text>
            <View style={styles.methodDividerLine} />
          </View>

          <TextInput
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            onChangeText={setEmail}
            placeholder={t("mobile.login.emailPlaceholder")}
            placeholderTextColor={fadeHex(colors.textMuted, 0.4)}
            style={styles.input}
            value={email}
          />

          <Pressable
            onPress={() => {
              void sendMagicLink();
            }}
            disabled={
              submitState.type === "sending" ||
              submitState.type === "sent" ||
              submitState.type === "verifying"
            }
            style={({ pressed }) => [
              styles.primaryButton,
              pressed ? styles.primaryButtonPressed : null,
              submitState.type !== "idle" && submitState.type !== "error"
                ? styles.primaryButtonDisabled
                : null,
            ]}
          >
            <Text style={styles.primaryButtonText}>
              {submitState.type === "sending"
                ? t("mobile.login.sending")
                : submitState.type === "verifying"
                  ? t("mobile.login.signingIn")
                  : t("mobile.common.continue")}
            </Text>
          </Pressable>

          {submitState.type === "sent" ? (
            <View style={styles.sentBlock}>
              <Text style={styles.successText}>
                {t("mobile.login.checkInbox")}
              </Text>
              <View style={styles.sentActions}>
                <Pressable
                  onPress={editEmail}
                  accessibilityLabel={t("mobile.login.useDifferentEmail")}
                  style={({ pressed }) => [
                    styles.inlineLink,
                    pressed && styles.inlineLinkPressed,
                  ]}
                >
                  <Text style={styles.inlineLinkText}>
                    {t("mobile.login.useDifferentEmail")}
                  </Text>
                </Pressable>
                {canResend ? (
                  <Pressable
                    onPress={() => void sendMagicLink()}
                    accessibilityLabel={t("mobile.login.resendLabel")}
                    style={({ pressed }) => [
                      styles.inlineLink,
                      pressed && styles.inlineLinkPressed,
                    ]}
                  >
                    <Text style={styles.inlineLinkText}>
                      {t("mobile.login.resend")}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ) : null}

          {submitState.type === "error" ? (
            <Text style={styles.errorText}>{submitState.message}</Text>
          ) : null}

          <Text style={styles.legalFooter}>
            {t("mobile.login.legalPrefix")}
            <Text
              style={styles.legalLink}
              onPress={() => setActiveLegal("terms")}
            >
              {t("mobile.login.legalTerms")}
            </Text>
            {t("mobile.login.legalConjunction")}
            <Text
              style={styles.legalLink}
              onPress={() => setActiveLegal("privacy")}
            >
              {t("mobile.login.legalPrivacy")}
            </Text>
            {t("mobile.login.legalSuffix")}
          </Text>

          <Pressable
            onPress={() => void continueAsGuest()}
            accessibilityLabel={t("mobile.login.continueAsGuest")}
            accessibilityRole="button"
            disabled={submitState.type === "verifying"}
            style={({ pressed }) => [
              styles.guestButton,
              pressed && styles.guestButtonPressed,
              submitState.type === "verifying"
                ? styles.primaryButtonDisabled
                : null,
            ]}
            testID="continue-without-signing-in-button"
          >
            <Text style={styles.guestButtonText}>
              {t("mobile.login.continueAsGuest")}
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      <Modal
        visible={activeLegal !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setActiveLegal(null)}
      >
        <SafeAreaView style={styles.legalModal}>
          <View style={styles.legalModalHeader}>
            <Text style={styles.legalModalTitle}>
              {activeLegal ? LEGAL_TITLES[activeLegal] : ""}
            </Text>
            <Pressable
              onPress={() => setActiveLegal(null)}
              style={styles.legalModalClose}
            >
              <Text style={styles.legalModalCloseText}>
                {t("mobile.common.done")}
              </Text>
            </Pressable>
          </View>
          <ScrollView
            style={styles.legalModalScroll}
            contentContainerStyle={styles.legalModalContent}
          >
            <Text style={styles.legalModalBody}>
              {activeLegal === "terms"
                ? TERMS_OF_SERVICE
                : activeLegal === "privacy"
                  ? PRIVACY_POLICY
                  : ""}
            </Text>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

function AppleIcon() {
  return (
    <Svg width={18} height={18} viewBox="0 0 18 18">
      <Path
        fill="#FFFFFF"
        d="M14.38 9.55c-.02-2.08 1.7-3.09 1.78-3.14-.97-1.42-2.48-1.61-3.01-1.63-1.27-.13-2.5.75-3.14.75-.65 0-1.64-.73-2.7-.71-1.38.02-2.67.82-3.38 2.08-1.46 2.53-.37 6.25 1.03 8.3.7 1 1.52 2.12 2.6 2.08 1.05-.04 1.44-.67 2.7-.67s1.62.67 2.72.65c1.13-.02 1.85-1.01 2.52-2.03.8-1.15 1.13-2.28 1.14-2.34-.03-.01-2.24-.86-2.26-3.34ZM12.32 3.43c.56-.7.94-1.65.84-2.61-.82.04-1.85.57-2.43 1.25-.52.61-.99 1.6-.87 2.52.93.07 1.88-.47 2.46-1.16Z"
      />
    </Svg>
  );
}

function GoogleIcon() {
  return (
    <Svg width={18} height={18} viewBox="0 0 18 18">
      <Path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.89 2.69-6.62Z"
      />
      <Path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.95-2.18l-2.91-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.71H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <Path
        fill="#FBBC05"
        d="M3.97 10.71A5.41 5.41 0 0 1 3.69 9c0-.59.1-1.16.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.04l3.01-2.33Z"
      />
      <Path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.42 0 9 0A9 9 0 0 0 .96 4.96l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </Svg>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: colors.background,
      paddingHorizontal: 28,
    },
    keyboardAvoid: {
      flex: 1,
      justifyContent: "space-between",
    },
    hero: {
      flex: 1,
      justifyContent: "center",
      gap: 14,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.display.light,
      fontStyle: "italic",
      fontSize: 42,
      letterSpacing: -2,
      lineHeight: 42,
    },
    body: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 17,
      letterSpacing: -0.3,
      lineHeight: 24,
      marginTop: 2,
    },
    formArea: {
      gap: 12,
      paddingBottom: 16,
    },
    socialButton: {
      alignItems: "center",
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 14,
      borderWidth: 1,
      flexDirection: "row",
      gap: 10,
      justifyContent: "center",
      paddingVertical: 16,
    },
    socialButtonPressed: {
      backgroundColor: fadeHex(colors.textMuted, 0.08),
    },
    appleButton: {
      backgroundColor: "#000000",
      borderColor: "#000000",
    },
    appleButtonText: {
      color: "#FFFFFF",
      fontFamily: fonts.sans.semiBold,
      fontSize: 17,
      letterSpacing: -0.3,
    },
    googleButtonText: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 17,
      letterSpacing: -0.3,
    },
    methodDivider: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10,
      paddingVertical: 2,
    },
    methodDividerLine: {
      backgroundColor: colors.border,
      flex: 1,
      height: 1,
    },
    methodDividerText: {
      color: colors.textMuted,
      fontFamily: fonts.mono.regular,
      fontSize: 11,
      letterSpacing: 0,
      textTransform: "uppercase",
    },
    input: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 14,
      borderWidth: 1,
      color: colors.text,
      fontFamily: fonts.sans.regular,
      fontSize: 17,
      paddingHorizontal: 18,
      paddingVertical: 16,
    },
    primaryButton: {
      alignItems: "center",
      backgroundColor: colors.accent,
      borderRadius: 14,
      paddingVertical: 17,
    },
    primaryButtonPressed: {
      backgroundColor: colors.accentHover,
    },
    primaryButtonDisabled: {
      opacity: 0.6,
    },
    primaryButtonText: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.semiBold,
      fontSize: 17,
      letterSpacing: -0.3,
    },
    sentBlock: {
      gap: 10,
    },
    sentActions: {
      flexDirection: "row",
      gap: 18,
      justifyContent: "center",
    },
    inlineLink: {
      paddingVertical: 4,
    },
    inlineLinkPressed: {
      opacity: 0.6,
    },
    inlineLinkText: {
      color: colors.accent,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
      letterSpacing: -0.1,
    },
    successText: {
      color: colors.ok,
      fontFamily: fonts.sans.regular,
      fontSize: 15,
      lineHeight: 21,
      textAlign: "center",
    },
    errorText: {
      color: colors.danger,
      fontFamily: fonts.sans.regular,
      fontSize: 15,
      lineHeight: 21,
      textAlign: "center",
    },
    legalFooter: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      lineHeight: 17,
      textAlign: "center",
      marginTop: 4,
    },
    legalLink: {
      textDecorationLine: "underline",
    },
    guestButton: {
      alignItems: "center",
      marginTop: 8,
      paddingVertical: 16,
    },
    guestButtonPressed: {
      opacity: 0.6,
    },
    guestButtonText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.medium,
      fontSize: 15,
      letterSpacing: -0.2,
    },
    legalModal: {
      flex: 1,
      backgroundColor: colors.background,
      // Soft hairline on the leading (top) edge so the sheet reads against the
      // page beneath, matching the TopSheet primitive's edge treatment.
      borderTopColor: colors.border,
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    legalModalHeader: {
      alignItems: "center",
      borderBottomColor: colors.border,
      borderBottomWidth: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      paddingHorizontal: 20,
      paddingVertical: 14,
    },
    legalModalTitle: {
      color: colors.text,
      fontFamily: fonts.sans.semiBold,
      fontSize: 18,
      letterSpacing: -0.4,
    },
    legalModalClose: {
      paddingHorizontal: 8,
      paddingVertical: 4,
    },
    legalModalCloseText: {
      color: colors.accent,
      fontFamily: fonts.sans.semiBold,
      fontSize: 16,
    },
    legalModalScroll: {
      flex: 1,
    },
    legalModalContent: {
      padding: 20,
      paddingBottom: 40,
    },
    legalModalBody: {
      color: colors.text,
      fontFamily: fonts.sans.regular,
      fontSize: 13,
      lineHeight: 20,
      opacity: 0.8,
    },
  } as const);
