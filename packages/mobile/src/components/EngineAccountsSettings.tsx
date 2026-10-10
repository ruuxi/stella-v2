import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  AppState,
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
import * as WebBrowser from "expo-web-browser";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  isEngineConnectionUsable,
  type ChatGptSharedRegistration,
  type EngineConnection,
  type EngineProvider,
  type EngineSettings,
} from "@stella/contracts/backend/engines";
import { CHATGPT_SIWC } from "@stella/contracts/chatgpt-siwc";
import { Icon } from "./Icon";
import { NativeMenu } from "./NativeMenu";
import type { NativeMenuItem } from "./NativeMenu.types";
import { makeSettingsStyles } from "./settings/settings-styles";
import { getBackendClient, useBackendView } from "../lib/backend";
import { tapLight } from "../lib/haptics";
import { type Colors } from "../theme/colors";
import { fonts } from "../theme/fonts";
import { fadeHex } from "../theme/oklch";
import { useColors } from "../theme/theme-context";
import { useT } from "../i18n";

/**
 * Settings › Claude & ChatGPT: the subscriptions kept with the Stella
 * account. Several accounts per provider, one in use (checked); the user
 * switches by hand, nothing switches on its own.
 *
 * Claude: Stella never holds a Claude credential. Every computer runs Claude
 * Code on its own sign-in, and Stella's cloud signs in inside the owner's
 * container. The phone never signs in to Claude itself: "Sign in in the
 * cloud" starts `claude auth login` in the cloud
 * (`engines.startClaudeCloudLogin`), opens Anthropic's own page, and hands
 * the code Anthropic shows to that CLI (`engines.finishClaudeCloudLogin`).
 * Each account lists the places it is signed in.
 *
 * ChatGPT: Sign in with ChatGPT for Stella's cloud, which is its own host
 * (each computer signs in separately in the desktop app). The server builds
 * the authorization; ChatGPT redirects to a 127.0.0.1 address nothing on a
 * phone answers, so the user pastes that address back and the server
 * finishes it. A client another of the owner's hosts registered can be
 * reused ("Continue with ChatGPT as …").
 */

type Section = {
  provider: EngineProvider;
  titleKey: string;
  /** The connect row names its own provider, so it reads alone. */
  connectKey: string;
};

const SECTIONS: Section[] = [
  {
    provider: "anthropic",
    titleKey: "mobile.engineAccounts.claudeSection",
    connectKey: "mobile.engineAccounts.connectClaude",
  },
  {
    provider: "chatgpt",
    titleKey: "mobile.engineAccounts.chatgptSection",
    connectKey: "mobile.engineAccounts.connectChatgpt",
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

export const accountInitials = (
  row: Pick<EngineConnection, "email" | "label">,
): string => {
  const source = (row.email ?? row.label).split("@")[0] ?? "";
  const words = source.split(/[^A-Za-z0-9]+/u).filter(Boolean);
  const letters =
    words.length >= 2 ? `${words[0]![0]}${words[1]![0]}` : source.slice(0, 2);
  return letters.toUpperCase() || "?";
};

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message ? error.message : fallback;

const hasCloudLogin = (row: EngineConnection): boolean =>
  (row.places ?? []).some((place) => place.kind === "cloud");

/**
 * The owner's ChatGPT registrations this cloud could sign in with: those
 * whose issued client id isn't already one of the cloud's ChatGPT accounts.
 */
type ReusableRegistration = ChatGptSharedRegistration & { who?: string };

const reusableChatGptRegistrations = (
  settings: EngineSettings | undefined,
): ReusableRegistration[] => {
  const known = new Set(
    (settings?.connections ?? []).flatMap((row) =>
      row.provider === "chatgpt" && row.clientId ? [row.clientId] : [],
    ),
  );
  const result: ReusableRegistration[] = [];
  for (const registration of settings?.chatGptRegistrations ?? []) {
    if (known.has(registration.clientId)) continue;
    known.add(registration.clientId);
    result.push({
      ...registration,
      who: registration.email ?? registration.name,
    });
  }
  return result;
};

export function EngineAccountsSettings({ onBack }: { onBack: () => void }) {
  const colors = useColors();
  const t = useT();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);

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
      <EngineAccountsSections />
    </ScrollView>
  );
}

/**
 * One provider's accounts, with no screen chrome of its own.
 *
 * The sheet's engine control already says which provider the user means, so
 * the accounts belong under that choice rather than as two stacked sections
 * listing both. `stella` runs on Stella's own capacity and has nothing to
 * connect, so it renders nothing.
 */
export function EngineAccountSection({
  provider,
  embedded = false,
}: {
  provider: EngineProvider | "stella";
  /** Rows only, laid inside a card that already frames and names them. */
  embedded?: boolean;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const settingsStyles = useMemo(() => makeSettingsStyles(colors), [colors]);
  const { value: settings } = useBackendView("engines.get", {});
  const section = SECTIONS.find((entry) => entry.provider === provider);
  if (!section) return null;
  return (
    <ProviderSection
      section={section}
      settings={settings}
      styles={styles}
      settingsStyles={settingsStyles}
      colors={colors}
      showHeader={false}
      embedded={embedded}
    />
  );
}

/**
 * Both providers at once, for the standalone Claude & ChatGPT screen where
 * there is no engine control to scope them.
 */
export function EngineAccountsSections() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const settingsStyles = useMemo(() => makeSettingsStyles(colors), [colors]);
  const { value: settings } = useBackendView("engines.get", {});
  return (
    <>
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
    </>
  );
}

export type EngineConnectOptions = {
  /** ChatGPT: sign a saved cloud account in again. */
  accountId?: string;
  /** ChatGPT: ask for plan-use consent again. */
  enablePlanUsage?: boolean;
  /** ChatGPT: reuse a client another of the owner's hosts registered. */
  clientId?: string;
  /** Claude: pre-fill Anthropic's sign-in page with this login. */
  email?: string;
};

/**
 * Cloud sign-in shared by Settings and onboarding. Both paste back:
 * Claude: the cloud's `claude auth login` waits for the code Anthropic's page
 * shows; ChatGPT lands on an address that doesn't load, which the server
 * finishes for Stella's cloud. `connectId` names the attempt waiting for the
 * paste (the cloud login's id for Claude, the server's attempt for ChatGPT).
 */
export function useEngineConnect(
  provider: EngineProvider,
  { onConnected }: { onConnected?: () => void } = {},
) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [connectId, setConnectId] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  /** The pasteboard holds something; what, we haven't looked. */
  const [clipboardReady, setClipboardReady] = useState(false);
  /** The user asked to type it themselves, or the clipboard let us down. */
  const [manualEntry, setManualEntry] = useState(false);
  const onConnectedRef = useRef(onConnected);
  /** The provider's sign-in page of the attempt in progress. */
  const authorizeUrl = useRef<string | null>(null);
  /** The options of the attempt in progress, for "Start again". */
  const lastOptions = useRef<EngineConnectOptions>({});
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

  /**
   * Whether the pasteboard plausibly holds the thing we're waiting for.
   *
   * `hasStringAsync` answers from the pasteboard's declared types without
   * reading it, so it never trips iOS's "Allow Paste?" banner. Reading only
   * happens when the user commits, which is the one moment they expect it.
   */
  const refreshClipboardCandidate = useCallback(async () => {
    const has = await Clipboard.hasStringAsync().catch(() => false);
    setClipboardReady(has);
  }, []);

  const openAuthorizePage = async (url: string) => {
    await WebBrowser.openBrowserAsync(url, {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
    });
    await refreshClipboardCandidate();
  };

  const resetAttempt = () => {
    authorizeUrl.current = null;
    setConnectId(null);
    setPasted("");
    setManualEntry(false);
    setClipboardReady(false);
  };

  /** Tell the server to drop an attempt; it may already be gone. */
  const abandon = (attempt: string) => {
    const client = getBackendClient();
    void (
      provider === "chatgpt"
        ? client.call("engines.cancelConnect", { connectId: attempt })
        : client.call("engines.cancelClaudeCloudLogin", { loginId: attempt })
    ).catch(() => {});
  };

  /** Begin a cloud sign-in. */
  const startConnect = (options: EngineConnectOptions = {}) =>
    void run(async () => {
      lastOptions.current = options;
      setPasted("");
      setManualEntry(false);
      if (provider === "chatgpt") {
        const started = await getBackendClient().call("engines.startConnect", {
          provider: "chatgpt",
          ...(options.accountId ? { accountId: options.accountId } : {}),
          ...(options.clientId ? { clientId: options.clientId } : {}),
          ...(options.enablePlanUsage ? { enablePlanUsage: true } : {}),
        });
        authorizeUrl.current = started.authorizeUrl;
        setConnectId(started.connectId);
        await openAuthorizePage(started.authorizeUrl);
        return;
      }
      const started = await getBackendClient().call(
        "engines.startClaudeCloudLogin",
        options.email ? { email: options.email } : {},
      );
      authorizeUrl.current = started.authorizeUrl;
      setConnectId(started.loginId);
      await openAuthorizePage(started.authorizeUrl);
    });

  const finishChatGpt = (attempt: string, input: string) =>
    void run(async () => {
      const result = await getBackendClient().call("engines.finishConnect", {
        connectId: attempt,
        pastedInput: input,
      });
      resetAttempt();
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

  /**
   * Hand the code to the cloud's waiting `claude auth login`. A wrong code
   * ends that login, so a failure shows the CLI's own message and offers to
   * start again.
   */
  const finishClaude = (attempt: string, code: string) => {
    void (async () => {
      setBusy(true);
      try {
        await getBackendClient().call("engines.finishClaudeCloudLogin", {
          loginId: attempt,
          code,
        });
        resetAttempt();
        onConnectedRef.current?.();
      } catch (error) {
        Alert.alert(
          t("mobile.engineAccounts.errorTitle"),
          errorMessage(error, t("mobile.engineAccounts.errorBody")),
          [
            {
              text: t("mobile.common.cancel"),
              style: "cancel",
              onPress: () => {
                abandon(attempt);
                resetAttempt();
              },
            },
            {
              text: t("mobile.engineAccounts.startAgain"),
              onPress: () => {
                abandon(attempt);
                resetAttempt();
                startConnect(lastOptions.current);
              },
            },
          ],
        );
      } finally {
        setBusy(false);
      }
    })();
  };

  const submitConnect = (input: string) => {
    const value = input.trim();
    if (!connectId || !value) return;
    if (provider === "chatgpt") finishChatGpt(connectId, value);
    else finishClaude(connectId, value);
  };

  const finishConnect = () => submitConnect(pasted);

  const cancelConnect = () => {
    if (connectId) abandon(connectId);
    resetAttempt();
  };

  const pasteFromClipboard = async () => {
    const clip = await Clipboard.getStringAsync().catch(() => "");
    if (clip) setPasted(clip.trim());
  };

  /**
   * Commit straight from the pasteboard. This is the only place the clipboard
   * is actually read, and it is a direct response to the user pressing
   * Connect. If it turns out to hold nothing usable, the field appears with
   * whatever was there so they can fix it rather than being told off.
   */
  const connectFromClipboard = () => {
    void (async () => {
      const clip = (await Clipboard.getStringAsync().catch(() => "")).trim();
      if (!clip) {
        setClipboardReady(false);
        setManualEntry(true);
        return;
      }
      setPasted(clip);
      submitConnect(clip);
    })();
  };

  const revealManualEntry = () => setManualEntry(true);

  /** Open the sign-in page of the attempt again. */
  const reopenAuthorizePage = () => {
    const url = authorizeUrl.current;
    if (url) void run(() => openAuthorizePage(url));
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
    clipboardReady,
    manualEntry,
    revealManualEntry,
    connectFromClipboard,
    refreshClipboardCandidate,
    reopenAuthorizePage,
  };
}

type RowAction = {
  id: string;
  title: string;
  systemImage: NonNullable<NativeMenuItem["systemImage"]>;
  destructive?: boolean;
  onPress: () => void;
};

function ProviderSection({
  section,
  settings,
  styles,
  settingsStyles,
  colors,
  showHeader = true,
  embedded = false,
}: {
  section: Section;
  settings: EngineSettings | undefined;
  styles: ReturnType<typeof makeStyles>;
  settingsStyles: ReturnType<typeof makeSettingsStyles>;
  colors: Colors;
  /**
   * Off where only one provider can be on screen and something else already
   * named it — the connect row says "Add Claude account" under an engine
   * control that says Claude, so a "Claude" header is the word three times.
   * On where both providers stack and the headers are what tells them apart.
   */
  showHeader?: boolean;
  /**
   * Inside a provider card: the rows sit flush under a hairline instead of
   * in their own rounded group, and the side notes take the card's inset.
   */
  embedded?: boolean;
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
    clipboardReady,
    manualEntry,
    refreshClipboardCandidate,
  } = connect;

  // The code is copied in another app, so re-check on the way back. This asks
  // whether the pasteboard has anything, never what.
  useEffect(() => {
    if (!connectId) return;
    void refreshClipboardCandidate();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void refreshClipboardCandidate();
    });
    return () => sub.remove();
  }, [connectId, refreshClipboardCandidate]);

  // An attempt abandoned by leaving the screen cleans itself up, so the
  // server-side sign-in isn't left dangling.
  const cancelRef = useRef(cancelConnect);
  cancelRef.current = cancelConnect;
  useEffect(() => () => cancelRef.current(), []);

  /** Nothing usable on the pasteboard, or they chose to type it themselves. */
  const showField = manualEntry || !clipboardReady || pasted.trim().length > 0;
  const accounts = (settings?.connections ?? []).filter(
    (row) => row.provider === section.provider,
  );
  const chatgpt = section.provider === "chatgpt";
  const registrations = chatgpt ? reusableChatGptRegistrations(settings) : [];

  const switchToAccount = (row: EngineConnection) => {
    tapLight();
    void run(() =>
      getBackendClient().call("engines.setActiveAccount", {
        provider: section.provider,
        accountId: row.accountId,
      }),
    );
  };

  /** Whether a row can become the account in use. */
  const canUse = (row: EngineConnection): boolean =>
    !row.active && (!chatgpt || isEngineConnectionUsable(row));

  const confirm = (
    title: string,
    body: string,
    actionLabel: string,
    action: () => Promise<unknown>,
  ) => {
    Alert.alert(title, body, [
      { text: t("mobile.common.cancel"), style: "cancel" },
      {
        text: actionLabel,
        style: "destructive",
        onPress: () => void run(action),
      },
    ]);
  };

  /** ChatGPT: sign the cloud out, keeping the registration. */
  const signOutChatGpt = (row: EngineConnection) => {
    const name = row.email ?? row.label;
    confirm(
      t("mobile.engineAccounts.signOutTitle", { name }),
      t("mobile.engineAccounts.signOutBody"),
      t("mobile.engineAccounts.signOut"),
      async () => {
        const result = await getBackendClient().call("engines.disconnect", {
          provider: "chatgpt",
          accountId: row.accountId,
        });
        if (result && !result.revoked) {
          Alert.alert(
            t("mobile.engineAccounts.statusSignedOut"),
            t("mobile.engineAccounts.revokeUnconfirmed"),
          );
        }
      },
    );
  };

  /** Claude: `claude auth logout` for this account in the cloud. */
  const signOutClaudeCloud = (row: EngineConnection) => {
    const name = row.email ?? row.label;
    confirm(
      t("mobile.engineAccounts.signOutCloudTitle", { name }),
      t("mobile.engineAccounts.signOutCloudBody"),
      t("mobile.engineAccounts.signOutCloud"),
      () =>
        getBackendClient().call("engines.signOutClaudeCloud", {
          accountId: row.accountId,
        }),
    );
  };

  /** Forget the account (ChatGPT: registration included). */
  const remove = (row: EngineConnection) => {
    const name = row.email ?? row.label;
    confirm(
      t("mobile.engineAccounts.removeTitle", { name }),
      chatgpt
        ? t("mobile.engineAccounts.removeBody")
        : t("mobile.engineAccounts.removeClaudeBody"),
      t("mobile.engineAccounts.remove"),
      () =>
        getBackendClient().call("engines.disconnect", {
          provider: section.provider,
          accountId: row.accountId,
          ...(chatgpt ? { forget: true } : {}),
        }),
    );
  };

  /** What a row's menu offers, by the account's state. */
  const rowActions = (row: EngineConnection): RowAction[] => {
    const actions: RowAction[] = [];
    if (canUse(row)) {
      actions.push({
        id: "use",
        title: t("mobile.engineAccounts.useAccount"),
        systemImage: "checkmark.circle",
        onPress: () => switchToAccount(row),
      });
    }
    if (!chatgpt) {
      if (!hasCloudLogin(row)) {
        actions.push({
          id: "sign-in-cloud",
          title: t("mobile.engineAccounts.signInCloud"),
          systemImage: "icloud",
          onPress: () =>
            startConnect(row.email ? { email: row.email } : {}),
        });
      } else {
        actions.push({
          id: "sign-out-cloud",
          title: t("mobile.engineAccounts.signOutCloud"),
          systemImage: "icloud.slash",
          destructive: true,
          onPress: () => signOutClaudeCloud(row),
        });
      }
    }
    if (chatgpt && row.status) {
      actions.push({
        id: "sign-in-again",
        title: t("mobile.engineAccounts.signInAgain"),
        systemImage: "arrow.clockwise",
        onPress: () => startConnect({ accountId: row.accountId }),
      });
    }
    if (chatgpt && !row.status && row.planUsage === false) {
      actions.push({
        id: "enable-plan-usage",
        title: t("mobile.engineAccounts.enablePlanUsage"),
        systemImage: "checkmark.shield",
        onPress: () =>
          startConnect({ accountId: row.accountId, enablePlanUsage: true }),
      });
    }
    if (chatgpt && !row.status) {
      actions.push({
        id: "sign-out",
        title: t("mobile.engineAccounts.signOut"),
        systemImage: "rectangle.portrait.and.arrow.right",
        destructive: true,
        onPress: () => signOutChatGpt(row),
      });
    }
    actions.push({
      id: "remove",
      title: t("mobile.engineAccounts.remove"),
      systemImage: "trash",
      destructive: true,
      onPress: () => remove(row),
    });
    return actions;
  };

  /** Claude: where a Claude Code login for the account exists. */
  const placesText = (row: EngineConnection): string => {
    const places = [...(row.places ?? [])].sort(
      (a, b) => (a.kind === "cloud" ? 0 : 1) - (b.kind === "cloud" ? 0 : 1),
    );
    if (places.length === 0) return t("mobile.engineAccounts.notSignedIn");
    const names = places.map((place) =>
      place.kind === "cloud"
        ? t("mobile.engineAccounts.placeCloud")
        : (place.deviceName ?? t("mobile.engineAccounts.placeComputer")),
    );
    return t("mobile.engineAccounts.signedInOn", { places: names.join(", ") });
  };

  const rowSubtitle = (row: EngineConnection): string | undefined => {
    if (!chatgpt) {
      return [row.plan, placesText(row)].filter(Boolean).join(" · ");
    }
    if (row.status === "signed_out") return t("mobile.engineAccounts.statusSignedOut");
    if (row.status === "reauth_required") return t("mobile.engineAccounts.statusReauth");
    if (row.planUsage === false) return t("mobile.engineAccounts.statusPlanUsageOff");
    return row.plan;
  };

  const openFallbackMenu = (row: EngineConnection) => {
    Alert.alert(row.email ?? row.label, undefined, [
      ...rowActions(row).map((action) => ({
        text: action.title,
        ...(action.destructive ? { style: "destructive" as const } : {}),
        onPress: action.onPress,
      })),
      { text: t("mobile.common.cancel"), style: "cancel" as const },
    ]);
  };

  return (
    <View style={embedded ? null : settingsStyles.section}>
      {showHeader ? (
        <Text style={settingsStyles.sectionLabel}>{t(section.titleKey)}</Text>
      ) : null}
      <View style={embedded ? styles.embeddedGroup : settingsStyles.group}>
        {accounts.map((row, index) => {
          const name = row.email ?? row.name ?? row.label;
          const sub = rowSubtitle(row);
          const warn = chatgpt && !isEngineConnectionUsable(row);
          return (
            <Pressable
              key={row.accountId}
              onPress={() => (canUse(row) ? switchToAccount(row) : undefined)}
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
                    style={[settingsStyles.rowSub, warn ? styles.warn : null]}
                    numberOfLines={2}
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
                    separatorBefore: actionIndex > 0 && action.destructive,
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
        {registrations.map((registration, index) => (
          <Pressable
            key={registration.clientId}
            onPress={() => startConnect({ clientId: registration.clientId })}
            disabled={busy || connectId !== null}
            accessibilityRole="button"
            style={({ pressed }) => [
              settingsStyles.row,
              (accounts.length > 0 || index > 0) && settingsStyles.rowDivider,
              pressed && settingsStyles.rowPressed,
              (busy || connectId !== null) && settingsStyles.rowDisabled,
            ]}
          >
            <View style={[styles.avatar, styles.addAvatar]}>
              {registration.who ? (
                <Text style={styles.avatarText}>
                  {accountInitials({
                    email: registration.email,
                    label: registration.who,
                  })}
                </Text>
              ) : (
                <Icon name="message-square" size={16} color={colors.text} />
              )}
            </View>
            <Text style={[settingsStyles.rowLabel, styles.flexLabel]} numberOfLines={1}>
              {registration.who
                ? t("mobile.engineAccounts.continueAsChatgpt", {
                    name: registration.who,
                  })
                : t("mobile.engineAccounts.continueWithChatgpt")}
            </Text>
          </Pressable>
        ))}
        <Pressable
          onPress={() => startConnect()}
          disabled={busy || connectId !== null}
          accessibilityRole="button"
          style={({ pressed }) => [
            settingsStyles.row,
            accounts.length + registrations.length > 0 &&
              settingsStyles.rowDivider,
            pressed && settingsStyles.rowPressed,
            (busy || connectId !== null) && settingsStyles.rowDisabled,
          ]}
        >
          <View style={[styles.avatar, styles.addAvatar]}>
            <Icon name="plus" size={18} color={colors.text} />
          </View>
          <Text style={settingsStyles.rowLabel}>{t(section.connectKey)}</Text>
        </Pressable>
      </View>
      {!chatgpt && !embedded ? (
        <Text style={[settingsStyles.rowSub, styles.sectionNote]}>
          {t("mobile.engineAccounts.claudeNote")}
        </Text>
      ) : null}

      {connectId ? (
        <View
          style={[
            settingsStyles.group,
            settingsStyles.groupGap,
            styles.pasteCard,
            embedded && styles.embeddedPasteCard,
          ]}
        >
          {/* The provider's own page already said to copy the code, so the
              card doesn't repeat it. When the pasteboard already holds
              something there is nothing to fill in either: Connect reads it
              on the way through, and the field only appears if that comes up
              empty or the user asks to type it. */}
          {showField ? (
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
                autoFocus={manualEntry}
                style={styles.pasteInput}
              />
            </View>
          ) : null}
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
              onPress={connect.reopenAuthorizePage}
              disabled={busy}
              hitSlop={8}
              accessibilityRole="button"
            >
              <Text style={settingsStyles.rowSub}>
                {chatgpt
                  ? t("mobile.engineAccounts.openChatgptAgain")
                  : t("mobile.engineAccounts.openClaudeAgain")}
              </Text>
            </Pressable>
            <Pressable
              onPress={showField ? finishConnect : connect.connectFromClipboard}
              disabled={busy || (showField && !pasted.trim())}
              hitSlop={8}
              accessibilityRole="button"
              style={({ pressed }) => [
                (pressed || busy || (showField && !pasted.trim())) &&
                  styles.pressed,
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

      {chatgpt && accounts.length > 0 ? (
        <View
          style={
            embedded
              ? styles.embeddedGroup
              : [settingsStyles.group, settingsStyles.groupGap]
          }
        >
          <Pressable
            onPress={openChatGptUsage}
            accessibilityRole="link"
            style={({ pressed }) => [
              settingsStyles.row,
              pressed && settingsStyles.rowPressed,
            ]}
          >
            <Text style={[settingsStyles.rowLabel, styles.flexLabel]}>
              {t("mobile.engineAccounts.manageUsage")}
            </Text>
            <Icon name="arrow-up-right" size={16} color={colors.textMuted} />
          </Pressable>
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
    warn: { color: colors.danger },
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
    sectionNote: { marginTop: 8, paddingHorizontal: 16 },
    embeddedGroup: {
      borderTopColor: fadeHex(colors.border, 0.8),
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    embeddedPasteCard: { marginBottom: 12, marginHorizontal: 12, marginTop: 0 },
    flexLabel: { flex: 1 },
  });
