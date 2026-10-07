import { AppState, Platform } from "react-native";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { router } from "expo-router";
import {
  USER_ASK_MAX_URGENCY,
  USER_ASK_PUSH_CATEGORY,
  USER_ASK_PUSH_KIND,
  clampUrgency,
  type UserAskUrgencyLevel,
} from "@stella/contracts/user-ask";
import { backendOrigin, postJson } from "./http";
import { getOrCreateMobileDeviceId } from "./phone-access";
import { getNotificationsMuted } from "./notifications-prefs";
import { focusUserAsk, getOpenUserAsks, refreshUserAsks } from "./user-asks";
import { i18nFallback } from "../i18n";

const COMPUTER_REPLY_CATEGORY = "computer_reply";
const AGENT_ACTIVITY_CATEGORY = "agent_activity";
const USER_ASK_ANDROID_CHANNEL = "user-ask";
const USER_ASK_ANDROID_BREAKTHROUGH_CHANNEL = "user-ask-breakthrough";

const SILENT = {
  shouldShowAlert: false,
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
} as const;
const NOTIFICATION_ACTIONS = [
  {
    identifier: "open",
    buttonTitle: "Open",
    options: { opensAppToForeground: true },
  },
  {
    identifier: "dismiss",
    buttonTitle: "Dismiss",
    options: { opensAppToForeground: false, isDestructive: false },
  },
];

const USER_ASK_ACTIONS = [
  {
    identifier: "answer",
    buttonTitle: i18nFallback.t("mobile.userAsk.notification.answer"),
    options: { opensAppToForeground: true },
  },
  {
    identifier: "dismiss",
    buttonTitle: i18nFallback.t("mobile.userAsk.notification.dismiss"),
    options: { opensAppToForeground: false, isDestructive: false },
  },
];

const USER_ASK_REPEAT_COUNT = 3;
const USER_ASK_REPEAT_INTERVAL_MS = 60_000;

type UserAskPushData = {
  kind?: string;
  askId?: string;
  conversationId?: string;
  level?: number | string;
};

const readUserAskPush = (
  data: UserAskPushData | null | undefined,
): { askId: string; level: UserAskUrgencyLevel } | null => {
  if (!data || data.kind !== USER_ASK_PUSH_KIND) return null;
  const askId = typeof data.askId === "string" ? data.askId.trim() : "";
  if (!askId) return null;
  return { askId, level: clampUrgency(data.level) };
};

const repeatTimers = new Map<string, ReturnType<typeof setTimeout>[]>();

const stopUserAskRepeats = (askId: string) => {
  for (const timer of repeatTimers.get(askId) ?? []) clearTimeout(timer);
  repeatTimers.delete(askId);
};

const scheduleUserAskRepeats = (askId: string) => {
  stopUserAskRepeats(askId);
  if (getNotificationsMuted()) return;
  const timers: ReturnType<typeof setTimeout>[] = [];
  for (let attempt = 1; attempt <= USER_ASK_REPEAT_COUNT; attempt += 1) {
    timers.push(
      setTimeout(() => {
        void (async () => {
          if (getNotificationsMuted()) {
            stopUserAskRepeats(askId);
            return;
          }
          await refreshUserAsks().catch(() => undefined);
          const stillOpen = getOpenUserAsks().some(
            (ask) => ask.askId === askId,
          );
          if (!stillOpen) {
            stopUserAskRepeats(askId);
            return;
          }
          try {
            await Notifications.scheduleNotificationAsync({
              content: {
                title: i18nFallback.t("mobile.userAsk.notification.title"),
                body: i18nFallback.t("mobile.userAsk.notification.body"),
                categoryIdentifier: USER_ASK_PUSH_CATEGORY,
                data: { kind: USER_ASK_PUSH_KIND, askId },
                interruptionLevel: "timeSensitive",
                sound: true,
              },
              trigger: null,
            });
          } catch {
            return;
          }
        })();
      }, attempt * USER_ASK_REPEAT_INTERVAL_MS),
    );
  }
  repeatTimers.set(askId, timers);
};

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    if (!pushDeliveryEnabled()) return { ...SILENT };
    // User-side mute wins over everything — drop the notification entirely.
    if (getNotificationsMuted()) return { ...SILENT };
    const ask = readUserAskPush(
      notification.request.content.data as UserAskPushData | null | undefined,
    );
    if (ask) {
      void refreshUserAsks();
      if (ask.level >= USER_ASK_MAX_URGENCY) {
        scheduleUserAskRepeats(ask.askId);
        return {
          shouldShowAlert: true,
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        };
      }
    }
    // Don't surface pushes over the app the user is currently looking at.
    const isForeground = AppState.currentState === "active";
    if (isForeground) return { ...SILENT };
    return {
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    };
  },
});

async function ensureAndroidChannels(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync("default", {
    name: "default",
    importance: Notifications.AndroidImportance.DEFAULT,
  });
  await Notifications.setNotificationChannelAsync(USER_ASK_ANDROID_CHANNEL, {
    name: "Stella needs you",
    importance: Notifications.AndroidImportance.HIGH,
  });
  await Notifications.setNotificationChannelAsync(
    USER_ASK_ANDROID_BREAKTHROUGH_CHANNEL,
    {
      name: "Stella needs you urgently",
      importance: Notifications.AndroidImportance.MAX,
      bypassDnd: true,
    },
  );
}

async function getExpoPushToken(): Promise<string | null> {
  if (!Device.isDevice) return null;

  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;

  if (existing !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== "granted") return null;

  await ensureAndroidChannels();

  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  if (!projectId) return null;

  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  return data;
}

async function readGrantedPushToken(): Promise<string | null> {
  try {
    if (!Device.isDevice) return null;
    const { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") return null;
    const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
    if (!projectId) return null;
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    return data;
  } catch {
    return null;
  }
}

let registeredSubject: string | null = null;
let registering: { subject: string; done: Promise<void> } | null = null;
let deliveryBlocked = false;

export function setPushDeliveryOwner(subject: string | null): void {
  deliveryBlocked = subject === null;
}

export function pushDeliveryEnabled(): boolean {
  return !deliveryBlocked;
}

export function registerForPushNotifications(subject: string): Promise<void> {
  if (!subject) return Promise.resolve();
  if (registeredSubject === subject) return Promise.resolve();
  if (registering?.subject === subject) return registering.done;
  const done = registerOnce(subject).finally(() => {
    if (registering?.subject === subject) registering = null;
  });
  registering = { subject, done };
  return done;
}

async function registerOnce(subject: string): Promise<void> {
  try {
    const token = await getExpoPushToken();
    if (!token) return;

    const mobileDeviceId = await getOrCreateMobileDeviceId();
    await postJson("/api/mobile/push-token", {
      token,
      platform: Platform.OS,
      mobileDeviceId,
    }, { origin: backendOrigin() });
    registeredSubject = subject;
  } catch {
    // Best-effort — don't block the app if registration fails.
  }
}

export async function tearDownPushNotifications(): Promise<void> {
  registeredSubject = null;
  registering = null;
  deliveryBlocked = true;
  for (const askId of [...repeatTimers.keys()]) stopUserAskRepeats(askId);
  await Promise.all([
    Notifications.dismissAllNotificationsAsync().catch(() => undefined),
    Notifications.cancelAllScheduledNotificationsAsync().catch(() => undefined),
    Notifications.setBadgeCountAsync(0).catch(() => undefined),
  ]);
  const token = await readGrantedPushToken();
  try {
    const mobileDeviceId = await getOrCreateMobileDeviceId();
    await postJson("/api/mobile/push-token/unregister", {
      mobileDeviceId,
      ...(token ? { token } : {}),
    }, { origin: backendOrigin() });
  } catch {
    // Best-effort — sign-out proceeds, and the server's own teardown covers it.
  }
}

/**
 * Wire up interactive notification categories and a tap handler that
 * routes the user to the right surface when they engage with a push
 * (either via the banner itself or one of the inline actions).
 */
export async function installNotificationCategoriesAndListeners(): Promise<() => void> {
  try {
    await Promise.all([
      Notifications.setNotificationCategoryAsync(
        COMPUTER_REPLY_CATEGORY,
        NOTIFICATION_ACTIONS,
      ),
      Notifications.setNotificationCategoryAsync(
        AGENT_ACTIVITY_CATEGORY,
        NOTIFICATION_ACTIONS,
      ),
      Notifications.setNotificationCategoryAsync(
        USER_ASK_PUSH_CATEGORY,
        USER_ASK_ACTIONS,
      ),
    ]);
  } catch {
    // Best-effort; some platforms (Expo Go) just don't support categories.
  }

  const subscription = Notifications.addNotificationResponseReceivedListener(
    (response) => {
      const data = response.notification.request.content.data as
        | UserAskPushData
        | null
        | undefined;
      if (!pushDeliveryEnabled()) return;
      const actionId = response.actionIdentifier;
      const ask = readUserAskPush(data);
      if (actionId === "dismiss") {
        if (ask) stopUserAskRepeats(ask.askId);
        return;
      }
      if (ask) {
        stopUserAskRepeats(ask.askId);
        focusUserAsk(ask.askId);
        try {
          router.replace("/chat");
        } catch {
          return;
        }
        return;
      }
      if (data?.kind === "computer_reply" || data?.kind === "agent_activity") {
        try {
          router.replace("/computer");
        } catch {
          // Router not yet mounted on cold start; the computer screen will
          // be the natural landing once the user opens the app.
        }
      }
    },
  );

  return () => subscription.remove();
}

/** Get the Expo push notification listener for navigation. */
export const addNotificationResponseListener =
  Notifications.addNotificationResponseReceivedListener;
