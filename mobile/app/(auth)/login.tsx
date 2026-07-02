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
import { getSetCookie } from "@better-auth/expo/client";
import { useRouter } from "expo-router";
import Svg, { Path } from "react-native-svg";
import { authClient } from "../../src/lib/auth-client";
import { clearCachedToken } from "../../src/lib/auth-token";
import { clearCachedDesktopBridge } from "../../src/lib/desktop-bridge-chat";
import { env } from "../../src/config/env";
import { userFacingError } from "../../src/lib/user-facing-error";
import { setGuestMode } from "../../src/lib/guest-mode";
import { type Colors } from "../../src/theme/colors";
import { useColors, useTheme } from "../../src/theme/theme-context";
import { fadeHex } from "../../src/theme/oklch";
import { fonts } from "../../src/theme/fonts";
import { TERMS_OF_SERVICE, PRIVACY_POLICY } from "../../src/lib/legal-text";
import { loadLastMainTabHref } from "../../src/lib/last-main-tab";

type LegalDoc = "terms" | "privacy" | null;

const LEGAL_TITLES = { terms: "Terms of Service", privacy: "Privacy Policy" };

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

export default function LoginScreen() {
  const colors = useColors();
  const { isDark } = useTheme();
  const router = useRouter();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [email, setEmail] = useState("");
  const [submitState, setSubmitState] = useState<SubmitState>({ type: "idle" });
  const [activeLegal, setActiveLegal] = useState<LegalDoc>(null);
  const [canResend, setCanResend] = useState(false);
  const cancelledRef = useRef(false);

  const continueAsGuest = async () => {
    await SecureStore.deleteItemAsync("stella-mobile_cookie");
    clearCachedToken();
    clearCachedDesktopBridge();
    const store = (authClient as unknown as {
      $store?: { notify: (signal: string) => void };
    }).$store;
    store?.notify("$sessionSignal");
    await setGuestMode(true);
    router.replace(await loadLastMainTabHref());
  };

  const sendMagicLink = async () => {
    const trimmed = email.trim();
    if (!trimmed) {
      setSubmitState({ type: "error", message: "Enter your email." });
      return;
    }

    setSubmitState({ type: "sending" });

    try {
      const response = await fetch(
        `${env.convexSiteUrl}/api/auth/link/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: trimmed }),
        },
      );
      const data = (await response.json()) as {
        requestId?: string;
        error?: string;
      };
      if (!response.ok || !data.requestId) {
        throw new Error(data.error || "Failed to send sign-in email.");
      }
      setSubmitState({ type: "sent", requestId: data.requestId });
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
            "Google sign-in could not start.",
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
            message: "Apple did not return an identity token.",
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
              "Apple sign-in could not complete.",
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
            "Apple sign-in could not start.",
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
    cancelledRef.current = true;
    setSubmitState({ type: "idle" });
  };

  // Poll for magic link verification.
  useEffect(() => {
    if (submitState.type !== "sent") return;
    const { requestId } = submitState;
    cancelledRef.current = false;

    const poll = async () => {
      while (!cancelledRef.current) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (cancelledRef.current) return;

        try {
          const res = await fetch(
            `${env.convexSiteUrl}/api/auth/link/status?requestId=${encodeURIComponent(requestId)}`,
          );
          if (!res.ok) continue;
          const data = (await res.json()) as {
            status: string;
            ott?: string;
            sessionCookie?: string;
          };

          if (data.status === "completed" && data.sessionCookie) {
            if (cancelledRef.current) return;
            setSubmitState({ type: "verifying" });
            try {
              const prev = await SecureStore.getItemAsync("stella-mobile_cookie");
              const parsed = getSetCookie(data.sessionCookie, prev ?? undefined);
              await SecureStore.setItemAsync("stella-mobile_cookie", parsed);
              // Notify the session signal so useSession() re-fetches with the
              // newly-stored cookie. The expo plugin's init hook attaches it to
              // the request, and the server returns valid session data.
              const store = (authClient as unknown as { $store?: { notify: (s: string) => void } }).$store;
              store?.notify("$sessionSignal");
            } catch {
              setSubmitState({
                type: "error",
                message: "Could not finish sign-in. Please try again.",
              });
            }
            return;
          }
          if (data.status === "completed") {
            if (cancelledRef.current) return;
            setSubmitState({
              type: "error",
              message: "Sign-in incomplete. Please try again.",
            });
            return;
          }

          if (data.status === "expired") {
            if (cancelledRef.current) return;
            setSubmitState({
              type: "error",
              message: "Link expired. Please try again.",
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
      cancelledRef.current = true;
    };
  }, [submitState]);

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style={isDark ? "light" : "dark"} />
      <KeyboardAvoidingView
        style={styles.keyboardAvoid}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={styles.hero} onPress={Keyboard.dismiss}>
          <Text style={styles.title} maxFontSizeMultiplier={1.2}>
            Your assistant,{"\n"}pocket-sized.
          </Text>
          <Text style={styles.body}>
            Use Apple, Google, or the email you use on your computer.
          </Text>
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
              accessibilityLabel="Continue with Apple"
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
                  ? "Opening Apple..."
                  : "Continue with Apple"}
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
            accessibilityLabel="Continue with Google"
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
                ? "Opening Google..."
                : "Continue with Google"}
            </Text>
          </Pressable>

          <View style={styles.methodDivider}>
            <View style={styles.methodDividerLine} />
            <Text style={styles.methodDividerText}>or use email</Text>
            <View style={styles.methodDividerLine} />
          </View>

          <TextInput
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            onChangeText={setEmail}
            placeholder="Email"
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
                ? "Sending..."
                : submitState.type === "verifying"
                  ? "Signing in..."
                  : "Continue"}
            </Text>
          </Pressable>

          {submitState.type === "sent" ? (
            <View style={styles.sentBlock}>
              <Text style={styles.successText}>
                Check your inbox and tap the link — you'll be signed in
                automatically.
              </Text>
              <View style={styles.sentActions}>
                <Pressable
                  onPress={editEmail}
                  accessibilityLabel="Use a different email"
                  style={({ pressed }) => [
                    styles.inlineLink,
                    pressed && styles.inlineLinkPressed,
                  ]}
                >
                  <Text style={styles.inlineLinkText}>Use a different email</Text>
                </Pressable>
                {canResend ? (
                  <Pressable
                    onPress={() => void sendMagicLink()}
                    accessibilityLabel="Resend sign-in email"
                    style={({ pressed }) => [
                      styles.inlineLink,
                      pressed && styles.inlineLinkPressed,
                    ]}
                  >
                    <Text style={styles.inlineLinkText}>Resend</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          ) : null}

          {submitState.type === "error" ? (
            <Text style={styles.errorText}>{submitState.message}</Text>
          ) : null}

          <Text style={styles.legalFooter}>
            By continuing, you agree to our{" "}
            <Text
              style={styles.legalLink}
              onPress={() => setActiveLegal("terms")}
            >
              Terms
            </Text>
            {" and "}
            <Text
              style={styles.legalLink}
              onPress={() => setActiveLegal("privacy")}
            >
              Privacy Policy
            </Text>
            .
          </Text>

          <Pressable
            onPress={() => void continueAsGuest()}
            style={({ pressed }) => [
              styles.guestButton,
              pressed && styles.guestButtonPressed,
            ]}
          >
            <Text style={styles.guestButtonText}>
              Continue without signing in
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
              <Text style={styles.legalModalCloseText}>Done</Text>
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

const makeStyles = (colors: Colors) => StyleSheet.create({
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
