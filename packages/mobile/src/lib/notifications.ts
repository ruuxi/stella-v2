import { AppState, Platform } from "react-native";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { router } from "expo-router";
import { postJson } from "./http";
import { getOrCreateMobileDeviceId } from "./phone-access";
import { getNotificationsMuted } from "./notifications-prefs";

const COMPUTER_REPLY_CATEGORY = "computer_reply";
const AGENT_ACTIVITY_CATEGORY = "agent_activity";
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

Notifications.setNotificationHandler({
  handleNotification: async () => {
    // User-side mute wins over everything — drop the notification entirely.
    if (getNotificationsMuted()) {
      return {
        shouldShowAlert: false,
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    }
    // Don't surface pushes over the app the user is currently looking at.
    const isForeground = AppState.currentState === "active";
    if (isForeground) {
      return {
        shouldShowAlert: false,
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    }
    return {
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    };
  },
});

async function getExpoPushToken(): Promise<string | null> {
  if (!Device.isDevice) return null;

  const { status: existing } = await Notifications.getPermissionsAsync();
  let finalStatus = existing;

  if (existing !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== "granted") return null;

  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  if (!projectId) return null;

  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  return data;
}

let registered = false;

/** Register for push notifications and send the token to the backend. */
export async function registerForPushNotifications(): Promise<void> {
  if (registered) return;

  try {
    const token = await getExpoPushToken();
    if (!token) return;

    const mobileDeviceId = await getOrCreateMobileDeviceId();
    await postJson("/api/mobile/push-token", {
      token,
      platform: Platform.OS,
      mobileDeviceId,
    });
    registered = true;
  } catch {
    // Best-effort — don't block the app if registration fails.
  }
}

/** Remove this phone's push token rows for the currently signed-in account. */
export async function unregisterForPushNotifications(): Promise<void> {
  try {
    const mobileDeviceId = await getOrCreateMobileDeviceId();
    await postJson("/api/mobile/push-token/unregister", {
      mobileDeviceId,
    });
    registered = false;
  } catch {
    // Best-effort — sign-out should still work even if the network is down.
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
    ]);
  } catch {
    // Best-effort; some platforms (Expo Go) just don't support categories.
  }

  const subscription = Notifications.addNotificationResponseReceivedListener(
    (response) => {
      const data = response.notification.request.content.data as
        | { kind?: string }
        | null
        | undefined;
      const actionId = response.actionIdentifier;
      if (actionId === "dismiss") {
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
