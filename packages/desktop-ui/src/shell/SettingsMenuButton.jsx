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
          {destinations.map(({ id, label, Icon, onSelect, hint }) => (
            <DropdownMenuItem key={id} onSelect={onSelect}>
              <span data-slot="dropdown-menu-item-icon">
                <Icon size={15} strokeWidth={1.75} />
                {hint ? (
                  <span
                    className="shell-topbar-nav-hint-dot shell-settings-menu-item-hint-dot"
                    aria-hidden="true"
                  />
                ) : null}
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
