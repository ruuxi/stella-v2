import AsyncStorage from "@react-native-async-storage/async-storage";

const COMPUTER_HINT_SEEN_KEY = "stella-mobile:computer-hint-seen";

export async function hasSeenComputerHint(): Promise<boolean> {
  return (await AsyncStorage.getItem(COMPUTER_HINT_SEEN_KEY)) === "1";
}

export async function markComputerHintSeen(): Promise<void> {
  await AsyncStorage.setItem(COMPUTER_HINT_SEEN_KEY, "1");
}
