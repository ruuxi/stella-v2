/**
 * Persistent floating left sidebar — the consolidated index.
 *
 * Top-to-bottom: Activity sections (`LeftSidebarSections`) and account
 * controls. Activity rows expand in place to show each agent's messages and
 * files. Search lives entirely in the composer pill's activity tray — the
 * sidebar never filters by it, so an active tray search leaves this stable
 * activity index untouched.
 *
 * Full window only — the mini window keeps its own chrome.
 */

import { getPlatform } from "@/platform/electron/platform";
import { LeftSidebarSections } from "@/shell/LeftSidebarSections";
import { ShellTopBarAccount } from "@/shell/sidebar/ShellTopBarAccount";
import { ShellTopBarUpdatePill } from "@/shell/ShellTopBarUpdatePill";
import "./left-sidebar.css";
import "./shell-junction.css";

type LeftSidebarProps = {
  onSignIn?: () => void;
  onConnect?: () => void;
  /** When true, the sidebar animates its width to 0 (stays mounted). */
  collapsed?: boolean;
};

export function LeftSidebar({
  onSignIn,
  onConnect,
  collapsed = false,
}: LeftSidebarProps) {
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

        <div className="left-sidebar__footer">
          <ShellTopBarAccount onSignIn={onSignIn} onConnect={onConnect} />
        </div>
      </div>
    </aside>
  );
}
