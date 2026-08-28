export const SETTINGS_TAB_KEYS = [
  "general",
  "shortcuts",
  "backup",
  "account",
  "wallet",
  "audio",
] as const;

export type SettingsTab = (typeof SETTINGS_TAB_KEYS)[number];

export const SETTINGS_TABS: { key: SettingsTab; labelKey: string }[] = [
  { key: "general", labelKey: "settings.tabs.general" },
  { key: "shortcuts", labelKey: "settings.tabs.shortcuts" },
  { key: "backup", labelKey: "settings.tabs.backup" },
  { key: "account", labelKey: "settings.tabs.account" },
  { key: "wallet", labelKey: "settings.tabs.wallet" },
  { key: "audio", labelKey: "settings.tabs.audio" },
];
