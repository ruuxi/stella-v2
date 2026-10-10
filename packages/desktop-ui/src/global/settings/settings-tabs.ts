import {
  AudioLines,
  Keyboard,
  Lock,
  Settings,
  User,
  type IconComponent,
} from "@/ui/icons";

export const SETTINGS_TAB_KEYS = [
  "general",
  "audio",
  "shortcuts",
  "account",
  "privacy",
] as const;

export type SettingsTab = (typeof SETTINGS_TAB_KEYS)[number];

export type SettingsTabDef = {
  key: SettingsTab;
  labelKey: string;
  Icon: IconComponent;
};

/**
 * Tabs are translated at render time via `t("settings.tabs.<key>")` —
 * the source of truth lives in the locale catalogs under
 * `desktop/src/shared/i18n/locales/`. Each entry exposes its i18n key
 * (`labelKey`) so callers don't need to know the catalog layout.
 */
export const SETTINGS_TABS: SettingsTabDef[] = [
  { key: "general", labelKey: "settings.tabs.general", Icon: Settings },
  { key: "audio", labelKey: "settings.tabs.audio", Icon: AudioLines },
  { key: "shortcuts", labelKey: "settings.tabs.shortcuts", Icon: Keyboard },
  { key: "account", labelKey: "settings.tabs.account", Icon: User },
  { key: "privacy", labelKey: "settings.tabs.privacy", Icon: Lock },
];

/**
 * The left rail's sections, in display order. The compact top bar keeps
 * the same order without the section labels.
 */
export const SETTINGS_TAB_GROUPS: {
  labelKey: string;
  tabs: SettingsTab[];
}[] = [
  {
    labelKey: "settings.groups.app",
    tabs: ["general", "audio", "shortcuts"],
  },
  { labelKey: "settings.groups.personal", tabs: ["account", "privacy"] },
];

export const availableSettingsTabs = (website: boolean) =>
  website
    ? SETTINGS_TABS.filter((tab) => tab.key !== "shortcuts")
    : SETTINGS_TABS;
