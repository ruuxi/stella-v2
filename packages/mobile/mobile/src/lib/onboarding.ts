import AsyncStorage from "@react-native-async-storage/async-storage";

const ONBOARDING_SEEN_KEY = "stella-mobile:onboarding-seen";

let cachedSeen: boolean | null = null;

export async function loadOnboardingSeen(): Promise<boolean> {
  if (cachedSeen !== null) return cachedSeen;
  cachedSeen = (await AsyncStorage.getItem(ONBOARDING_SEEN_KEY)) === "1";
  return cachedSeen;
}

export function hasSeenOnboarding(): boolean {
  return cachedSeen === true;
}

export async function markOnboardingSeen(): Promise<void> {
  cachedSeen = true;
  await AsyncStorage.setItem(ONBOARDING_SEEN_KEY, "1");
}
