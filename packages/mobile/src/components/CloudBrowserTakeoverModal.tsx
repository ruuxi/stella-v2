import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { WebView } from "react-native-webview";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type {
  CloudBrowserInteractionDetail,
  CloudBrowserLiveViewCapability,
} from "../lib/cloud-browser";
import { useCloudBrowserActions } from "../lib/cloud-browser";
import {
  canCaptureCloudBrowserSession,
  captureAndEncryptCloudBrowserSession,
} from "../lib/cloud-browser-session-transfer";
import {
  isCloudBrowserLiveViewNavigationAllowed,
  parseCloudBrowserLiveViewUrl,
} from "../lib/cloud-browser-live-view";
import { useT } from "../i18n";
import { useColors } from "../theme/theme-context";
import type { Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { Icon } from "./Icon";

type LoginDetail = Extract<
  CloudBrowserInteractionDetail,
  { kind: "login_takeover" }
>;

export function CloudBrowserTakeoverModal({
  visible,
  detail,
  busyDecision,
  onDismiss,
  onDecision,
}: {
  visible: boolean;
  detail: LoginDetail;
  busyDecision: "done" | "cancel" | null;
  onDismiss: () => void;
  onDecision: (decision: "done" | "cancel") => Promise<void>;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const t = useT();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { mintLiveView, mintSessionTransfer, importSessionTransfer } =
    useCloudBrowserActions();
  const [capability, setCapability] =
    useState<CloudBrowserLiveViewCapability | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<"local" | "remote">(
    canCaptureCloudBrowserSession() ? "local" : "remote",
  );
  const [localBusy, setLocalBusy] = useState(false);

  useEffect(() => {
    if (!visible) {
      setCapability(null);
      setIssue(null);
      setNotice(null);
      setLocalBusy(false);
      setMode(canCaptureCloudBrowserSession() ? "local" : "remote");
      return;
    }
    if (mode !== "remote") return;
    let disposed = false;
    setCapability(null);
    setIssue(null);
    void mintLiveView({
      interactionId: detail.interactionId,
      expectedRevision: detail.revision,
    })
      .then((next) => {
        if (disposed) return;
        const url = parseCloudBrowserLiveViewUrl(next.url);
        if (
          !url ||
          next.interactionId !== detail.interactionId ||
          next.revision !== detail.revision ||
          next.expiresAt <= Date.now()
        ) {
          setIssue(t("cloudBrowser.errors.liveViewBoundary"));
          return;
        }
        setCapability({ ...next, url: url.toString() });
      })
      .catch(() => {
        if (!disposed) setIssue(t("cloudBrowser.errors.liveView"));
      });
    return () => {
      disposed = true;
      setCapability(null);
    };
  }, [detail.interactionId, detail.revision, mintLiveView, mode, t, visible]);

  useEffect(() => {
    if (!visible) return;
    const subscription = AppState.addEventListener("change", (state) => {
      // A backgrounded app must not retain a human-control bearer URL. Closing
      // the view leaves the challenge pending; reopening mints a fresh one.
      if (state !== "active") onDismiss();
    });
    return () => subscription.remove();
  }, [onDismiss, visible]);

  const title = detail.displayOrigin;
  const localNavigationAllowed = useCallback(
    (value: string): boolean => {
      if (value === "about:blank") return true;
      try {
        const url = new URL(value);
        if (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          url.origin === detail.displayOrigin
        ) {
          return true;
        }
      } catch {
        // Fall through to the remote browser fallback.
      }
      setNotice(t("cloudBrowser.takeover.localOriginFallback"));
      setMode("remote");
      return false;
    },
    [detail.displayOrigin, t],
  );

  const finishLocalSignIn = useCallback(async () => {
    if (localBusy || busyDecision) return;
    setLocalBusy(true);
    setNotice(null);
    try {
      const transferCapability = await mintSessionTransfer({
        interactionId: detail.interactionId,
        expectedRevision: detail.revision,
      });
      const transfer = await captureAndEncryptCloudBrowserSession({
        interactionId: detail.interactionId,
        interactionRevision: detail.revision,
        displayOrigin: detail.displayOrigin,
        loginUrl: detail.loginUrl,
        capability: transferCapability,
      });
      await importSessionTransfer({
        interactionId: detail.interactionId,
        expectedRevision: detail.revision,
        transfer,
      });
      await onDecision("done");
    } catch {
      setNotice(t("cloudBrowser.takeover.localTransferFallback"));
      setMode("remote");
    } finally {
      setLocalBusy(false);
    }
  }, [
    busyDecision,
    detail.displayOrigin,
    detail.interactionId,
    detail.loginUrl,
    detail.revision,
    importSessionTransfer,
    localBusy,
    mintSessionTransfer,
    onDecision,
    t,
  ]);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onDismiss}
    >
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          {/* Steps back to chat without deciding. iOS has no back button and
              this sheet is full screen, so without it the only exits were
              Done or Cancel. The request stays pending and can be reopened. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("common.close")}
            hitSlop={8}
            onPress={onDismiss}
            style={({ pressed }) => [
              styles.close,
              pressed && styles.closePressed,
            ]}
          >
            <Icon name="x" size={18} color={colors.textMuted} />
          </Pressable>
          <View style={styles.headerTitle}>
            <Icon name="globe" size={17} color={colors.textMuted} />
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
          </View>
          <Text style={styles.privateLabel} numberOfLines={1}>
            {mode === "local"
              ? t("cloudBrowser.takeover.localNotice")
              : t("cloudBrowser.takeover.privateNotice")}
          </Text>
        </View>

        <View style={styles.viewport}>
          {issue ? (
            <View style={styles.status}>
              <Icon name="alert-circle" size={26} color={colors.danger} />
              <Text style={styles.statusText}>{issue}</Text>
            </View>
          ) : mode === "local" ? (
            <WebView
              source={{ uri: detail.loginUrl }}
              style={styles.webView}
              cacheEnabled={false}
              sharedCookiesEnabled={false}
              thirdPartyCookiesEnabled={false}
              originWhitelist={[detail.displayOrigin]}
              onShouldStartLoadWithRequest={(request) =>
                localNavigationAllowed(request.url)
              }
              bounces={false}
              overScrollMode="never"
              automaticallyAdjustContentInsets={false}
              contentInsetAdjustmentBehavior="never"
              keyboardDisplayRequiresUserAction={false}
            />
          ) : capability ? (
            <WebView
              source={{ uri: capability.url }}
              style={styles.webView}
              incognito
              cacheEnabled={false}
              sharedCookiesEnabled={false}
              thirdPartyCookiesEnabled={false}
              originWhitelist={["https://live.browser.run"]}
              onShouldStartLoadWithRequest={(request) =>
                isCloudBrowserLiveViewNavigationAllowed(request.url)
              }
              bounces={false}
              overScrollMode="never"
              automaticallyAdjustContentInsets={false}
              contentInsetAdjustmentBehavior="never"
              keyboardDisplayRequiresUserAction={false}
            />
          ) : (
            <View style={styles.status}>
              <ActivityIndicator color={colors.textMuted} />
              <Text style={styles.statusText}>
                {t("cloudBrowser.takeover.preparing")}
              </Text>
            </View>
          )}
        </View>

        {notice ? <Text style={styles.notice}>{notice}</Text> : null}

        <View
          style={[
            styles.controls,
            { paddingBottom: Math.max(insets.bottom, 10) },
          ]}
        >
          <Pressable
            accessibilityRole="button"
            disabled={Boolean(busyDecision)}
            onPress={() => {
              onDismiss();
              void onDecision("cancel");
            }}
            style={({ pressed }) => [
              styles.button,
              pressed && styles.buttonPressed,
            ]}
          >
            <Text style={styles.buttonText}>
              {busyDecision === "cancel"
                ? t("cloudBrowser.actions.canceling")
                : t("common.cancel")}
            </Text>
          </Pressable>
          {mode === "local" ? (
            <Pressable
              accessibilityRole="button"
              disabled={Boolean(busyDecision) || localBusy}
              onPress={() => {
                setNotice(null);
                setMode("remote");
              }}
              style={({ pressed }) => [
                styles.button,
                pressed && styles.buttonPressed,
              ]}
            >
              <Text style={styles.buttonText}>
                {t("cloudBrowser.actions.useCloudBrowser")}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            disabled={
              Boolean(busyDecision) ||
              localBusy ||
              (mode === "remote" && !capability)
            }
            onPress={() => {
              if (mode === "local") {
                void finishLocalSignIn();
                return;
              }
              void onDecision("done");
            }}
            style={({ pressed }) => [
              styles.button,
              styles.buttonPrimary,
              pressed && styles.buttonPrimaryPressed,
              ((mode === "remote" && !capability) ||
                busyDecision ||
                localBusy) &&
                styles.buttonDisabled,
            ]}
          >
            <Text style={styles.buttonPrimaryText}>
              {busyDecision === "done" || localBusy
                ? t("cloudBrowser.actions.finishing")
                : t("cloudBrowser.actions.done")}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: { backgroundColor: colors.background, flex: 1 },
    header: {
      alignItems: "center",
      backgroundColor: colors.surface,
      borderBottomColor: colors.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 10,
      justifyContent: "space-between",
      minHeight: 48,
      paddingHorizontal: 10,
    },
    close: {
      alignItems: "center",
      borderRadius: 16,
      height: 32,
      justifyContent: "center",
      width: 32,
    },
    closePressed: { backgroundColor: colors.muted },
    headerTitle: {
      alignItems: "center",
      flex: 1,
      flexDirection: "row",
      gap: 7,
      minWidth: 0,
    },
    title: {
      color: colors.text,
      flexShrink: 1,
      fontFamily: fonts.sans.semiBold,
      fontSize: 14,
    },
    privateLabel: {
      color: colors.textMuted,
      flexShrink: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 11,
      textAlign: "right",
    },
    viewport: { backgroundColor: "#ffffff", flex: 1 },
    webView: { backgroundColor: "#ffffff", flex: 1 },
    status: {
      alignItems: "center",
      flex: 1,
      gap: 12,
      justifyContent: "center",
      paddingHorizontal: 28,
    },
    statusText: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 14,
      lineHeight: 20,
      textAlign: "center",
    },
    notice: {
      backgroundColor: colors.muted,
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      lineHeight: 17,
      paddingHorizontal: 14,
      paddingVertical: 8,
      textAlign: "center",
    },
    controls: {
      alignItems: "center",
      backgroundColor: colors.surface,
      borderTopColor: colors.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      gap: 10,
      justifyContent: "flex-end",
      paddingHorizontal: 14,
      paddingTop: 10,
    },
    button: {
      alignItems: "center",
      borderColor: colors.border,
      borderRadius: 18,
      borderWidth: StyleSheet.hairlineWidth,
      justifyContent: "center",
      minHeight: 38,
      minWidth: 88,
      paddingHorizontal: 16,
    },
    buttonPressed: { backgroundColor: colors.muted },
    buttonPrimary: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
    buttonPrimaryPressed: { opacity: 0.82 },
    buttonDisabled: { opacity: 0.45 },
    buttonText: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
    },
    buttonPrimaryText: {
      color: colors.accentForeground,
      fontFamily: fonts.sans.semiBold,
      fontSize: 14,
    },
  });
