import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { LegalDocument } from "@/global/legal/legal-text";
import { SettingsPanel } from "@/global/settings/SettingsPanel";
import { SettingsSearch } from "@/global/settings/SettingsSearch";
import { SettingsBarNav, SettingsRailNav } from "@/global/settings/SettingsNav";
import { SettingsSearchResults } from "@/global/settings/SettingsSearchResults";
import { AudioTab } from "@/global/settings/AudioTab";
import {
  availableSettingsTabs,
  type SettingsTab,
} from "@/global/settings/settings-tabs";
import { AccountTab } from "./tabs/AccountTab";
import { GeneralTab } from "./tabs/GeneralTab";
import { ShortcutsTab } from "./tabs/ShortcutsTab";
import { PrivacyTab } from "./tabs/PrivacyTab";
import type { ScoredSettingsSearchEntry } from "@/global/settings/lib/settings-search-index";
import { useT } from "@/shared/i18n";
import "@/global/settings/settings.css";
import { platformCapabilities } from "@/platform/capabilities";

// Settings is lazy-preloaded before the sidebar opens. Keep the tabs eager
// inside that chunk so switching tabs does not show a blank Suspense gap.
const LegalDialog = lazy(() =>
  import("@/global/legal/LegalDialog").then((m) => ({
    default: m.LegalDialog,
  })),
);

/** Screen width below which the left rail becomes a top bar. */
const NARROW_WIDTH = 720;

// ---------------------------------------------------------------------------
// SettingsScreen (route- or sidebar-mounted, no Dialog wrapper)
// ---------------------------------------------------------------------------

export type { SettingsTab };

interface SettingsScreenProps {
  /** Tab currently in view. When omitted, defaults to basic. */
  activeTab?: SettingsTab;
  /** Called when the user clicks a different tab in the sidebar. */
  onActiveTabChange?: (tab: SettingsTab) => void;
  /** Called when the user signs out from the Basic tab. */
  onSignOut?: () => void;
  /** Use the compact layout when Settings is hosted in the right sidebar. */
  embedded?: boolean;
}

/**
 * The settings UI rendered inline (no Dialog wrapper). Tab state can be
 * controlled by the legacy `/settings` route or uncontrolled in the sidebar.
 */
export const SettingsScreen = ({
  activeTab: activeTabProp,
  onActiveTabChange,
  onSignOut,
  embedded = false,
}: SettingsScreenProps) => {
  const [selectedTab, setSelectedTab] = useState<SettingsTab>("general");
  const [activeLegalDoc, setActiveLegalDoc] = useState<LegalDocument | null>(
    null,
  );
  const [searchQuery, setSearchQuery] = useState("");
  const t = useT();

  const activeTab = activeTabProp ?? selectedTab;

  // Defer the value used for filtering work. Keeps the input
  // responsive even on slower machines while the results list catches
  // up. For our small catalog the win is marginal but the primitive
  // costs nothing.
  const deferredQuery = useDeferredValue(searchQuery);
  const isSearching = deferredQuery.trim().length > 0;

  const handleTabClick = useCallback(
    (next: SettingsTab) => {
      if (activeTabProp === undefined) {
        setSelectedTab(next);
      }
      onActiveTabChange?.(next);
    },
    [activeTabProp, onActiveTabChange],
  );

  // After picking a search result we need to (1) switch tabs and (2)
  // scroll the matching card into view + briefly highlight it. Some tab
  // content can still schedule its own DOM updates, so the panel resolves
  // the target once the right cards are actually present.
  const [pendingScrollTarget, setPendingScrollTarget] = useState<{
    tab: SettingsTab;
    title: string;
    nonce: number;
  } | null>(null);

  const handleResultSelect = useCallback(
    (result: ScoredSettingsSearchEntry) => {
      setSearchQuery("");
      handleTabClick(result.tab);
      setPendingScrollTarget({
        tab: result.tab,
        // Row-level entries carry `cardTitle` for the actual card to
        // scroll to; card-level entries scroll to their own title.
        title: result.cardTitle ?? result.title,
        // Nonce ensures repeat-selecting the same result re-triggers
        // the scroll/highlight effect even when tab + title are equal.
        nonce: Date.now(),
      });
    },
    [handleTabClick],
  );

  // Below this width the rail would squeeze the cards, so the tabs move
  // into a single row above the panel instead.
  const screenRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(embedded);
  useLayoutEffect(() => {
    const screen = screenRef.current;
    if (!screen || embedded) return;
    const measure = () => setNarrow(screen.clientWidth < NARROW_WIDTH);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(screen);
    return () => observer.disconnect();
  }, [embedded]);

  const tabs = availableSettingsTabs(platformCapabilities.website);
  const handleNavSelect = useCallback(
    (tab: SettingsTab) => {
      if (isSearching) setSearchQuery("");
      handleTabClick(tab);
    },
    [handleTabClick, isSearching],
  );
  const navProps = {
    tabs,
    activeTab: isSearching ? null : activeTab,
    onSelect: handleNavSelect,
    label: t("settings.title"),
  };

  return (
    <>
      <div
        ref={screenRef}
        className="settings-screen"
        data-search-active={isSearching ? "true" : "false"}
      >
        <div
          className={`settings-layout ${
            narrow ? "settings-layout--bar" : "settings-layout--rail"
          }`}
        >
          <header className="settings-nav">
            <SettingsSearch value={searchQuery} onChange={setSearchQuery} />
            {narrow ? (
              <SettingsBarNav {...navProps} />
            ) : (
              <SettingsRailNav {...navProps} />
            )}
          </header>
          <SettingsPanel scrollResetKey={isSearching ? "search" : activeTab}>
            {isSearching ? (
              <SettingsSearchResults
                query={deferredQuery}
                onSelect={handleResultSelect}
                onClear={() => setSearchQuery("")}
              />
            ) : (
              <div
                id={`settings-tabpanel-${activeTab}`}
                role="tabpanel"
                aria-labelledby={`settings-tab-${activeTab}`}
              >
                <SettingsTabContent
                  activeTab={activeTab}
                  onSignOut={onSignOut}
                  onOpenLegal={setActiveLegalDoc}
                  pendingScrollTarget={pendingScrollTarget}
                  onScrollTargetHandled={() => setPendingScrollTarget(null)}
                />
              </div>
            )}
          </SettingsPanel>
        </div>
      </div>
      <Suspense fallback={null}>
        <LegalDialog
          document={activeLegalDoc}
          onOpenChange={(open) => {
            if (!open) setActiveLegalDoc(null);
          }}
        />
      </Suspense>
    </>
  );
};

interface SettingsTabContentProps {
  activeTab: SettingsTab;
  onSignOut?: () => void;
  onOpenLegal: (doc: LegalDocument) => void;
  pendingScrollTarget: {
    tab: SettingsTab;
    title: string;
    nonce: number;
  } | null;
  onScrollTargetHandled: () => void;
}

function SettingsTabContent({
  activeTab,
  onSignOut,
  onOpenLegal,
  pendingScrollTarget,
  onScrollTargetHandled,
}: SettingsTabContentProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  // Resolve any pending "scroll to / highlight this card" request from
  // the search results. Use a short-lived MutationObserver to wait for
  // any delayed tab content to appear, then scroll + flash it.
  useEffect(() => {
    if (!pendingScrollTarget) return;
    if (pendingScrollTarget.tab !== activeTab) return;
    const container = contentRef.current;
    if (!container) return;

    let cancelled = false;
    let observer: MutationObserver | null = null;
    let timeoutId: number | null = null;
    let highlightTimeoutId: number | null = null;

    const tryResolve = (): boolean => {
      const cards = container.querySelectorAll<HTMLElement>(".settings-card");
      const titleNeedle = pendingScrollTarget.title.toLowerCase().trim();
      for (const card of cards) {
        const heading = card.querySelector(".settings-card-title");
        const headingText = (heading?.textContent ?? "").toLowerCase().trim();
        if (headingText === titleNeedle) {
          card.scrollIntoView({ behavior: "smooth", block: "start" });
          card.setAttribute("data-search-target", "true");
          highlightTimeoutId = window.setTimeout(() => {
            card.removeAttribute("data-search-target");
          }, 1800);
          onScrollTargetHandled();
          return true;
        }
      }
      return false;
    };

    if (tryResolve()) {
      return () => {
        if (highlightTimeoutId) window.clearTimeout(highlightTimeoutId);
      };
    }

    observer = new MutationObserver(() => {
      if (cancelled) return;
      if (tryResolve()) {
        observer?.disconnect();
        observer = null;
      }
    });
    observer.observe(container, { subtree: true, childList: true });

    // Belt-and-suspenders: stop waiting after a couple seconds so we
    // don't leak observers if the title text changes or content fails
    // to mount.
    timeoutId = window.setTimeout(() => {
      cancelled = true;
      observer?.disconnect();
      observer = null;
      onScrollTargetHandled();
    }, 2500);

    return () => {
      cancelled = true;
      observer?.disconnect();
      if (timeoutId) window.clearTimeout(timeoutId);
      if (highlightTimeoutId) window.clearTimeout(highlightTimeoutId);
    };
  }, [activeTab, pendingScrollTarget, onScrollTargetHandled]);

  return (
    <div ref={contentRef} className="settings-panel-content">
      {activeTab === "general" ? (
        <GeneralTab />
      ) : activeTab === "shortcuts" && platformCapabilities.shortcuts ? (
        <ShortcutsTab />
      ) : activeTab === "account" ? (
        <AccountTab onSignOut={onSignOut} onOpenLegal={onOpenLegal} />
      ) : activeTab === "audio" ? (
        <AudioTab />
      ) : activeTab === "privacy" ? (
        <PrivacyTab />
      ) : (
        <GeneralTab />
      )}
    </div>
  );
}
