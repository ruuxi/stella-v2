import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { getRandomBytes } from "expo-crypto";
import * as WebBrowser from "expo-web-browser";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  isEngineConnectionUsable,
  type EngineConnection,
  type EngineProvider,
  type EngineSettings,
} from "@stella/contracts/backend/engines";
import { CHATGPT_SIWC } from "@stella/contracts/chatgpt-siwc";
import {
  ANTHROPIC_OAUTH,
  anthropicAuthorizeUrl,
  createPkce,
  parseAuthorizationInput,
} from "@stella/contracts/engine-oauth";
import { exchangeAnthropicCode } from "@stella/contracts/engine-oauth-flows";
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
 * Settings › Claude & ChatGPT: the subscriptions kept with the Stella
 * account. Several accounts per provider, one in use (checked), and an option
 * to move on to the next account when the one in use hits its limit.
 *
 * Claude: one list for Claude Code on every computer and in the cloud. It
 * signs in on this phone: the consent page shows a code the user pastes
 * back, the phone exchanges it with Anthropic itself and uploads the tokens
 * (`engines.addAccount`); Stella's server never contacts Anthropic, and the
 * owner's devices keep the tokens refreshed.
 *
 * ChatGPT: Sign in with ChatGPT for Stella's cloud, which is its own host
 * (each computer signs in separately in the desktop app). The server builds
 * the authorization; ChatGPT redirects to a 127.0.0.1 address nothing on a
 * phone answers, so the user pastes that address back and the server
 * exchanges it, keeps the credentials and refreshes them.
 */

type Section = {
  provider: EngineProvider;
  titleKey: string;
  noteKey: string;
  autoSwitchKey: string;
  pasteHintKey: string;
};

const SECTIONS: Section[] = [
  {
    provider: "anthropic",
    titleKey: "mobile.engineAccounts.claudeSection",
    noteKey: "mobile.engineAccounts.claudeNote",
    autoSwitchKey: "mobile.engineAccounts.autoSwitchClaude",
    pasteHintKey: "mobile.engineAccounts.pasteHintClaude",
  },
  {
    provider: "chatgpt",
    titleKey: "mobile.engineAccounts.chatgptSection",
    noteKey: "mobile.engineAccounts.chatgptNote",
    autoSwitchKey: "mobile.engineAccounts.autoSwitchChatgpt",
    pasteHintKey: "mobile.engineAccounts.pasteHintChatgpt",
  },
];

const PLAN_WELCOME_KEY = "stella-mobile.chatgpt-plan-welcome-shown";

/** "You're using your ChatGPT plan", once, after the first plan-enabled sign-in. */
const announceChatGptPlanUse = async (t: ReturnType<typeof useT>) => {
  try {
    if (await AsyncStorage.getItem(PLAN_WELCOME_KEY)) return;
    await AsyncStorage.setItem(PLAN_WELCOME_KEY, "1");
  } catch {
    // Storage unavailable: show it this time.
  }
  Alert.alert(
    t("mobile.engineAccounts.planWelcomeTitle"),
    t("mobile.engineAccounts.planWelcomeBody"),
    [
      { text: t("mobile.engineAccounts.manageUsage"), onPress: openChatGptUsage },
      { text: t("mobile.common.done"), style: "cancel" },
    ],
  );
};

/** ChatGPT Settings › Usage: review usage and Stella's limit. */
export const openChatGptUsage = () => {
  void Linking.openURL(CHATGPT_SIWC.manageUsageUrl).catch(() => undefined);
};

/** A ChatGPT redirect URL on the clipboard (`…/auth/callback?code=…&state=…`). */
const looksLikeChatGptCallback = (value: string): boolean =>
  /[?&]code=/u.test(value) && /[?&]state=/u.test(value);

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
    </ScrollView>
  );
}

/**
 * Provider sign-in shared by Settings and onboarding. Both paste back:
 * Claude's consent page shows a code this phone exchanges itself; ChatGPT
 * lands on an address that doesn't load, which the server exchanges for
 * Stella's cloud. Errors surface as an alert. `connectId` names the attempt
 * waiting for the paste (the server's for ChatGPT, a local one for Claude).
 */
export function useEngineConnect(
  provider: EngineProvider,
  { onConnected }: { onConnected?: () => void } = {},
) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [connectId, setConnectId] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const onConnectedRef = useRef(onConnected);
  /** Claude: the PKCE verifier (also the state) of the attempt in progress. */
  const claudeVerifier = useRef<string | null>(null);
  /** ChatGPT: the authorization page of the attempt in progress. */
  const chatGptAuthorizeUrl = useRef<string | null>(null);
  onConnectedRef.current = onConnected;

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

  const openChatGpt = async (authorizeUrl: string) => {
    await WebBrowser.openBrowserAsync(authorizeUrl, {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
    });
    // Back from the browser: the copied address is usually on the clipboard.
    const clip = await Clipboard.getStringAsync().catch(() => "");
    if (clip && looksLikeChatGptCallback(clip.trim())) setPasted(clip.trim());
  };

  /**
   * Begin adding an account. ChatGPT: `accountId` signs a saved cloud
   * account in again; `enablePlanUsage` asks for plan-use consent again.
   */
  const startConnect = (
    options: { accountId?: string; enablePlanUsage?: boolean } = {},
  ) =>
    void run(async () => {
      setPasted("");
      if (provider === "chatgpt") {
        const started = await getBackendClient().call("engines.startConnect", {
          provider: "chatgpt",
          ...(options.accountId ? { accountId: options.accountId } : {}),
          ...(options.enablePlanUsage ? { enablePlanUsage: true } : {}),
        });
        chatGptAuthorizeUrl.current = started.authorizeUrl;
        setConnectId(started.connectId);
        await openChatGpt(started.authorizeUrl);
        return;
      }
      const { verifier, challenge } = await createPkce({
        randomBytes: getRandomBytes,
        sha256: (data) => sha256(data),
      });
      claudeVerifier.current = verifier;
      setConnectId(verifier);
      const authorizeUrl = anthropicAuthorizeUrl({
        challenge,
        state: verifier,
        redirectUri: ANTHROPIC_OAUTH.pasteRedirectUri,
      });
      await WebBrowser.openBrowserAsync(authorizeUrl, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
      });
      // Back from the browser: most people have the code on the clipboard.
      const clip = await Clipboard.getStringAsync().catch(() => "");
      if (clip && /code|#|^[A-Za-z0-9_-]{20,}/u.test(clip.trim())) {
        setPasted(clip.trim());
      }
    });

  const finishChatGpt = (attempt: string) =>
    void run(async () => {
      const result = await getBackendClient().call("engines.finishConnect", {
        connectId: attempt,
        pastedInput: pasted.trim(),
      });
      chatGptAuthorizeUrl.current = null;
      setConnectId(null);
      setPasted("");
      onConnectedRef.current?.();
      if (result.planUsage) {
        await announceChatGptPlanUse(t);
      } else {
        Alert.alert(
          t("mobile.engineAccounts.statusPlanUsageOff"),
          t("mobile.engineAccounts.planUsageOffBody"),
        );
      }
    });

  const finishConnect = () => {
    if (!connectId || !pasted.trim()) return;
    if (provider === "chatgpt") {
      finishChatGpt(connectId);
      return;
    }
    const verifier = claudeVerifier.current;
    if (!verifier) return;
    void run(async () => {
      const parsed = parseAuthorizationInput(pasted);
      if (!parsed.code) throw new Error(t("mobile.engineAccounts.errorBody"));
      if (parsed.state && parsed.state !== verifier) {
        throw new Error("The pasted code belongs to a different sign-in. Start again.");
      }
      // Exchanged from this phone; only the tokens go to Stella.
      const { tokens, identity } = await exchangeAnthropicCode({
        code: parsed.code,
        state: parsed.state ?? verifier,
        verifier,
        redirectUri: ANTHROPIC_OAUTH.pasteRedirectUri,
      });
      await getBackendClient().call("engines.addAccount", {
        provider: "anthropic",
        tokens: {
          access: tokens.access,
          refresh: tokens.refresh,
          expiresInMs: tokens.expiresAt - Date.now(),
        },
        ...identity,
      });
      claudeVerifier.current = null;
      setConnectId(null);
      setPasted("");
    }).then((ok) => {
      if (ok) onConnectedRef.current?.();
    });
  };

  const cancelConnect = () => {
    claudeVerifier.current = null;
    chatGptAuthorizeUrl.current = null;
    if (connectId && provider === "chatgpt") {
      void getBackendClient()
        .call("engines.cancelConnect", { connectId })
        .catch(() => {});
    }
    setConnectId(null);
    setPasted("");
  };

  const pasteFromClipboard = async () => {
    const clip = await Clipboard.getStringAsync().catch(() => "");
    if (clip) setPasted(clip.trim());
  };

  return {
    busy,
    connectId,
    pasted,
    setPasted,
    run,
    startConnect,
    finishConnect,
    cancelConnect,
    pasteFromClipboard,
    /** ChatGPT: open the authorization page of the attempt again. */
    reopenAuthorizePage:
      provider === "chatgpt"
        ? () => {
            const url = chatGptAuthorizeUrl.current;
            if (url) void run(() => openChatGpt(url));
          }
        : undefined,
  };
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
  const chatgpt = section.provider === "chatgpt";

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
            void run(async () => {
              const result = await getBackendClient().call("engines.disconnect", {
                provider: section.provider,
                accountId: row.accountId,
              });
              if (result && !result.revoked) {
                Alert.alert(
                  t("mobile.engineAccounts.statusSignedOut"),
                  t("mobile.engineAccounts.revokeUnconfirmed"),
                );
              }
            }),
        },
      ],
    );
  };

  /** ChatGPT: forget the account, registration included. */
  const remove = (row: EngineConnection) => {
    const name = row.email ?? row.label;
    Alert.alert(
      t("mobile.engineAccounts.removeTitle", { name }),
      t("mobile.engineAccounts.removeBody"),
      [
        { text: t("mobile.common.cancel"), style: "cancel" },
        {
          text: t("mobile.engineAccounts.remove"),
          style: "destructive",
          onPress: () =>
            void run(() =>
              getBackendClient().call("engines.disconnect", {
                provider: section.provider,
                accountId: row.accountId,
                forget: true,
              }),
            ),
        },
      ],
    );
  };

  /** What a row's menu offers, by the account's state. */
  const rowActions = (row: EngineConnection) => {
    const usable = isEngineConnectionUsable(row);
    return [
      ...(usable && !row.active
        ? [
            {
              id: "use",
              title: t("mobile.engineAccounts.useAccount"),
              systemImage: "checkmark.circle" as const,
              onPress: () => switchToAccount(row),
            },
          ]
        : []),
      ...(chatgpt && row.status
        ? [
            {
              id: "sign-in-again",
              title: t("mobile.engineAccounts.signInAgain"),
              systemImage: "arrow.clockwise" as const,
              onPress: () => startConnect({ accountId: row.accountId }),
            },
          ]
        : []),
      ...(chatgpt && !row.status && row.planUsage === false
        ? [
            {
              id: "enable-plan-usage",
              title: t("mobile.engineAccounts.enablePlanUsage"),
              systemImage: "checkmark.shield" as const,
              onPress: () =>
                startConnect({ accountId: row.accountId, enablePlanUsage: true }),
            },
          ]
        : []),
      ...(row.status
        ? []
        : [
            {
              id: "sign-out",
              title: t("mobile.engineAccounts.signOut"),
              systemImage: "rectangle.portrait.and.arrow.right" as const,
              destructive: true,
              onPress: () => signOut(row),
            },
          ]),
      ...(chatgpt
        ? [
            {
              id: "remove",
              title: t("mobile.engineAccounts.remove"),
              systemImage: "trash" as const,
              destructive: true,
              onPress: () => remove(row),
            },
          ]
        : []),
    ];
  };

  const rowSubtitle = (row: EngineConnection): string | undefined => {
    if (row.status === "signed_out") return t("mobile.engineAccounts.statusSignedOut");
    if (row.status === "reauth_required") return t("mobile.engineAccounts.statusReauth");
    if (row.planUsage === false) return t("mobile.engineAccounts.statusPlanUsageOff");
    if (row.limitedUntil) {
      return t("mobile.engineAccounts.limitReached", {
        time: formatReset(row.limitedUntil),
      });
    }
    return row.plan;
  };

  const openFallbackMenu = (row: EngineConnection) => {
    Alert.alert(row.email ?? row.label, undefined, [
      ...rowActions(row).map((action) => ({
        text: action.title,
        ...("destructive" in action ? { style: "destructive" as const } : {}),
        onPress: action.onPress,
      })),
      { text: t("mobile.common.cancel"), style: "cancel" as const },
    ]);
  };

  return (
    <View style={settingsStyles.section}>
      <Text style={settingsStyles.sectionLabel}>{t(section.titleKey)}</Text>
      <View style={settingsStyles.group}>
        {accounts.map((row, index) => {
          const name = row.email ?? row.name ?? row.label;
          const sub = rowSubtitle(row);
          const usable = isEngineConnectionUsable(row);
          return (
            <Pressable
              key={row.accountId}
              onPress={() =>
                row.active || !usable ? undefined : switchToAccount(row)
              }
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
                      row.limitedUntil || !usable ? styles.limited : null,
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
                  items={rowActions(row).map((action, actionIndex) => ({
                    id: action.id,
                    title: action.title,
                    systemImage: action.systemImage,
                    separatorBefore:
                      actionIndex > 0 && "destructive" in action,
                    onPress: action.onPress,
                  }))}
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
          onPress={() => startConnect()}
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
            {chatgpt
              ? t("mobile.engineAccounts.continueWithChatgpt")
              : t("mobile.engineAccounts.addAccount")}
          </Text>
        </Pressable>
      </View>
      <Text style={[settingsStyles.hint, styles.sectionNote]}>
        {t(section.noteKey)}
      </Text>

      {connectId ? (
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
              placeholder={
                chatgpt
                  ? t("mobile.engineAccounts.pastePlaceholderUrl")
                  : t("mobile.engineAccounts.pastePlaceholder")
              }
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
            {connect.reopenAuthorizePage ? (
              <Pressable
                onPress={connect.reopenAuthorizePage}
                disabled={busy}
                hitSlop={8}
                accessibilityRole="button"
              >
                <Text style={settingsStyles.rowSub}>
                  {t("mobile.engineAccounts.openChatgptAgain")}
                </Text>
              </Pressable>
            ) : null}
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
          {chatgpt ? (
            <Pressable
              onPress={openChatGptUsage}
              accessibilityRole="link"
              style={({ pressed }) => [
                settingsStyles.row,
                settingsStyles.rowDivider,
                pressed && settingsStyles.rowPressed,
              ]}
            >
              <Text style={[settingsStyles.rowLabel, styles.flexLabel]}>
                {t("mobile.engineAccounts.manageUsage")}
              </Text>
              <Icon name="arrow-up-right" size={16} color={colors.textMuted} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    screen: { flex: 1 },
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
    sectionNote: { marginTop: 8 },
    flexLabel: { flex: 1 },
  });
