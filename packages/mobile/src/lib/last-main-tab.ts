import AsyncStorage from "@react-native-async-storage/async-storage";

/** The shell's bottom tabs, in bar order. */
export type MainTabId = "chat" | "schedule" | "apps" | "files" | "settings";

export const MAIN_TAB_HREFS = {
  chat: "/chat",
  schedule: "/schedule",
  apps: "/apps",
  files: "/files",
  settings: "/settings",
} as const satisfies Record<MainTabId, string>;

export type MainTabHref = (typeof MAIN_TAB_HREFS)[MainTabId];

const LAST_MAIN_TAB_KEY = "stella-mobile:last-main-tab";

/** The tab a path belongs to; pages pushed from Settings stay under it. */
export function readMainTabFromPath(pathname: string): MainTabId | null {
  if (pathname === "/chat") return "chat";
  if (pathname === "/schedule") return "schedule";
  if (pathname === "/apps") return "apps";
  if (pathname === "/files") return "files";
  if (pathname === "/settings" || pathname === "/cloud-home") return "settings";
  return null;
}

function parseMainTab(value: string | null): MainTabId | null {
  if (
    value === "chat" ||
    value === "schedule" ||
    value === "apps" ||
    value === "files" ||
    value === "settings"
  ) {
    return value;
  }
  // Account merged into Settings.
  if (value === "account") return "settings";
  return null;
}

export async function loadLastMainTab(): Promise<MainTabId | null> {
  return parseMainTab(await AsyncStorage.getItem(LAST_MAIN_TAB_KEY));
}

export async function loadLastMainTabHref(): Promise<string> {
  const tab = await loadLastMainTab();
  return MAIN_TAB_HREFS[tab ?? "chat"];
}

type MainShellRouter = { replace: (href: MainTabHref) => void };

/** A restored tab waiting for the shell to land on the chat. */
let pendingMainTab: MainTabId | null = null;

/**
 * Enter the `(main)` shell at `href`. The chat always goes in first and the
 * `(main)` layout pushes a restored tab over it once the chat is on screen
 * (see `takePendingMainTab`), so the chat is mounted under every tab from the
 * start: the tabs show what it publishes (files, the paired computer), and
 * "Chat" is a pop back to the same instance rather than a cold mount. Pushing
 * in the same tick as the replace would open a second `(main)` stack.
 */
export function enterMainShell(router: MainShellRouter, href: string): void {
  const tab = readMainTabFromPath(href);
  pendingMainTab = tab && tab !== "chat" ? tab : null;
  router.replace(MAIN_TAB_HREFS.chat);
}

/** The tab `enterMainShell` deferred, once; `null` when there is none. */
export function takePendingMainTab(): MainTabId | null {
  const tab = pendingMainTab;
  pendingMainTab = null;
  return tab;
}

export async function saveLastMainTab(tab: MainTabId): Promise<void> {
  await AsyncStorage.setItem(LAST_MAIN_TAB_KEY, tab);
}
