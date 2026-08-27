import type { DiscoveryCategory } from '@stella/contracts/discovery'

export type DiscoveryCategoryConfig = {
  id: DiscoveryCategory;
  label: string;
  description: string;
  defaultEnabled: boolean;
  requiresFDA: boolean;
};

export const DISCOVERY_CATEGORIES: DiscoveryCategoryConfig[] = [
  {
    id: "browsing_bookmarks",
    label: "Browsing & Bookmarks",
    description: "Browser history, bookmarks, and saved pages",
    defaultEnabled: true,
    requiresFDA: false,
  },
  {
    id: "dev_environment",
    label: "Development Environment",
    description: "Git config, dotfiles, runtimes, and package managers",
    defaultEnabled: true,
    requiresFDA: false,
  },
  {
    id: "apps_system",
    label: "Apps & System",
    description: "App usage patterns, dock pins, and filesystem signals",
    defaultEnabled: true,
    requiresFDA: true,
  },
  {
    id: "messages_notes",
    label: "Messages & Notes",
    description: "Communication patterns, note titles, calendar density (metadata only)",
    defaultEnabled: false,
    requiresFDA: true,
  },
];

export type BookmarkEntry = {
  title: string;
  url: string;
  folder?: string;
};

export type BrowserBookmarks = {
  browser: string;
  bookmarks: BookmarkEntry[];
  folders: string[];
};

export type SafariData = {
  history: { domain: string; visits: number }[];
  bookmarks: BookmarkEntry[];
};

export type GitConfig = {
  name?: string;
  email?: string;
  defaultBranch?: string;
  aliases: string[];
};

export type DevEnvironmentSignals = {
  gitConfig: GitConfig | null;
  dotfiles: string[];
  runtimes: string[];
  packageManagers: string[];
  wslDetected: boolean;
};

export type AppUsageSummary = {
  app: string;
  durationMinutes: number;
};

export type DockPin = {
  name: string;
  path: string;
};

export type UserIdentitySignal = {
  username?: string;
  fullName?: string;
  homeDirectory?: string;
};

export type DeviceSignals = {
  os: string;
  arch: string;
  model?: string;
  cpu?: string;
  cpuCores?: number;
  memoryGB?: number;
};

export type SystemSignals = {
  userIdentity: UserIdentitySignal | null;
  dockPins: DockPin[];
  appUsage: AppUsageSummary[];
  device: DeviceSignals | null;
};

export type ContactFrequency = {
  identifier: string;
  displayName: string;
  messageCount: number;
};

export type GroupChat = {
  name: string;
  participantCount: number;
};

export type NoteFolder = {
  name: string;
  noteCount: number;
};

export type CalendarSummary = {
  calendarName: string;
  eventCount: number;
  recurringTitles: string[];
};

export type MessagesNotesSignals = {
  contacts: ContactFrequency[];
  groupChats: GroupChat[];
  noteFolders: NoteFolder[];
  calendars: CalendarSummary[];
};
