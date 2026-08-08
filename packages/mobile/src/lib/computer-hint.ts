import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * One-time "discover the Computer tab" hint. We show a small notification dot
 * on the Computer (monitor) icon until the user opens the Computer tab for the
 * first time, then dismiss it permanently.
 */
const COMPUTER_HINT_SEEN_KEY = "stella-mobile:computer-hint-seen";

export async function hasSeenComputerHint(): Promise<boolean> {
  return (await AsyncStorage.getItem(COMPUTER_HINT_SEEN_KEY)) === "1";
}

export async function markComputerHintSeen(): Promise<void> {
  await AsyncStorage.setItem(COMPUTER_HINT_SEEN_KEY, "1");
}
