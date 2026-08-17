/**
 * The right sidebar's primary sections plus its Settings utility surface,
 * and the "where was I" memory each one keeps.
 *
 * This sits beside `tab-store` rather than inside it because the two answer
 * different questions. `tab-store` owns the *viewer registry*: which artifact
 * specs exist and how wide the panel is. This store owns the *sidebar's
 * navigation*: which section is showing, and for each section,
 * the sub-location the user last had open. Keeping them apart means a payload
 * arriving from an agent can register a viewer without deciding anything about
 * which section the user is looking at.
 *
 * Per-section memory is the whole point of the split. Selecting a section never
 * resets it: reopening Work returns to the item you had open, reopening Apps
 * returns to the running app. Only an explicit in-section back gesture
 * (`clearLocation`) returns a section to its list.
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
// Every section now renders inside the panel body — Home is the panel's
// empty-state launcher (browser-tab "new tab" model) rather than a surface
// that lives outside the panel.
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
 * Older builds persisted section ids that no longer exist: `tasks` was
 * renamed to `home`, `search` was folded into it as an in-view control, and
 * `settings` was dissolved into dialogs (gear, account menu, Home footer).
 */
const LEGACY_SECTION_ALIASES: Readonly<Record<string, SidebarSection>> = {
  tasks: "home",
  search: "home",
  settings: "home",
};

export const LEGACY_SIDEBAR_SECTION_IDS = Object.keys(
  LEGACY_SECTION_ALIASES,
) as readonly string[];

/**
 * Every id the sidebar can be pointed at, resolved to one that exists.
 *
 * Total by construction: a retired id degrades to its successor and anything
 * unrecognizable degrades to `home`, so no caller can leave `activeSection`
 * holding a section with nothing behind it. That matters more than it looks —
 * a section id without a component renders `undefined`, and React treats that
 * as an invalid element type and tears down the whole shell rather than just
 * the panel. Degrading to Home keeps the user's spot instead of resetting it.
 */
export const resolveSidebarSection = (value: unknown): SidebarSection => {
  if (isSidebarSection(value)) return value;
  if (typeof value === "string" && Object.hasOwn(LEGACY_SECTION_ALIASES, value))
    return LEGACY_SECTION_ALIASES[value];
  return "home";
};

export const resolvePanelSidebarSection = (
  section: SidebarSection,
): PanelSidebarSection => section;

/**
 * Per-section sub-location. `null` always means "show this section's default
 * list view".
 *
 * - `home`  — reserved legacy Activity location.
 * - `files` — a display-tab id for an open agent thread or artifact.
 * - `apps`  — a user-app slug.
 */
export type SidebarSectionLocations = {
  home: string | null;
  quickchat: string | null;
  files: string | null;
  apps: string | null;
  browser: string | null;
};

export type SidebarSectionsSnapshot = {
  /** Ordered list of open tabs (browser-tab model). At most one per section. */
  openTabs: SidebarSection[];
  activeSection: SidebarSection;
  locations: SidebarSectionLocations;
};

type Listener = () => void;

const STORAGE_KEY_SECTION = "stella.sidebar.activeSection";
const STORAGE_KEY_LOCATIONS = "stella.sidebar.sectionLocations";
const STORAGE_KEY_OPEN_TABS = "stella.sidebar.openTabs";

const DEFAULT_LOCATIONS: SidebarSectionLocations = {
  home: null,
  quickchat: null,
  files: null,
  apps: null,
  browser: null,
};

const HOME_TAB: SidebarSection = "home";
const DEFAULT_OPEN_TABS: SidebarSection[] = [HOME_TAB];

const readPersistedSection = (): SidebarSection => {
  if (typeof window === "undefined") return "home";
  const raw = uiState.getItem(STORAGE_KEY_SECTION);
  const section = resolveSidebarSection(raw);
  // Rewrite the migrated id rather than re-migrating it every launch, so a
  // retired value cannot outlive the build that retired it.
  if (raw !== null && raw !== section)
    uiState.setItem(STORAGE_KEY_SECTION, section);
  return section;
};

/**
 * Locations are persisted as a whole object. A malformed or partial payload
 * degrades to the default list view rather than throwing — a stale id that no
 * longer resolves to a registered tab is handled at render time by the section
 * itself, which falls back to its list.
 */
const readPersistedLocations = (): SidebarSectionLocations => {
  if (typeof window === "undefined") return DEFAULT_LOCATIONS;
  const raw = uiState.getItem(STORAGE_KEY_LOCATIONS);
  if (!raw) return DEFAULT_LOCATIONS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_LOCATIONS;
    const record = parsed as Record<string, unknown>;
    const pick = (key: string): string | null =>
      typeof record[key] === "string" && record[key]
        ? (record[key] as string)
        : null;
    return {
      // `tasks` is the pre-rename key for the same drill-down location.
      home: pick("home") ?? pick("tasks"),
      quickchat: pick("quickchat"),
      files: pick("files"),
      apps: pick("apps"),
      browser: pick("browser"),
    };
  } catch {
    return DEFAULT_LOCATIONS;
  }
};

/**
 * The open tab list is persisted as an array of section ids. A malformed or
 * legacy payload degrades to a single tab for the active section, and the
 * active section is always guaranteed to be present.
 */
const readPersistedOpenTabs = (
  activeSection: SidebarSection,
): SidebarSection[] => {
  if (typeof window === "undefined") return [activeSection];
  const raw = uiState.getItem(STORAGE_KEY_OPEN_TABS);
  if (!raw) return [activeSection];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [activeSection];
    const seen = new Set<SidebarSection>();
    const tabs: SidebarSection[] = [];
    for (const item of parsed) {
      if (!isSidebarSection(item) || seen.has(item)) continue;
      seen.add(item);
      tabs.push(item);
    }
    if (!tabs.includes(activeSection)) tabs.push(activeSection);
    return tabs.length > 0 ? tabs : [activeSection];
  } catch {
    return [activeSection];
  }
};

const initialActiveSection = readPersistedSection();

let snapshot: SidebarSectionsSnapshot = {
  openTabs: readPersistedOpenTabs(initialActiveSection),
  activeSection: initialActiveSection,
  locations: readPersistedLocations(),
};

const listeners = new Set<Listener>();

const emit = (next: SidebarSectionsSnapshot): void => {
  snapshot = next;
  for (const listener of listeners) listener();
};

const persistSection = (section: SidebarSection): void => {
  if (typeof window === "undefined") return;
  uiState.setItem(STORAGE_KEY_SECTION, section);
};

const persistLocations = (locations: SidebarSectionLocations): void => {
  if (typeof window === "undefined") return;
  uiState.setItem(
    STORAGE_KEY_LOCATIONS,
    JSON.stringify({
      home: locations.home,
      quickchat: locations.quickchat,
      files: locations.files,
      apps: locations.apps,
      browser: locations.browser,
    }),
  );
};

const persistOpenTabs = (openTabs: SidebarSection[]): void => {
  if (typeof window === "undefined") return;
  uiState.setItem(STORAGE_KEY_OPEN_TABS, JSON.stringify(openTabs));
};

export const sidebarSections = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot(): SidebarSectionsSnapshot {
    return snapshot;
  },

  /**
   * Point the active tab at `section` (browser-tab "navigate" semantics),
   * adding a tab for it if none is open, and consuming the current empty Home
   * tab when navigating away from it — the "new tab" becomes the destination.
   * Never touches the panel's open state.
   */
  setActiveSection(section: SidebarSection): void {
    const resolved = resolveSidebarSection(section);
    const openTabs = this._navigateTabs(resolved);
    if (
      snapshot.activeSection === resolved &&
      openTabs === snapshot.openTabs
    ) {
      return;
    }
    persistSection(resolved);
    if (openTabs !== snapshot.openTabs) persistOpenTabs(openTabs);
    emit({ ...snapshot, activeSection: resolved, openTabs });
  },

  /**
   * Compute the next open-tab list for navigating TO `section`: ensure it has a
   * tab, and drop the Home tab we're navigating away from (an empty "new tab"
   * is consumed when it becomes a real destination). Returns the same array
   * reference when nothing changes.
   */
  _navigateTabs(section: SidebarSection): SidebarSection[] {
    const consumeHome =
      snapshot.activeSection === "home" && section !== "home";
    const hasTab = snapshot.openTabs.includes(section);
    if (hasTab && !consumeHome) return snapshot.openTabs;
    const base = hasTab
      ? snapshot.openTabs
      : [...snapshot.openTabs, section];
    const next = consumeHome ? base.filter((tab) => tab !== "home") : base;
    return next.length > 0 ? next : [section];
  },

  /**
   * A launcher option / drill navigation. Opens the panel, and — browser-tab
   * style — turns the active empty Home tab into the destination (or focuses
   * an existing tab for it). Re-selecting the already-active section returns it
   * to its default list view.
   */
  selectSection(rawSection: SidebarSection): void {
    const section = resolveSidebarSection(rawSection);
    const { panelOpen } = displayTabs.getLayoutSnapshot();

    if (panelOpen && snapshot.activeSection === section) {
      if (snapshot.locations[section] !== null) this.clearLocation(section);
      return;
    }

    this.setActiveSection(section);
    if (!panelOpen) displayTabs.setPanelOpen(true);
  },

  /**
   * Activate an already-open tab (a tab-strip click). Unlike `selectSection`
   * this never consumes/creates tabs — it just switches to an existing one.
   * Re-clicking the active tab returns its section to the default list view.
   */
  activateTab(rawSection: SidebarSection): void {
    const section = resolveSidebarSection(rawSection);
    if (!snapshot.openTabs.includes(section)) return;
    if (snapshot.activeSection === section) {
      if (snapshot.locations[section] !== null) this.clearLocation(section);
      return;
    }
    persistSection(section);
    emit({ ...snapshot, activeSection: section });
  },

  /**
   * Close a tab. Activates a neighbor when the closed tab was active; closing
   * the last tab closes the panel (and reseeds a single Home tab for next
   * open). The closed section keeps its sub-location memory for a later reopen.
   */
  closeTab(rawSection: SidebarSection): void {
    const section = resolveSidebarSection(rawSection);
    const index = snapshot.openTabs.indexOf(section);
    if (index === -1) return;
    const openTabs = snapshot.openTabs.filter((tab) => tab !== section);

    if (openTabs.length === 0) {
      persistOpenTabs(DEFAULT_OPEN_TABS);
      persistSection(HOME_TAB);
      emit({ ...snapshot, openTabs: DEFAULT_OPEN_TABS, activeSection: HOME_TAB });
      displayTabs.setPanelOpen(false);
      return;
    }

    let activeSection = snapshot.activeSection;
    if (activeSection === section) {
      activeSection = openTabs[Math.min(index, openTabs.length - 1)]!;
    }
    persistOpenTabs(openTabs);
    if (activeSection !== snapshot.activeSection) persistSection(activeSection);
    emit({ ...snapshot, openTabs, activeSection });
  },

  /**
   * Open a NEW empty Home tab (or focus the existing one) with the panel open —
   * the browser "+". Never touches the current tab, so the view you already had
   * open stays open and selectable.
   */
  openHomeLauncher(): void {
    const openTabs = snapshot.openTabs.includes(HOME_TAB)
      ? snapshot.openTabs
      : [...snapshot.openTabs, HOME_TAB];
    const locations =
      snapshot.locations.home !== null
        ? { ...snapshot.locations, home: null }
        : snapshot.locations;
    persistSection("home");
    if (openTabs !== snapshot.openTabs) persistOpenTabs(openTabs);
    if (locations !== snapshot.locations) persistLocations(locations);
    emit({ activeSection: "home", openTabs, locations });
    displayTabs.setPanelOpen(true);
  },

  /**
   * Record where a section is. Passing `null` returns it to its list view.
   */
  setLocation(rawSection: SidebarSection, location: string | null): void {
    const section = resolveSidebarSection(rawSection);
    if (snapshot.locations[section] === location) return;
    const locations = { ...snapshot.locations, [section]: location };
    persistLocations(locations);
    emit({ ...snapshot, locations });
  },

  /** Explicit in-section back: return this section to its default list. */
  clearLocation(section: SidebarSection): void {
    this.setLocation(section, null);
  },

  /**
   * Point the sidebar at a section *and* a sub-location in one step, opening
   * the panel. This is the path artifact payloads take into Files.
   */
  openLocation(section: SidebarSection, location: string | null): void {
    const resolved = resolveSidebarSection(section);
    const locations = { ...snapshot.locations, [resolved]: location };
    const openTabs = this._navigateTabs(resolved);
    persistLocations(locations);
    persistSection(resolved);
    if (openTabs !== snapshot.openTabs) persistOpenTabs(openTabs);
    emit({ activeSection: resolved, openTabs, locations });
    displayTabs.setPanelOpen(true);
  },

  reset(): void {
    persistSection(HOME_TAB);
    persistLocations(DEFAULT_LOCATIONS);
    persistOpenTabs(DEFAULT_OPEN_TABS);
    emit({
      openTabs: DEFAULT_OPEN_TABS,
      activeSection: HOME_TAB,
      locations: DEFAULT_LOCATIONS,
    });
  },
};

export const useSidebarSections = (): SidebarSectionsSnapshot =>
  useSyncExternalStore(
    sidebarSections.subscribe,
    sidebarSections.getSnapshot,
    sidebarSections.getSnapshot,
  );

export const useActiveSidebarSection = (): SidebarSection =>
  useSyncExternalStore(
    sidebarSections.subscribe,
    () => sidebarSections.getSnapshot().activeSection,
    () => sidebarSections.getSnapshot().activeSection,
  );

/** The ordered list of currently-open tabs (browser-tab strip). */
export const useSidebarOpenTabs = (): SidebarSection[] =>
  useSyncExternalStore(
    sidebarSections.subscribe,
    () => sidebarSections.getSnapshot().openTabs,
    () => sidebarSections.getSnapshot().openTabs,
  );

/** The sub-location for one section, or `null` for its list view. */
export const useSidebarSectionLocation = (
  section: SidebarSection,
): string | null => {
  const resolved = resolveSidebarSection(section);
  return useSyncExternalStore(
    sidebarSections.subscribe,
    () => sidebarSections.getSnapshot().locations[resolved],
    () => sidebarSections.getSnapshot().locations[resolved],
  );
};
