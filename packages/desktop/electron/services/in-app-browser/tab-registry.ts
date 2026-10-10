import type { WebContentsView } from "electron";
import type {
  BrowserViewOwnerState,
  BrowserViewTabState,
} from "../in-app-browser-service.js";

export const DEFAULT_URL = "about:blank";
export const MANUAL_OWNER_ID = "stella:manual";

export type ManagedTab = {
  id: string;
  ownerId: string;
  view: WebContentsView;
  title: string;
  faviconUrl?: string;
  faviconLoadId: number;
  loading: boolean;
  /** A `stella-preview://` tab: the app's own UI from a draft worktree. */
  preview?: { name: string; dispose: () => void };
};

type OwnerTabRegistry = {
  tabIds: Set<string>;
  activeTabId?: string;
};

export const resolveOwnerId = (ownerId?: string) => {
  const normalized = ownerId?.trim();
  return normalized || MANUAL_OWNER_ID;
};

export const readTabUrl = (tab: ManagedTab) => {
  try {
    return tab.view.webContents.getURL() || DEFAULT_URL;
  } catch {
    return DEFAULT_URL;
  }
};

const tabState = (tab: ManagedTab): BrowserViewTabState => {
  const history = tab.view.webContents.navigationHistory;
  return {
    id: tab.id,
    ownerId: tab.ownerId,
    url: readTabUrl(tab),
    title: tab.title || tab.view.webContents.getTitle() || "New Tab",
    ...(tab.faviconUrl ? { faviconUrl: tab.faviconUrl } : {}),
    loading: tab.loading,
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward(),
  };
};

/**
 * Every managed tab, grouped by owner (the manual browser or one agent
 * conversation/session), plus which owner the panel shows. Pure bookkeeping:
 * mounting views, emitting state and per-owner errors stay with the service.
 */
export class BrowserTabRegistry {
  private readonly tabs = new Map<string, ManagedTab>();
  private readonly owners = new Map<string, OwnerTabRegistry>();
  private latestOwnerId: string | undefined;
  visibleOwnerId = MANUAL_OWNER_ID;
  /**
   * `undefined` preserves the legacy single-owner view, `null` exposes every
   * owner, and a string pins the view to one conversation/session owner.
   */
  scopedOwnerId: string | null | undefined;

  get(tabId: string) {
    return this.tabs.get(tabId);
  }

  has(tabId: string) {
    return this.tabs.has(tabId);
  }

  all() {
    return [...this.tabs.values()];
  }

  first() {
    return this.tabs.values().next().value as ManagedTab | undefined;
  }

  findByView(view: WebContentsView) {
    return this.all().find((candidate) => candidate.view === view);
  }

  hasOwner(ownerId: string) {
    return this.owners.has(ownerId);
  }

  ownerTabIds(ownerId: string) {
    const owner = this.owners.get(ownerId);
    return owner ? [...owner.tabIds] : undefined;
  }

  activeTabId(ownerId: string) {
    return this.owners.get(ownerId)?.activeTabId;
  }

  isOwnedBy(tabId: string, ownerId: string) {
    return this.tabs.get(tabId)?.ownerId === ownerId;
  }

  require(tabId: string, ownerId?: string) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.view.webContents.isDestroyed()) {
      throw new Error(`Browser tab not found: ${tabId}`);
    }
    if (ownerId !== undefined && tab.ownerId !== ownerId) {
      throw new Error(`Browser tab not found for owner: ${tabId}`);
    }
    return tab;
  }

  /** Registers a tab as its owner's active one and its owner as the latest. */
  add(tab: ManagedTab, activate?: boolean) {
    this.tabs.set(tab.id, tab);
    const owner = this.getOrCreateOwner(tab.ownerId);
    owner.tabIds.add(tab.id);
    owner.activeTabId = tab.id;
    this.latestOwnerId = tab.ownerId;
    if (this.shouldActivateOwner(tab.ownerId, activate)) {
      this.visibleOwnerId = tab.ownerId;
    }
  }

  select(tabId: string, ownerId: string, activate?: boolean) {
    this.getOrCreateOwner(ownerId).activeTabId = tabId;
    this.latestOwnerId = ownerId;
    if (this.shouldActivateOwner(ownerId, activate)) {
      this.visibleOwnerId = ownerId;
    }
  }

  /**
   * Drops a tab. A closed tab hands activation to its neighbour; a destroyed
   * one to the owner's last tab. Returns true when that emptied (and removed)
   * the owner.
   */
  remove(tab: ManagedTab, nextActive: "neighbor" | "last"): boolean {
    const owner = this.owners.get(tab.ownerId);
    const orderedIds = owner ? [...owner.tabIds] : [];
    const closedIndex = orderedIds.indexOf(tab.id);
    this.tabs.delete(tab.id);
    owner?.tabIds.delete(tab.id);
    if (owner?.activeTabId === tab.id) {
      owner.activeTabId =
        nextActive === "neighbor"
          ? (orderedIds[closedIndex + 1] ?? orderedIds[closedIndex - 1])
          : [...owner.tabIds].at(-1);
    }
    if (!owner || owner.tabIds.size > 0) return false;
    this.owners.delete(tab.ownerId);
    if (this.latestOwnerId === tab.ownerId) {
      this.latestOwnerId = [...this.owners.keys()]
        .filter((candidate) => candidate !== MANUAL_OWNER_ID)
        .at(-1);
    }
    if (this.visibleOwnerId === tab.ownerId) {
      this.visibleOwnerId = MANUAL_OWNER_ID;
    }
    return true;
  }

  deleteOwner(ownerId: string) {
    this.owners.delete(ownerId);
  }

  clearOwners() {
    this.owners.clear();
  }

  /** The owner the current scope shows; also settles `visibleOwnerId` to it. */
  settleScopedOwner() {
    this.visibleOwnerId =
      typeof this.scopedOwnerId === "string"
        ? this.scopedOwnerId
        : this.scopedOwnerId === null
          ? this.resolveAvailableOwnerId(this.visibleOwnerId)
          : this.visibleOwnerId;
    return this.visibleOwnerId;
  }

  resolveShowOwnerId(ownerId?: string) {
    const normalized = ownerId?.trim();
    if (normalized) return normalized;
    if (typeof this.scopedOwnerId === "string") return this.scopedOwnerId;
    if ((this.owners.get(this.visibleOwnerId)?.tabIds.size ?? 0) > 0) {
      return this.visibleOwnerId;
    }
    if ((this.owners.get(MANUAL_OWNER_ID)?.tabIds.size ?? 0) > 0) {
      return MANUAL_OWNER_ID;
    }
    if (this.latestOwnerId && this.owners.has(this.latestOwnerId)) {
      return this.latestOwnerId;
    }
    return MANUAL_OWNER_ID;
  }

  private shouldActivateOwner(ownerId: string, requested?: boolean) {
    if (requested) return true;
    if (typeof this.scopedOwnerId === "string") {
      return this.scopedOwnerId === ownerId;
    }
    return this.scopedOwnerId === undefined && ownerId === MANUAL_OWNER_ID;
  }

  private resolveAvailableOwnerId(preferredOwnerId: string) {
    if ((this.owners.get(preferredOwnerId)?.tabIds.size ?? 0) > 0) {
      return preferredOwnerId;
    }
    if (this.latestOwnerId && this.owners.has(this.latestOwnerId)) {
      return this.latestOwnerId;
    }
    if ((this.owners.get(MANUAL_OWNER_ID)?.tabIds.size ?? 0) > 0) {
      return MANUAL_OWNER_ID;
    }
    return (
      [...this.owners.entries()].find(
        ([, owner]) => owner.tabIds.size > 0,
      )?.[0] ?? MANUAL_OWNER_ID
    );
  }

  /** Live tabs of one owner, in creation order. */
  ownerTabStates(ownerId: string): BrowserViewTabState[] {
    const owner = this.owners.get(ownerId);
    return owner
      ? [...owner.tabIds].flatMap((tabId) => {
          const tab = this.tabs.get(tabId);
          return tab && !tab.view.webContents.isDestroyed()
            ? [tabState(tab)]
            : [];
        })
      : [];
  }

  tabsForCurrentScope(): BrowserViewTabState[] {
    if (this.scopedOwnerId === null) {
      return [...this.tabs.values()].flatMap((tab) =>
        tab.view.webContents.isDestroyed() ? [] : [tabState(tab)],
      );
    }
    return this.ownerTabStates(
      typeof this.scopedOwnerId === "string"
        ? this.scopedOwnerId
        : this.visibleOwnerId,
    );
  }

  ownerStates(): BrowserViewOwnerState[] {
    const manual = this.owners.get(MANUAL_OWNER_ID);
    const result: BrowserViewOwnerState[] = [
      {
        id: MANUAL_OWNER_ID,
        kind: "manual",
        tabCount: manual?.tabIds.size ?? 0,
        ...(manual?.activeTabId ? { activeTabId: manual.activeTabId } : {}),
        latest: false,
      },
    ];
    for (const [ownerId, owner] of this.owners) {
      if (ownerId === MANUAL_OWNER_ID || owner.tabIds.size === 0) continue;
      result.push({
        id: ownerId,
        kind: "agent",
        tabCount: owner.tabIds.size,
        ...(owner.activeTabId ? { activeTabId: owner.activeTabId } : {}),
        latest: ownerId === this.latestOwnerId,
      });
    }
    return result;
  }

  private getOrCreateOwner(ownerId: string) {
    let owner = this.owners.get(ownerId);
    if (!owner) {
      owner = { tabIds: new Set() };
      this.owners.set(ownerId, owner);
    }
    return owner;
  }
}
