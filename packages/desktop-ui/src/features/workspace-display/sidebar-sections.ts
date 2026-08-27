/**
 * The right sidebar's browser-tab model.
 *
 * Every open destination is its OWN tab — a `{ id, kind, location }` triple.
 * `kind` is which surface it renders (home launcher, quick chat, a file, an
 * app, the browser); `location` is the specific item (a display-tab id for a
 * file, a user-app slug for an app, `null` for a launcher/list/browser). Two
 * files, two quick chats, two launchers can all coexist as independent tabs,
 * exactly like browser tabs.
 *
 * This sits beside `tab-store` (the artifact viewer registry + panel width)
 * because the two answer different questions: `tab-store` owns *which artifact
 * specs exist*; this store owns *which tabs the sidebar has open and which one
 * is active*.
 */

import { useSyncExternalStore } from "react";
import { uiState } from "@/platform/ui-state";
import { displayTabs } from "./tab-store";

export const SIDEBAR_SECTIONS = [
  "home",
  "quickchat",
  "files",
  "apps",
  "browser",
] as const;
// Kept for the sections that render inside the panel body. Home is a real
// in-panel surface (the launcher) rather than an outside-the-panel activity
// view.
export const PANEL_SIDEBAR_SECTIONS = [
  "home",
  "quickchat",
  "files",
  "apps",
  "browser",
] as const;

export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];
export type PanelSidebarSection = (typeof PANEL_SIDEBAR_SECTIONS)[number];

export const isSidebarSection = (value: unknown): value is SidebarSection =>
  typeof value === "string" &&
  (SIDEBAR_SECTIONS as readonly string[]).includes(value);

/**
 * Older builds persisted section ids that no longer exist: `tasks` was renamed
 * to `home`, `search` folded into it, and `settings` dissolved into dialogs.
 */
const LEGACY_SECTION_ALIASES: Readonly<Record<string, SidebarSection>> = {
  tasks: "home",
  search: "home",
  settings: "home",
};

export const LEGACY_SIDEBAR_SECTION_IDS = Object.keys(
  LEGACY_SECTION_ALIASES,
) as readonly string[];

/** Every id the sidebar can be pointed at, resolved to one that exists. */
export const resolveSidebarSection = (value: unknown): SidebarSection => {
  if (isSidebarSection(value)) return value;
  if (typeof value === "string" && Object.hasOwn(LEGACY_SECTION_ALIASES, value))
    return LEGACY_SECTION_ALIASES[value];
  return "home";
};

/** A single open tab: a surface `kind` plus the specific item it shows. */
export type SidebarTab = {
  id: string;
  kind: SidebarSection;
  /** files → display-tab id; apps → local slug or `cloud:<appId>`; otherwise null. */
  location: string | null;
};

export type SidebarSectionsSnapshot = {
  tabs: SidebarTab[];
  activeTabId: string | null;
};

type Listener = () => void;

const STORAGE_KEY_TABS = "stella.sidebar.tabs";
// Legacy keys used only to migrate a pre-per-item layout on first load.
const STORAGE_KEY_SECTION = "stella.sidebar.activeSection";
const STORAGE_KEY_LOCATIONS = "stella.sidebar.sectionLocations";
const STORAGE_KEY_OPEN_TABS = "stella.sidebar.openTabs";

const createTabId = (): string =>
  typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? `tab-${crypto.randomUUID()}`
    : `tab-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

const makeTab = (
  kind: SidebarSection,
  location: string | null = null,
): SidebarTab => ({
  id: createTabId(),
  kind: resolveSidebarSection(kind),
  location: location ?? null,
});

const defaultTabs = (): SidebarTab[] => [makeTab("home")];

type PersistedState = { tabs: SidebarTab[]; activeTabId: string | null };

const withActive = (tabs: SidebarTab[], activeTabId: string | null): string => {
  if (activeTabId && tabs.some((tab) => tab.id === activeTabId)) {
    return activeTabId;
  }
  return tabs[tabs.length - 1]?.id ?? tabs[0]!.id;
};

/** Migrate the previous section-keyed layout into per-item tabs, once. */
const migrateLegacyTabs = (): PersistedState | null => {
  if (typeof window === "undefined") return null;
  const rawOpenTabs = uiState.getItem(STORAGE_KEY_OPEN_TABS);
  if (!rawOpenTabs) return null;
  try {
    const parsedOpen: unknown = JSON.parse(rawOpenTabs);
    if (!Array.isArray(parsedOpen)) return null;
    const rawLocations = uiState.getItem(STORAGE_KEY_LOCATIONS);
    const locations: Record<string, unknown> = rawLocations
      ? (JSON.parse(rawLocations) as Record<string, unknown>)
      : {};
    const activeSection = resolveSidebarSection(
      uiState.getItem(STORAGE_KEY_SECTION),
    );
    const tabs: SidebarTab[] = [];
    for (const item of parsedOpen) {
      if (!isSidebarSection(item)) continue;
      const loc = locations[item];
      tabs.push(makeTab(item, typeof loc === "string" && loc ? loc : null));
    }
    if (tabs.length === 0) return null;
    const active =
      tabs.find((tab) => tab.kind === activeSection) ?? tabs[tabs.length - 1]!;
    return { tabs, activeTabId: active.id };
  } catch {
    return null;
  }
};

const readPersistedState = (): PersistedState => {
  if (typeof window === "undefined") {
    return { tabs: defaultTabs(), activeTabId: null };
  }
  const raw = uiState.getItem(STORAGE_KEY_TABS);
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        const record = parsed as { tabs?: unknown; activeTabId?: unknown };
        if (Array.isArray(record.tabs)) {
          const tabs: SidebarTab[] = [];
          for (const entry of record.tabs) {
            if (!entry || typeof entry !== "object") continue;
            const candidate = entry as Partial<SidebarTab>;
            if (
              typeof candidate.id !== "string" ||
              !isSidebarSection(candidate.kind)
            ) {
              continue;
            }
            tabs.push({
              id: candidate.id,
              kind: candidate.kind,
              location:
                typeof candidate.location === "string" && candidate.location
                  ? candidate.location
                  : null,
            });
          }
          if (tabs.length > 0) {
            const activeTabId =
              typeof record.activeTabId === "string" ? record.activeTabId : null;
            return { tabs, activeTabId: withActive(tabs, activeTabId) };
          }
        }
      }
    } catch {
      // fall through to migration / default
    }
  }
  const migrated = migrateLegacyTabs();
  if (migrated) return migrated;
  const tabs = defaultTabs();
  return { tabs, activeTabId: tabs[0]!.id };
};

let snapshot: SidebarSectionsSnapshot = readPersistedState();
if (snapshot.activeTabId === null) {
  snapshot = { ...snapshot, activeTabId: withActive(snapshot.tabs, null) };
}

const listeners = new Set<Listener>();

const persist = (next: SidebarSectionsSnapshot): void => {
  if (typeof window === "undefined") return;
  uiState.setItem(
    STORAGE_KEY_TABS,
    JSON.stringify({ tabs: next.tabs, activeTabId: next.activeTabId }),
  );
};

const emit = (next: SidebarSectionsSnapshot): void => {
  snapshot = next;
  persist(next);
  for (const listener of listeners) listener();
};

const activeTabOf = (state: SidebarSectionsSnapshot): SidebarTab | null =>
  state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;

/**
 * A tab that shows a launcher/list rather than a concrete item, so selecting an
 * item from it is in-place navigation (reuse the tab) rather than a new tab:
 * the empty Home launcher, or a Files/Apps list with nothing drilled in.
 */
const isReusableNavTab = (tab: SidebarTab): boolean =>
  tab.kind === "home" ||
  (tab.location === null && (tab.kind === "files" || tab.kind === "apps"));

export const sidebarSections = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot(): SidebarSectionsSnapshot {
    return snapshot;
  },

  /** The active tab, or null when the (empty) panel has none. */
  getActiveTab(): SidebarTab | null {
    return activeTabOf(snapshot);
  },

  /**
   * Open a NEW empty Home tab (the browser "+") and activate it, WITHOUT
   * touching the current tab. Opens the panel.
   */
  openHomeLauncher(): void {
    const tab = makeTab("home");
    emit({ tabs: [...snapshot.tabs, tab], activeTabId: tab.id });
    displayTabs.setPanelOpen(true);
  },

  /**
   * Open an item as a tab.
   *
   * - If a tab for this exact concrete item (kind + location) is already open,
   *   it is focused — never duplicated.
   * - Else, if the active tab is a launcher/list surface (the empty Home
   *   launcher, or a Files/Apps list with nothing drilled in), that SAME tab is
   *   reused in place — selecting an item from a list/launcher is in-place
   *   navigation (Files list → click report.pdf → that tab becomes report.pdf),
   *   preserving its id / order / mounted state.
   * - Otherwise (a concrete content tab is active: a specific file/app, quick
   *   chat, browser) a brand-new tab is created, never overwriting it.
   *
   * Always activates the destination and opens the panel.
   */
  openLocation(section: SidebarSection, location: string | null): void {
    const kind = resolveSidebarSection(section);
    const loc = location ?? null;

    // Dedupe concrete items: focus an already-open tab for this exact item.
    if (loc !== null) {
      const existing = snapshot.tabs.find(
        (tab) => tab.kind === kind && tab.location === loc,
      );
      if (existing) {
        if (snapshot.activeTabId !== existing.id) {
          emit({ ...snapshot, activeTabId: existing.id });
        }
        displayTabs.setPanelOpen(true);
        return;
      }
    }

    const active = activeTabOf(snapshot);
    if (active && isReusableNavTab(active)) {
      const tabs = snapshot.tabs.map((tab) =>
        tab.id === active.id ? { ...tab, kind, location: loc } : tab,
      );
      emit({ tabs, activeTabId: active.id });
    } else {
      const tab = makeTab(kind, loc);
      emit({ tabs: [...snapshot.tabs, tab], activeTabId: tab.id });
    }
    displayTabs.setPanelOpen(true);
  },

  /** A Home-launcher option click: open that surface's default (list) view. */
  selectSection(section: SidebarSection): void {
    this.openLocation(section, null);
  },

  /** Switch to an already-open tab by id. */
  activateTab(tabId: string): void {
    if (snapshot.activeTabId === tabId) return;
    if (!snapshot.tabs.some((tab) => tab.id === tabId)) return;
    emit({ ...snapshot, activeTabId: tabId });
  },

  /**
   * Close a tab. Activates a neighbor when the closed tab was active; closing
   * the last tab closes the panel (and reseeds a single Home tab for next open).
   */
  closeTab(tabId: string): void {
    const index = snapshot.tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return;
    const tabs = snapshot.tabs.filter((tab) => tab.id !== tabId);

    if (tabs.length === 0) {
      const seeded = defaultTabs();
      emit({ tabs: seeded, activeTabId: seeded[0]!.id });
      displayTabs.setPanelOpen(false);
      return;
    }

    let activeTabId = snapshot.activeTabId;
    if (activeTabId === tabId) {
      activeTabId = tabs[Math.min(index, tabs.length - 1)]!.id;
    }
    emit({ tabs, activeTabId });
  },

  /**
   * Point the active tab's location (drill within a tab), only when the active
   * tab is of `section`. No-op otherwise — background refreshes for a file the
   * user isn't looking at must not hijack the active tab.
   */
  setLocation(section: SidebarSection, location: string | null): void {
    const kind = resolveSidebarSection(section);
    const active = activeTabOf(snapshot);
    if (!active || active.kind !== kind) return;
    if (active.location === (location ?? null)) return;
    const tabs = snapshot.tabs.map((tab) =>
      tab.id === active.id ? { ...tab, location: location ?? null } : tab,
    );
    emit({ ...snapshot, tabs });
  },

  /** Return the active `section` tab to its default list view. */
  clearLocation(section: SidebarSection): void {
    this.setLocation(section, null);
  },

  reset(): void {
    const tabs = defaultTabs();
    emit({ tabs, activeTabId: tabs[0]!.id });
  },
};

export const useSidebarSections = (): SidebarSectionsSnapshot =>
  useSyncExternalStore(
    sidebarSections.subscribe,
    sidebarSections.getSnapshot,
    sidebarSections.getSnapshot,
  );

/** The active tab's kind (or `home` when there is somehow no active tab). */
export const useActiveSidebarSection = (): SidebarSection =>
  useSyncExternalStore(
    sidebarSections.subscribe,
    () => activeTabOf(sidebarSections.getSnapshot())?.kind ?? "home",
    () => activeTabOf(sidebarSections.getSnapshot())?.kind ?? "home",
  );

/**
 * The active tab's location, but only when the active tab is `section`. Used by
 * the shared singleton surfaces (Apps, Browser) that render the active item.
 */
export const useSidebarSectionLocation = (
  section: SidebarSection,
): string | null => {
  const resolved = resolveSidebarSection(section);
  return useSyncExternalStore(
    sidebarSections.subscribe,
    () => {
      const active = activeTabOf(sidebarSections.getSnapshot());
      return active && active.kind === resolved ? active.location : null;
    },
    () => {
      const active = activeTabOf(sidebarSections.getSnapshot());
      return active && active.kind === resolved ? active.location : null;
    },
  );
};

/** The ordered list of open tabs (the browser-tab strip). */
export const useSidebarOpenTabs = (): SidebarTab[] =>
  useSyncExternalStore(
    sidebarSections.subscribe,
    () => sidebarSections.getSnapshot().tabs,
    () => sidebarSections.getSnapshot().tabs,
  );

/** The active tab's id (drives per-tab body visibility). */
export const useSidebarActiveTabId = (): string | null =>
  useSyncExternalStore(
    sidebarSections.subscribe,
    () => sidebarSections.getSnapshot().activeTabId,
    () => sidebarSections.getSnapshot().activeTabId,
  );
