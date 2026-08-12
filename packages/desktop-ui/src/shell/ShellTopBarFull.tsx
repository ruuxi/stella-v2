/**
 * Full-window top bar.
 *
 * Before the shell redesign the full window had no top bar at all — the left
 * sidebar's chrome carried the macOS traffic-light inset, the update pill and
 * account controls, and the only other chrome was a pair of floating edge
 * toggles. With the sidebar gone, this bar takes over that job: it owns the
 * main-column drag region, clears the traffic lights, and hosts navigation
 * plus the account. The account follows the main column as the right sidebar
 * opens and closes; the sidebar's own header replaces the closed Settings and
 * panel controls while open.
 *
 * The treatment follows Stella v2's: a transparent 38px strip with no border
 * and no backdrop, carrying floating controls. Everything inside carves
 * `no-drag` out of the bar's `drag` region, and the bar is rendered late in the
 * shell tree because `-webkit-app-region` resolves in DOM order rather than by
 * z-index — a control painted above but declared earlier still reads as
 * draggable and swallows its own clicks.
 *
 * Apps are deliberately absent from the nav: they now open inside the right
 * sidebar's Apps section rather than the main content area, so a nav entry
 * pointing at the `/apps` route would compete with the sidebar for the same
 * job. Home is also omitted from route navigation because its activity surface
 * is rendered independently by `WorkspaceHomeSurface`.
 */

import { getPlatform } from "@/platform/electron/platform";
import {
  displayTabs,
  useDisplayPanelOpen,
} from "@/features/workspace-display/tab-store";
import { SettingsMenuButton } from "@/shell/SettingsMenuButton";
import { ShellTopBarAccount } from "@/shell/sidebar/ShellTopBarAccount";
import { useAuthSessionState } from "@/global/auth/hooks/use-auth-session-state";
import { ShellTopBarPrimaryNav } from "@/shell/sidebar/ShellTopBarNav";
import { ConversationTopBar } from "@/shell/topbar/ConversationTopBar";
import { ShellTopBarUpdatePill } from "@/shell/ShellTopBarUpdatePill";
import { WindowControls } from "@/shell/WindowControls";
import { PanelRight } from "@/ui/icons";
import { useT } from "@/shared/i18n";
import "./shell-topbar-full.css";

/**
 * Nav entries the full-window bar suppresses. Apps lives in the right sidebar;
 * Home is rendered by the standalone workspace surface.
 */
const OMITTED_NAV_IDS = ["apps", "chat"] as const;

type ShellTopBarFullProps = {
  onSignIn?: () => void;
};

export function ShellTopBarFull({ onSignIn }: ShellTopBarFullProps) {
  const t = useT();
  const platform = getPlatform();
  const isMac = platform === "darwin";
  const isWin = platform === "win32";
  const panelOpen = useDisplayPanelOpen();
  // While signed in, the settings gear is folded into the account button's
  // unified menu, so the standalone gear only renders when signed out.
  const { hasConnectedAccount } = useAuthSessionState();

  return (
    <header
      className="shell-topbar-full"
      data-platform={isMac ? "mac" : isWin ? "win" : "other"}
      data-display-open={panelOpen ? "true" : "false"}
    >
      <div className="shell-topbar-full__left">
        <ConversationTopBar />
        <ShellTopBarPrimaryNav omitIds={OMITTED_NAV_IDS} />
        <ShellTopBarUpdatePill />
      </div>

      <div className="shell-topbar-full__spacer" aria-hidden="true" />

      <div className="shell-topbar-full__right">
        <ShellTopBarAccount onSignIn={onSignIn} />
        {!panelOpen ? (
          <>
            {!hasConnectedAccount ? (
              <SettingsMenuButton className="shell-topbar-account-settings" />
            ) : null}
            <button
              type="button"
              className="shell-topbar-icon-btn"
              onClick={() => displayTabs.setPanelOpen(true)}
              aria-label={t("shell.displayPanel.openPanel")}
              title={t("shell.displayPanel.openPanel")}
            >
              <PanelRight size={16} strokeWidth={1.75} />
            </button>
          </>
        ) : null}
        {isWin && !panelOpen ? (
          <WindowControls useWindowsIcons hidden={false} />
        ) : null}
      </div>
    </header>
  );
}
