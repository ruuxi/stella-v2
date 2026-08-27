import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import { useEdgeFadeRef } from "@/shared/hooks/use-edge-fade";
import type { LegalDocument } from "@/global/legal/legal-text";
import { SettingsPanel } from "@/global/settings/SettingsPanel";
import { SettingsSearch } from "@/global/settings/SettingsSearch";
import { SettingsSearchResults } from "@/global/settings/SettingsSearchResults";
import { AudioTab } from "@/global/settings/AudioTab";
import {
  SETTINGS_TABS,
  type SettingsTab,
} from "@/global/settings/settings-tabs";
import { AccountTab } from "./tabs/AccountTab";
import { BackupTab } from "./tabs/BackupTab";
import { GeneralTab } from "./tabs/GeneralTab";
import { ShortcutsTab } from "./tabs/ShortcutsTab";
import type { ScoredSettingsSearchEntry } from "@/global/settings/lib/settings-search-index";
import { useT } from "@/shared/i18n";
import "@/global/settings/settings.css";

const LegalDialog = lazy(() =>
  import("@/global/legal/LegalDialog").then((m) => ({
    default: m.LegalDialog,
  })),
);

export type { SettingsTab };

interface SettingsScreenProps {

  activeTab?: SettingsTab;

  onActiveTabChange?: (tab: SettingsTab) => void;

  onSignOut?: () => void;

  embedded?: boolean;
}

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

        title: result.cardTitle ?? result.title,

        nonce: Date.now(),
      });
    },
    [handleTabClick],
  );

  const tabStripRef = useEdgeFadeRef<HTMLElement>();

  return (
    <>
      {

}
      <div
        className="settings-screen"
        data-search-active={isSearching ? "true" : "false"}
      >
        <div
          className={`settings-layout ${
            embedded ? "settings-layout--sidebar" : "settings-layout--standalone"
          }`}
        >
          {

}
          <header
            className="settings-tab-rail"
            role="tablist"
            aria-label={t("settings.title")}
          >
            <div className="settings-tab-rail-header">
              <div className="settings-tab-rail-title">
                {t("settings.title")}
              </div>
              <SettingsSearch value={searchQuery} onChange={setSearchQuery} />
            </div>
            <nav ref={tabStripRef} className="settings-tab-rail-nav">
              {SETTINGS_TABS.map((tab) => {
                const isActive = activeTab === tab.key && !isSearching;
                return (
                  <button
                    key={tab.key}
                    id={`settings-tab-${tab.key}`}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    aria-controls={`settings-tabpanel-${tab.key}`}
                    tabIndex={isActive ? 0 : -1}
                    className={`settings-tab-rail-item${isActive ? " settings-tab-rail-item--active" : ""}`}
                    onClick={() => {
                      if (isSearching) setSearchQuery("");
                      handleTabClick(tab.key);
                    }}
                  >
                    {t(tab.labelKey)}
                  </button>
                );
              })}
            </nav>
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
      ) : activeTab === "shortcuts" ? (
        <ShortcutsTab />
      ) : activeTab === "backup" ? (
        <BackupTab />
      ) : activeTab === "account" ? (
        <AccountTab onSignOut={onSignOut} onOpenLegal={onOpenLegal} />
      ) : activeTab === "audio" ? (
        <AudioTab />
      ) : (
        <GeneralTab />
      )}
    </div>
  );
}
