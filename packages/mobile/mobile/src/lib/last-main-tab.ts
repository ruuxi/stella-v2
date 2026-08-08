import AsyncStorage from "@react-native-async-storage/async-storage";

export type MainTabId = "chat" | "computer" | "account";

export const MAIN_TAB_HREFS: Record<MainTabId, string> = {
  chat: "/chat",
  computer: "/computer",
  account: "/account",
};

const LAST_MAIN_TAB_KEY = "stella-mobile:last-main-tab";

export function readMainTabFromPath(pathname: string): MainTabId | null {
  if (pathname === "/computer") return "computer";
  if (pathname === "/account") return "account";
  if (pathname === "/chat") return "chat";
  return null;
}

function parseMainTab(value: string | null): MainTabId | null {
  if (value === "chat" || value === "computer" || value === "account") {
    return value;
  }
  return null;
}

export async function loadLastMainTab(): Promise<MainTabId | null> {
  return parseMainTab(await AsyncStorage.getItem(LAST_MAIN_TAB_KEY));
}

export async function loadLastMainTabHref(): Promise<string> {
  const tab = await loadLastMainTab();
  return MAIN_TAB_HREFS[tab ?? "chat"];
}

export async function saveLastMainTab(tab: MainTabId): Promise<void> {
  await AsyncStorage.setItem(LAST_MAIN_TAB_KEY, tab);
}
