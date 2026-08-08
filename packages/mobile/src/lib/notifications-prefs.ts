import AsyncStorage from "@react-native-async-storage/async-storage";

const MUTED_STORAGE_KEY = "stella-mobile_notifications.muted";

type Listener = (muted: boolean) => void;

let muted = false;
let hydrated = false;
const listeners = new Set<Listener>();

export function getNotificationsMuted(): boolean {
  return muted;
}

export function notificationsHydrated(): boolean {
  return hydrated;
}

export async function loadNotificationsMuted(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(MUTED_STORAGE_KEY);
    muted = raw === "1";
  } catch {
    muted = false;
  }
  hydrated = true;
  for (const fn of listeners) fn(muted);
  return muted;
}

export async function setNotificationsMuted(next: boolean): Promise<void> {
  muted = next;
  hydrated = true;
  try {
    if (next) {
      await AsyncStorage.setItem(MUTED_STORAGE_KEY, "1");
    } else {
      await AsyncStorage.removeItem(MUTED_STORAGE_KEY);
    }
  } catch {
    // ignore — in-memory value still wins until next reload
  }
  for (const fn of listeners) fn(muted);
}

export function subscribeNotificationsMuted(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
