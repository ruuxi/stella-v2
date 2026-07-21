/**
 * Persistent floating left sidebar — the consolidated index.
 *
 * Activity rows expand in place to show each agent's messages and files.
 * Search lives entirely in the composer pill's activity tray — the
 * sidebar never filters by it, so an active tray search leaves this stable
 * activity index untouched.
 *
 * Full window only — the mini window keeps its own chrome.
 */

import { getPlatform } from "@/platform/electron/platform";
import { LeftSidebarSections } from "@/shell/LeftSidebarSections";
import { ShellTopBarUpdatePill } from "@/shell/ShellTopBarUpdatePill";
import "./left-sidebar.css";
import "./shell-junction.css";

type LeftSidebarProps = {
  /** When true, the sidebar animates its width to 0 (stays mounted). */
  collapsed?: boolean;
};

export function LeftSidebar({ collapsed = false }: LeftSidebarProps) {
  const platform = getPlatform();
  const isMac = platform === "darwin";
  const isWin = platform === "win32";

  return (
    <aside
      className={`left-sidebar${collapsed ? " left-sidebar--collapsed" : ""}`}
      data-platform={isMac ? "mac" : isWin ? "win" : "other"}
      aria-label="Sidebar"
      aria-hidden={collapsed || undefined}
    >
      <div className="left-sidebar__frame">
        <div className="left-sidebar__chrome">
          <ShellTopBarUpdatePill />
          <div className="left-sidebar__chrome-spacer" aria-hidden="true" />
        </div>
        <div className="left-sidebar__scroll">
          <LeftSidebarSections variant="overview" />
        </div>
      </div>
    </aside>
  );
}
