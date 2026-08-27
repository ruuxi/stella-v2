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
      </div>

      <div className="shell-topbar-full__spacer" aria-hidden="true" />

      <div className="shell-topbar-full__right">
        <ShellTopBarUpdatePill />
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
