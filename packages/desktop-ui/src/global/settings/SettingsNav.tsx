import { useLayoutEffect, useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { ChevronDown } from "@/ui/icons";
import { useT } from "@/shared/i18n";
import {
  SETTINGS_TAB_GROUPS,
  type SettingsTab,
  type SettingsTabDef,
} from "@/global/settings/settings-tabs";

interface SettingsNavProps {
  tabs: SettingsTabDef[];
  /** `null` while search results are showing: nothing reads as selected. */
  activeTab: SettingsTab | null;
  onSelect: (tab: SettingsTab) => void;
  label: string;
}

const tabButtonProps = (tab: SettingsTab, isActive: boolean) => ({
  id: `settings-tab-${tab}`,
  type: "button" as const,
  role: "tab",
  "aria-selected": isActive,
  "aria-controls": `settings-tabpanel-${tab}`,
  tabIndex: isActive ? 0 : -1,
});

/** Wide layout: grouped vertical list with icons. */
export function SettingsRailNav({
  tabs,
  activeTab,
  onSelect,
  label,
}: SettingsNavProps) {
  const t = useT();
  return (
    <nav
      className="settings-rail-nav"
      role="tablist"
      aria-orientation="vertical"
      aria-label={label}
    >
      {SETTINGS_TAB_GROUPS.map((group) => {
        const groupTabs = group.tabs
          .map((key) => tabs.find((tab) => tab.key === key))
          .filter((tab): tab is SettingsTabDef => tab !== undefined);
        if (groupTabs.length === 0) return null;
        return (
          <div className="settings-rail-group" key={group.labelKey}>
            <div className="settings-rail-group-label">
              {t(group.labelKey)}
            </div>
            {groupTabs.map(({ key, labelKey, Icon }) => {
              const isActive = activeTab === key;
              return (
                <button
                  key={key}
                  {...tabButtonProps(key, isActive)}
                  className="settings-rail-item"
                  data-active={isActive ? "true" : undefined}
                  onClick={() => onSelect(key)}
                >
                  <Icon size={16} strokeWidth={1.75} />
                  <span>{t(labelKey)}</span>
                </button>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}

const BAR_GAP = 2;

/**
 * Narrow layout: one row of tabs. Tabs that would clip collapse into a
 * trailing "More" menu; widths come from an invisible copy of the row so
 * the visible one never has to render a clipped state first.
 */
export function SettingsBarNav({
  tabs,
  activeTab,
  onSelect,
  label,
}: SettingsNavProps) {
  const t = useT();
  const navRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(tabs.length);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const measure = measureRef.current;
    if (!nav || !measure) return;

    const fit = () => {
      const available = nav.clientWidth;
      const items = Array.from(
        measure.querySelectorAll<HTMLElement>("[data-measure-tab]"),
      ).map((el) => el.offsetWidth);
      const moreWidth =
        measure.querySelector<HTMLElement>("[data-measure-more]")
          ?.offsetWidth ?? 0;
      const total = items.reduce(
        (sum, width, index) => sum + width + (index > 0 ? BAR_GAP : 0),
        0,
      );
      if (total <= available) {
        setVisibleCount(items.length);
        return;
      }
      let used = moreWidth;
      let count = 0;
      for (const width of items) {
        if (used + BAR_GAP + width > available) break;
        used += BAR_GAP + width;
        count += 1;
      }
      setVisibleCount(count);
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [tabs, t]);

  const visible = tabs.slice(0, visibleCount);
  const overflow = tabs.slice(visibleCount);
  const overflowActive = overflow.some((tab) => tab.key === activeTab);

  return (
    <div className="settings-bar-nav-wrap">
      <div
        ref={navRef}
        className="settings-bar-nav"
        role="tablist"
        aria-label={label}
      >
        {visible.map(({ key, labelKey }) => {
          const isActive = activeTab === key;
          return (
            <button
              key={key}
              {...tabButtonProps(key, isActive)}
              className="settings-bar-item"
              data-active={isActive ? "true" : undefined}
              onClick={() => onSelect(key)}
            >
              {t(labelKey)}
            </button>
          );
        })}
        {overflow.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="settings-bar-item settings-bar-more"
                data-active={overflowActive ? "true" : undefined}
              >
                {t("settings.nav.more")}
                <ChevronDown size={14} strokeWidth={1.75} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              sideOffset={6}
              className="settings-bar-more-menu"
            >
              {overflow.map(({ key, labelKey, Icon }) => (
                <DropdownMenuItem
                  key={key}
                  data-active={activeTab === key ? "true" : undefined}
                  onSelect={() => onSelect(key)}
                >
                  <Icon size={15} strokeWidth={1.75} />
                  {t(labelKey)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <div ref={measureRef} className="settings-bar-measure" aria-hidden>
        {tabs.map(({ key, labelKey }) => (
          <span key={key} className="settings-bar-item" data-measure-tab>
            {t(labelKey)}
          </span>
        ))}
        <span className="settings-bar-item settings-bar-more" data-measure-more>
          {t("settings.nav.more")}
          <ChevronDown size={14} strokeWidth={1.75} />
        </span>
      </div>
    </div>
  );
}
