/**
 * The top-bar gear: a destination menu for every settings-shaped surface.
 *
 * This standalone gear is what a signed-out user sees. Once signed in the same
 * destinations are folded into the account button's unified menu — both share
 * `useSettingsMenu` so the list and its anchored popovers stay identical.
 *
 * Settings itself opens the full screen as a dialog (hosted once in the root
 * chrome by `SettingsDialogHost`); Theme and Connectors open as popovers
 * anchored to the gear; Phone routes through the `?dialog=connect` URL and
 * Feedback through `FeedbackDialogHost`.
 */
import { useState } from "react";
import { preloadSettingsScreen } from "@/shell/topbar/nav-surface-preloads";
import { useSettingsMenu } from "@/shell/topbar/use-settings-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Settings } from "@/ui/icons";
import { useSettingsDialogOpen } from "./settings-dialog-store";

export function SettingsMenuButton({ className, showActiveState = false }) {
  const settingsOpen = useSettingsDialogOpen();
  const [menuOpen, setMenuOpen] = useState(false);
  const { destinations, connectHint, applyPendingPopover, popovers } =
    useSettingsMenu();
  const active = settingsOpen || menuOpen;

  return (
    <span className="shell-settings-menu-anchor">
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={className}
            data-active={showActiveState && active ? "true" : undefined}
            aria-pressed={showActiveState ? active : undefined}
            aria-label="Settings"
            title="Settings"
            onMouseEnter={preloadSettingsScreen}
            onFocus={preloadSettingsScreen}
          >
            <Settings size={14} strokeWidth={1.75} />
            {connectHint.active ? (
              <span className="shell-topbar-nav-hint-dot" aria-hidden="true" />
            ) : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="shell-settings-menu"
          side="bottom"
          align="end"
          sideOffset={8}
          aria-label="Settings destinations"
          onCloseAutoFocus={(event) => {
            if (applyPendingPopover()) event.preventDefault();
          }}
        >
          {destinations.map(({ id, label, Icon, onSelect }) => (
            <DropdownMenuItem key={id} onSelect={onSelect}>
              <span data-slot="dropdown-menu-item-icon">
                <Icon size={15} strokeWidth={1.75} />
              </span>
              {label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {popovers}
    </span>
  );
}
