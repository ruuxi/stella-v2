/**
 * The right sidebar's browser-tab model.
 *
 * Every open destination is its OWN tab — a `{ id, kind, location }` triple.
 * `kind` is which surface it renders (home launcher, a file, an app, the
 * browser); `location` is the specific item (a display-tab id for a file, a
 * `cloud:<appId>` location for an app, `null` for a launcher/list/browser).
 * Two files, two launchers can all coexist as independent tabs, exactly like
 * browser tabs.
 *
 * This sits beside `tab-store` (the artifact viewer registry + panel width)
 * because the two answer different questions: `tab-store` owns *which artifact
 * specs exist*; this store owns *which tabs the sidebar has open and which one
 * is active*.
 */

import { useSyncExternalStore } from "react";
import { uiState } from "@/platform/ui-state";
import { getFileEntries } from "./files-index";
import { displayTabs } from "./tab-store";
import type { DisplayTab, DisplayTabKind } from "./types";

export const SIDEBAR_SECTIONS = [
  "home",
  "files",
  "apps",
  "browser",
  "updates",
  "takeover",
] as const;
// Kept for the sections that render inside the panel body. Home is a real
// in-panel surface (the launcher) rather than an outside-the-panel activity
// view.
export const PANEL_SIDEBAR_SECTIONS = [
  "home",
  "files",
  "apps",
  "browser",
  "updates",
  "takeover",
] as const;

export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];
export type PanelSidebarSection = (typeof PANEL_SIDEBAR_SECTIONS)[number];

export const isSidebarSection = (value: unknown): value is SidebarSection =>
  typeof value === "string" &&
  (SIDEBAR_SECTIONS as readonly string[]).includes(value);

/**
 * Older builds persisted section ids that no longer exist: `tasks` was renamed
 * to `home`, `search` folded into it, `settings` dissolved into dialogs, and
 * `quickchat` (the ephemeral side conversation) was removed outright. They all
 * resolve to the Home launcher so a restored layout keeps the tab — and its
 * place in the strip — instead of silently losing it.
 */
const LEGACY_SECTION_ALIASES: Readonly<Record<string, SidebarSection>> = {
  tasks: "home",
  search: "home",
  settings: "home",
  quickchat: "home",
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

/**
 * A persisted tab's kind, resolved for restore. A retired id becomes its
 * replacement and loses its `location` (that item no longer exists); anything
 * unrecognisable is dropped rather than guessed at.
 */
const restoreTabKind = (
  value: unknown,
): { kind: SidebarSection; keepLocation: boolean } | null => {
  if (isSidebarSection(value)) return { kind: value, keepLocation: true };
  if (typeof value === "string" && Object.hasOwn(LEGACY_SECTION_ALIASES, value))
    return { kind: LEGACY_SECTION_ALIASES[value], keepLocation: false };
  return null;
};

/**
 * Surfaces that only ever have one tab: opening one again focuses the tab
 * already open instead of adding another.
 */
const SINGLE_TAB_SECTIONS: ReadonlySet<SidebarSection> = new Set(["updates"]);

/** Drop repeats of a single-tab surface (layouts saved before the rule). */
const withoutRepeats = (tabs: SidebarTab[]): SidebarTab[] => {
  const seen = new Set<SidebarSection>();
  return tabs.filter((tab) => {
    if (!SINGLE_TAB_SECTIONS.has(tab.kind)) return true;
    if (seen.has(tab.kind)) return false;
    seen.add(tab.kind);
    return true;
  });
};

export type SidebarFileRecord = {
  title: string;
  kind: DisplayTabKind;
  payload?: unknown;
};

/** A single open tab: a surface `kind` plus the specific item it shows. */
export type SidebarTab = {
  id: string;
  kind: SidebarSection;
  /** files → display-tab id; apps → slug; takeover → safe interaction id. */
  location: string | null;
  file?: SidebarFileRecord;
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

const MAX_PERSISTED_FILE_PAYLOAD_CHARS = 32_000;

const fileRecordFrom = (
  title: string,
  kind: DisplayTabKind,
  payload: unknown,
): SidebarFileRecord => {
  if (payload === undefined) return { title, kind };
  const size = JSON.stringify(payload)?.length ?? 0;
  return size <= MAX_PERSISTED_FILE_PAYLOAD_CHARS
    ? { title, kind, payload }
    : { title, kind };
};

const resolveFileRecord = (location: string): SidebarFileRecord | undefined => {
  const spec = (displayTabs.getSnapshot().tabs as DisplayTab[]).find(
    (tab) => tab.id === location,
  );
  if (spec) return fileRecordFrom(spec.title, spec.kind, spec.payload);
  const entry = getFileEntries().find((item) => item.id === location);
  if (entry) return fileRecordFrom(entry.title, entry.kind, entry.payload);
  return undefined;
};

const withLocation = (
  tab: SidebarTab,
  kind: SidebarSection,
  location: string | null,
): SidebarTab => {
  const next: SidebarTab = { id: tab.id, kind, location };
  if (kind !== "files" || location === null) return next;
  if (tab.kind === kind && tab.location === location && tab.file) {
    return { ...next, file: tab.file };
  }
  const file = resolveFileRecord(location);
  return file ? { ...next, file } : next;
};

const readFileRecord = (value: unknown): SidebarFileRecord | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<SidebarFileRecord>;
  if (typeof record.title !== "string" || typeof record.kind !== "string") {
    return undefined;
  }
  return {
    title: record.title,
    kind: record.kind as DisplayTabKind,
    ...(record.payload !== undefined ? { payload: record.payload } : {}),
  };
};

export const fileNameFromDisplayTabId = (location: string): string => {
  const withoutDrive = location.startsWith("drive:")
    ? location.slice("drive:".length)
    : location;
  const separator = withoutDrive.indexOf(":");
  const rest =
    separator > 0 ? withoutDrive.slice(separator + 1) : withoutDrive;
  const first = rest.split("|")[0] ?? rest;
  return first.split(/[\\/]/).filter(Boolean).pop() || first || "File";
};

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
      const restored = restoreTabKind(item);
      if (!restored) continue;
      const loc = restored.keepLocation ? locations[item as string] : undefined;
      tabs.push(
        makeTab(restored.kind, typeof loc === "string" && loc ? loc : null),
      );
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
            if (typeof candidate.id !== "string") continue;
            const restored = restoreTabKind(candidate.kind);
            if (!restored) continue;
            // Human-takeover tabs are deliberately ephemeral. They contain only
            // a safe interaction id (never the capability URL), but restoring a
            // stale sign-in surface after relaunch is still misleading and can
            // accidentally mint fresh access without an explicit user action.
            if (restored.kind === "takeover") continue;
            const location =
              restored.keepLocation &&
              typeof candidate.location === "string" &&
              candidate.location
                ? candidate.location
                : null;
            const file =
              restored.kind === "files" && location !== null
                ? readFileRecord(candidate.file)
                : undefined;
            tabs.push({
              id: candidate.id,
              kind: restored.kind,
              location,
              ...(file ? { file } : {}),
            });
          }
          const kept = withoutRepeats(tabs);
          if (kept.length > 0) {
            const activeTabId =
              typeof record.activeTabId === "string" ? record.activeTabId : null;
            return { tabs: kept, activeTabId: withActive(kept, activeTabId) };
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

let unavailableFileTabs: ReadonlyMap<string, string> = new Map();
const unavailableListeners = new Set<Listener>();

const setUnavailableFileTabs = (next: ReadonlyMap<string, string>): void => {
  unavailableFileTabs = next;
  for (const listener of unavailableListeners) listener();
};

const isFileTabUnavailable = (tab: SidebarTab): boolean =>
  tab.kind === "files" &&
  tab.location !== null &&
  unavailableFileTabs.get(tab.id) === tab.location;

const persist = (next: SidebarSectionsSnapshot): void => {
  if (typeof window === "undefined") return;
  const persistableTabs = next.tabs.filter((tab) => tab.kind !== "takeover");
  const tabs = persistableTabs.length > 0 ? persistableTabs : defaultTabs();
  uiState.setItem(
    STORAGE_KEY_TABS,
    JSON.stringify({
      tabs,
      activeTabId: withActive(tabs, next.activeTabId),
    }),
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
  (tab.location === null && (tab.kind === "files" || tab.kind === "apps")) ||
  isFileTabUnavailable(tab);

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
   *   it is focused — never duplicated. A single-tab surface (Updates) is
   *   focused wherever its one tab is, closing the empty Home tab it was
   *   picked from.
   * - Else, if the active tab is a launcher/list surface (the empty Home
   *   launcher, or a Files/Apps list with nothing drilled in), that SAME tab is
   *   reused in place — selecting an item from a list/launcher is in-place
   *   navigation (Files list → click report.pdf → that tab becomes report.pdf),
   *   preserving its id / order / mounted state.
   * - Otherwise (a concrete content tab is active: a specific file/app, the
   *   browser) a brand-new tab is created, never overwriting it.
   *
   * Always activates the destination and opens the panel.
   */
  openLocation(section: SidebarSection, location: string | null): void {
    const kind = resolveSidebarSection(section);
    const loc = location ?? null;

    // Dedupe concrete items: focus an already-open tab for this exact item.
    if (loc !== null || SINGLE_TAB_SECTIONS.has(kind)) {
      const existing = snapshot.tabs.find(
        (tab) =>
          tab.kind === kind &&
          (SINGLE_TAB_SECTIONS.has(kind) || tab.location === loc),
      );
      if (existing) {
        // Reached from an empty Home tab opened just to get there: switching
        // to the one already open leaves no empty tab behind.
        const active = activeTabOf(snapshot);
        if (
          active &&
          active.id !== existing.id &&
          active.kind === "home" &&
          SINGLE_TAB_SECTIONS.has(kind)
        ) {
          emit({
            tabs: snapshot.tabs.filter((tab) => tab.id !== active.id),
            activeTabId: existing.id,
          });
        } else if (snapshot.activeTabId !== existing.id) {
          emit({ ...snapshot, activeTabId: existing.id });
        }
        displayTabs.setPanelOpen(true);
        return;
      }
    }

    const active = activeTabOf(snapshot);
    if (active && isReusableNavTab(active)) {
      const tabs = snapshot.tabs.map((tab) =>
        tab.id === active.id ? withLocation(tab, kind, loc) : tab,
      );
      emit({ tabs, activeTabId: active.id });
    } else {
      const created = makeTab(kind, loc);
      const tab = withLocation(created, created.kind, created.location);
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
    if (unavailableFileTabs.has(tabId)) {
      const next = new Map(unavailableFileTabs);
      next.delete(tabId);
      setUnavailableFileTabs(next);
    }

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
      tab.id === active.id ? withLocation(tab, tab.kind, location ?? null) : tab,
    );
    emit({ ...snapshot, tabs });
  },

  rememberFile(
    tabId: string,
    location: string,
    title: string,
    kind: DisplayTabKind,
    payload: unknown,
  ): void {
    const tab = snapshot.tabs.find((item) => item.id === tabId);
    if (!tab || tab.kind !== "files" || tab.location !== location) return;
    if (
      tab.file &&
      tab.file.title === title &&
      tab.file.kind === kind &&
      (payload === undefined || tab.file.payload === payload)
    ) {
      return;
    }
    const file =
      payload === undefined && tab.file?.payload !== undefined
        ? { title, kind, payload: tab.file.payload }
        : fileRecordFrom(title, kind, payload);
    emit({
      ...snapshot,
      tabs: snapshot.tabs.map((item) =>
        item.id === tabId ? { ...item, file } : item,
      ),
    });
  },

  retargetFile(tabId: string, from: string, to: string): void {
    const tab = snapshot.tabs.find((item) => item.id === tabId);
    if (!tab || tab.kind !== "files" || tab.location !== from || from === to)
      return;
    emit({
      ...snapshot,
      tabs: snapshot.tabs.map((item) =>
        item.id === tabId ? { ...item, location: to } : item,
      ),
    });
  },

  markFileUnavailable(tabId: string, location: string): void {
    if (unavailableFileTabs.get(tabId) === location) return;
    const next = new Map(unavailableFileTabs);
    next.set(tabId, location);
    setUnavailableFileTabs(next);
  },

  subscribeUnavailable(listener: Listener): () => void {
    unavailableListeners.add(listener);
    return () => unavailableListeners.delete(listener);
  },

  getUnavailableSnapshot(): ReadonlyMap<string, string> {
    return unavailableFileTabs;
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

export const useSidebarFileUnavailable = (
  tabId: string | undefined,
  location: string | null,
): boolean =>
  useSyncExternalStore(
    sidebarSections.subscribeUnavailable,
    () =>
      tabId !== undefined &&
      location !== null &&
      sidebarSections.getUnavailableSnapshot().get(tabId) === location,
    () => false,
  );

export const useSidebarTab = (tabId: string | undefined): SidebarTab | null =>
  useSyncExternalStore(
    sidebarSections.subscribe,
    () =>
      tabId === undefined
        ? null
        : (sidebarSections.getSnapshot().tabs.find((tab) => tab.id === tabId) ??
          null),
    () => null,
  );

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
