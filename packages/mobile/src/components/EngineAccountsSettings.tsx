import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type {
  EngineConnection,
  EngineProvider,
  EngineSettings,
} from "@stella/contracts/backend/engines";
import { Icon } from "./Icon";
import { GlassToggle } from "./glass";
import { NativeMenu } from "./NativeMenu";
import { makeSettingsStyles } from "./settings/settings-styles";
import { getBackendClient, useBackendView } from "../lib/backend";
import { tapLight } from "../lib/haptics";
import { type Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { useColors } from "../theme/theme-context";
import { useT } from "../i18n";

/**
 * Settings › Claude & ChatGPT: the owner's one list of subscriptions, used by
 * Claude Code and Codex on every one of their computers and by cloud chat and
 * agents. Several accounts per provider, one in use (checked), and an option
 * to move on to the next account when the one in use hits its limit.
 *
 * Claude uses a pasted authorization code. ChatGPT uses device authorization
 * and connects automatically after approval. Tokens stay on the server.
 */

type Section = {
  provider: EngineProvider;
  titleKey: string;
  autoSwitchKey: string;
  pasteHintKey: string;
};

const SECTIONS: Section[] = [
  {
    provider: "anthropic",
    titleKey: "mobile.engineAccounts.claudeSection",
    autoSwitchKey: "mobile.engineAccounts.autoSwitchClaude",
    pasteHintKey: "mobile.engineAccounts.pasteHintClaude",
  },
  {
    provider: "openai-codex",
    titleKey: "mobile.engineAccounts.chatgptSection",
    autoSwitchKey: "mobile.engineAccounts.autoSwitchChatgpt",
    pasteHintKey: "mobile.engineAccounts.pasteHintChatgpt",
  },
];

export const accountInitials = (
  row: Pick<EngineConnection, "email" | "label">,
): string => {
  const source = (row.email ?? row.label).split("@")[0] ?? "";
  const words = source.split(/[^A-Za-z0-9]+/u).filter(Boolean);
  const letters =
    words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : source.slice(0, 2);
  return letters.toUpperCase() || "?";
};

const formatReset = (limitedUntil: number): string => {
  const reset = new Date(limitedUntil);
  return reset.toDateString() === new Date().toDateString()
    ? reset.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : reset.toLocaleString([], {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      });
};

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

export function EngineAccountsSettings({ onBack }: { onBack: () => void }) {
  const colors = useColors();
  const t = useT();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const settingsStyles = useMemo(() => makeSettingsStyles(colors), [colors]);
  const { value: settings } = useBackendView("engines.get", {});

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        styles.content,
        { paddingBottom: 32 + insets.bottom },
      ]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.header}>
        <Pressable
          onPress={onBack}
          hitSlop={10}
          accessibilityLabel={t("mobile.engineAccounts.backLabel")}
          style={({ pressed }) => [
            styles.backButton,
            pressed && styles.pressed,
          ]}
        >
          <Icon name="chevron-left" size={22} color={colors.text} />
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.title} numberOfLines={1}>
            {t("mobile.engineAccounts.title")}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {t("mobile.engineAccounts.subtitle")}
          </Text>
        </View>
      </View>
      {SECTIONS.map((section) => (
        <ProviderSection
          key={section.provider}
          section={section}
          settings={settings}
          styles={styles}
          settingsStyles={settingsStyles}
          colors={colors}
        />
      ))}
      <Text style={[settingsStyles.hint, styles.footnote]}>
        {t("mobile.engineAccounts.localNote")}
      </Text>
    </ScrollView>
  );
}

/**
 * Provider sign-in shared by Settings and onboarding. ChatGPT polls device
 * authorization; Claude exchanges a pasted code. Errors surface as an alert.
 */
export function useEngineConnect(
  provider: EngineProvider,
  { onConnected }: { onConnected?: () => void } = {},
) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [connectId, setConnectId] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [deviceConnect, setDeviceConnect] = useState<{
    connectId: string;
    authorizeUrl: string;
    userCode: string;
    intervalMs: number;
  } | null>(null);
  const onConnectedRef = useRef(onConnected);
  const deviceBrowserOpen = useRef(false);
  onConnectedRef.current = onConnected;

  useEffect(() => {
    if (!deviceConnect) return;
    let cancelled = false;
    let failures = 0;
    const deadline = Date.now() + 15 * 60_000;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await getBackendClient().call(
          "engines.pollDeviceConnect",
          {
            connectId: deviceConnect.connectId,
          },
        );
        if (cancelled) return;
        failures = 0;
        if (result.status === "connected") {
          setDeviceConnect(null);
          setConnectId(null);
          if (deviceBrowserOpen.current) {
            try {
              WebBrowser.dismissBrowser();
            } catch {
              /* Already closed. */
            }
          }
          onConnectedRef.current?.();
          return;
        }
      } catch (error) {
        if (cancelled) return;
        // Browser approval can outlast a brief connection loss or suspension.
        if (++failures < 4 && Date.now() < deadline) {
          timer = setTimeout(
            () => void poll(),
            Math.max(65_000, deviceConnect.intervalMs),
          );
          return;
        }
        setDeviceConnect(null);
        setConnectId(null);
        Alert.alert(
          t("mobile.engineAccounts.errorTitle"),
          errorMessage(error, t("mobile.engineAccounts.errorBody")),
        );
        return;
      }
      if (!cancelled)
        timer = setTimeout(() => void poll(), deviceConnect.intervalMs);
    };
    timer = setTimeout(() => void poll(), deviceConnect.intervalMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [deviceConnect, t]);

  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    try {
      await action();
      return true;
    } catch (error) {
      Alert.alert(
        t("mobile.engineAccounts.errorTitle"),
        errorMessage(error, t("mobile.engineAccounts.errorBody")),
      );
      return false;
    } finally {
      setBusy(false);
    }
  };

  const startConnect = () =>
    void run(async () => {
      if (provider === "openai-codex") {
        const result = await getBackendClient().call(
          "engines.startDeviceConnect",
          {},
        );
        setConnectId(result.connectId);
        setDeviceConnect(result);
        return;
      }
      const result = await getBackendClient().call("engines.startConnect", {
        provider,
      });
      setConnectId(result.connectId);
      setPasted("");
      await WebBrowser.openBrowserAsync(result.authorizeUrl, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      });
      // Back from the browser: most people have the code on the clipboard.
      const clip = await Clipboard.getStringAsync().catch(() => "");
      if (clip && /code|#|^[A-Za-z0-9_-]{20,}/u.test(clip.trim())) {
        setPasted(clip.trim());
      }
    });

  const finishConnect = () => {
    if (!connectId || !pasted.trim()) return;
    void run(async () => {
      await getBackendClient().call("engines.finishConnect", {
        connectId,
        pastedInput: pasted.trim(),
      });
      setConnectId(null);
      setPasted("");
    }).then((ok) => {
      if (ok) onConnected?.();
    });
  };

  const cancelConnect = () => {
    if (connectId) {
      void getBackendClient()
        .call("engines.cancelConnect", { connectId })
        .catch(() => {});
    }
    setDeviceConnect(null);
    setConnectId(null);
    setPasted("");
  };

  const pasteFromClipboard = async () => {
    const clip = await Clipboard.getStringAsync().catch(() => "");
    if (clip) setPasted(clip.trim());
  };

  return {
    busy,
    deviceConnect,
    openDeviceBrowser: () =>
      void run(async () => {
        if (!deviceConnect) return;
        await Clipboard.setStringAsync(deviceConnect.userCode);
        deviceBrowserOpen.current = true;
        try {
          await WebBrowser.openBrowserAsync(deviceConnect.authorizeUrl, {
            presentationStyle:
              WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
          });
        } finally {
          deviceBrowserOpen.current = false;
        }
      }),
    connectId,
    pasted,
    setPasted,
    run,
    startConnect,
    finishConnect,
    cancelConnect,
    pasteFromClipboard,
  };
}

/** Shared by Settings and onboarding; completing approval connects automatically. */
export function EngineDeviceConnectCard({
  connect,
}: {
  connect: ReturnType<typeof useEngineConnect>;
}) {
  const t = useT();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  if (!connect.deviceConnect) return null;
  return (
    <View style={styles.pasteCard}>
      <Text style={styles.subtitle}>
        {t("mobile.engineAccounts.deviceHint")}
      </Text>
      <Text selectable style={styles.deviceCode}>
        {connect.deviceConnect.userCode}
      </Text>
      <View style={styles.pasteActions}>
        <Pressable onPress={connect.cancelConnect} accessibilityRole="button">
          <Text style={styles.subtitle}>{t("mobile.common.cancel")}</Text>
        </Pressable>
        <Pressable
          onPress={connect.openDeviceBrowser}
          disabled={connect.busy}
          accessibilityRole="button"
        >
          <Text
            style={{ color: colors.accent, fontFamily: fonts.sans.semiBold }}
          >
            {t("mobile.engineAccounts.deviceOpen")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function ProviderSection({
  section,
  settings,
  styles,
  settingsStyles,
  colors,
}: {
  section: Section;
  settings: EngineSettings | undefined;
  styles: ReturnType<typeof makeStyles>;
  settingsStyles: ReturnType<typeof makeSettingsStyles>;
  colors: Colors;
}) {
  const t = useT();
  const connect = useEngineConnect(section.provider);
  const {
    busy,
    connectId,
    pasted,
    setPasted,
    run,
    startConnect,
    finishConnect,
    cancelConnect,
    pasteFromClipboard,
  } = connect;
  const accounts = (settings?.connections ?? []).filter(
    (row) => row.provider === section.provider,
  );
  const autoSwitch = settings?.autoSwitch?.[section.provider] ?? false;

  const switchToAccount = (row: EngineConnection) => {
    tapLight();
    void run(() =>
      getBackendClient().call("engines.setActiveAccount", {
        provider: section.provider,
        accountId: row.accountId,
      }),
    );
  };

  const signOut = (row: EngineConnection) => {
    const name = row.email ?? row.label;
    Alert.alert(
      t("mobile.engineAccounts.signOutTitle", { name }),
      t("mobile.engineAccounts.signOutBody"),
      [
        { text: t("mobile.common.cancel"), style: "cancel" },
        {
          text: t("mobile.engineAccounts.signOut"),
          style: "destructive",
          onPress: () =>
            void run(() =>
              getBackendClient().call("engines.disconnect", {
                provider: section.provider,
                accountId: row.accountId,
              }),
            ),
        },
      ],
    );
  };

  const openFallbackMenu = (row: EngineConnection) => {
    Alert.alert(row.email ?? row.label, undefined, [
      ...(row.active
        ? []
        : [
            {
              text: t("mobile.engineAccounts.useAccount"),
              onPress: () => switchToAccount(row),
            },
          ]),
      {
        text: t("mobile.engineAccounts.signOut"),
        style: "destructive" as const,
        onPress: () => signOut(row),
      },
      { text: t("mobile.common.cancel"), style: "cancel" as const },
    ]);
  };

  return (
    <View style={settingsStyles.section}>
      <Text style={settingsStyles.sectionLabel}>{t(section.titleKey)}</Text>
      <View style={settingsStyles.group}>
        {accounts.map((row, index) => {
          const name = row.email ?? row.label;
          const sub = row.limitedUntil
            ? t("mobile.engineAccounts.limitReached", {
                time: formatReset(row.limitedUntil),
              })
            : row.plan;
          return (
            <Pressable
              key={row.accountId}
              onPress={() => (row.active ? undefined : switchToAccount(row))}
              disabled={busy}
              accessibilityRole="button"
              accessibilityState={{ selected: row.active }}
              accessibilityLabel={
                row.active
                  ? `${name}, ${t("mobile.engineAccounts.active")}`
                  : name
              }
              style={({ pressed }) => [
                settingsStyles.row,
                index > 0 && settingsStyles.rowDivider,
                pressed && !row.active && settingsStyles.rowPressed,
              ]}
            >
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>{accountInitials(row)}</Text>
              </View>
              <View style={settingsStyles.rowCopy}>
                <Text style={settingsStyles.rowLabel} numberOfLines={1}>
                  {name}
                </Text>
                {sub ? (
                  <Text
                    style={[
                      settingsStyles.rowSub,
                      row.limitedUntil ? styles.limited : null,
                    ]}
                    numberOfLines={1}
                  >
                    {sub}
                  </Text>
                ) : null}
              </View>
              {row.active ? (
                <Icon name="check" size={20} color={colors.accent} />
              ) : null}
              {Platform.OS === "ios" ? (
                <NativeMenu
                  label={
                    <Icon
                      name="more-horizontal"
                      size={18}
                      color={colors.textMuted}
                    />
                  }
                  accessibilityLabel={t("mobile.engineAccounts.moreLabel", {
                    name,
                  })}
                  width={40}
                  height={36}
                  circular
                  disabled={busy}
                  items={[
                    ...(row.active
                      ? []
                      : [
                          {
                            id: "use",
                            title: t("mobile.engineAccounts.useAccount"),
                            systemImage: "checkmark.circle" as const,
                            onPress: () => switchToAccount(row),
                          },
                        ]),
                    {
                      id: "sign-out",
                      title: t("mobile.engineAccounts.signOut"),
                      systemImage:
                        "rectangle.portrait.and.arrow.right" as const,
                      separatorBefore: !row.active,
                      onPress: () => signOut(row),
                    },
                  ]}
                  onFallbackPress={() => openFallbackMenu(row)}
                />
              ) : (
                <Pressable
                  onPress={() => openFallbackMenu(row)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t("mobile.engineAccounts.moreLabel", {
                    name,
                  })}
                >
                  <Icon
                    name="more-horizontal"
                    size={18}
                    color={colors.textMuted}
                  />
                </Pressable>
              )}
            </Pressable>
          );
        })}
        <Pressable
          onPress={startConnect}
          disabled={busy || connectId !== null}
          accessibilityRole="button"
          style={({ pressed }) => [
            settingsStyles.row,
            accounts.length > 0 && settingsStyles.rowDivider,
            pressed && settingsStyles.rowPressed,
            (busy || connectId !== null) && settingsStyles.rowDisabled,
          ]}
        >
          <View style={[styles.avatar, styles.addAvatar]}>
            <Icon name="plus" size={18} color={colors.text} />
          </View>
          <Text style={settingsStyles.rowLabel}>
            {t("mobile.engineAccounts.addAccount")}
          </Text>
        </Pressable>
      </View>

      {connect.deviceConnect ? (
        <EngineDeviceConnectCard connect={connect} />
      ) : connectId ? (
        <View
          style={[
            settingsStyles.group,
            settingsStyles.groupGap,
            styles.pasteCard,
          ]}
        >
          <Text style={settingsStyles.rowSub}>{t(section.pasteHintKey)}</Text>
          <View style={styles.pasteRow}>
            <TextInput
              value={pasted}
              onChangeText={setPasted}
              placeholder={t("mobile.engineAccounts.pastePlaceholder")}
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              style={styles.pasteInput}
            />
            <Pressable
              onPress={() => void pasteFromClipboard()}
              hitSlop={8}
              accessibilityRole="button"
            >
              <Text style={settingsStyles.rowAction}>
                {t("mobile.engineAccounts.pasteFromClipboard")}
              </Text>
            </Pressable>
          </View>
          <View style={styles.pasteActions}>
            <Pressable
              onPress={cancelConnect}
              disabled={busy}
              hitSlop={8}
              accessibilityRole="button"
            >
              <Text style={settingsStyles.rowSub}>
                {t("mobile.common.cancel")}
              </Text>
            </Pressable>
            <Pressable
              onPress={finishConnect}
              disabled={busy || !pasted.trim()}
              hitSlop={8}
              accessibilityRole="button"
              style={({ pressed }) => [
                (pressed || busy || !pasted.trim()) && styles.pressed,
              ]}
            >
              <Text style={settingsStyles.rowAction}>
                {busy
                  ? t("mobile.engineAccounts.connecting")
                  : t("mobile.engineAccounts.finish")}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {accounts.length > 0 ? (
        <View style={[settingsStyles.group, settingsStyles.groupGap]}>
          <View style={settingsStyles.row}>
            <View style={settingsStyles.rowCopy}>
              <Text style={settingsStyles.rowLabel}>
                {t("mobile.engineAccounts.autoSwitchLabel")}
              </Text>
              <Text style={settingsStyles.rowSub}>
                {t(section.autoSwitchKey)}
              </Text>
            </View>
            <GlassToggle
              value={autoSwitch}
              onValueChange={(enabled: boolean) =>
                void run(() =>
                  getBackendClient().call("engines.setAutoSwitch", {
                    provider: section.provider,
                    enabled,
                  }),
                )
              }
              accessibilityLabel={t("mobile.engineAccounts.autoSwitchLabel")}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: { flex: 1 },
    deviceCode: {
      color: colors.text,
      fontFamily: fonts.mono.regular,
      fontSize: 24,
      letterSpacing: 2,
      textAlign: "center",
      paddingVertical: 12,
    },
    content: { paddingTop: 8 },
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: 8,
      marginBottom: 4,
    },
    backButton: {
      alignItems: "center",
      height: 40,
      justifyContent: "center",
      marginLeft: -8,
      width: 40,
    },
    pressed: { opacity: 0.55 },
    headerCopy: { flex: 1 },
    title: {
      color: colors.text,
      fontFamily: fonts.display.regular,
      fontSize: 26,
      letterSpacing: -1,
    },
    subtitle: {
      color: colors.textMuted,
      fontFamily: fonts.sans.regular,
      fontSize: 12,
      marginTop: 1,
    },
    avatar: {
      alignItems: "center",
      backgroundColor: colors.background,
      borderRadius: 20,
      height: 40,
      justifyContent: "center",
      width: 40,
    },
    addAvatar: {
      borderColor: colors.border,
      borderWidth: StyleSheet.hairlineWidth,
    },
    avatarText: {
      color: colors.text,
      fontFamily: fonts.sans.medium,
      fontSize: 14,
    },
    limited: { color: colors.danger },
    pasteCard: { gap: 10, padding: 16 },
    pasteRow: { alignItems: "center", flexDirection: "row", gap: 12 },
    pasteInput: {
      borderColor: colors.border,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      color: colors.text,
      flex: 1,
      fontFamily: fonts.sans.regular,
      fontSize: 15,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    pasteActions: {
      flexDirection: "row",
      gap: 20,
      justifyContent: "flex-end",
    },
    footnote: { marginTop: 16 },
  });
