/**
 * The top-bar gear: opens the full Settings screen as a dialog.
 *
 * This used to fan out into a destination menu (Settings/Theme/Connect/
 * Billing/Usage/Feedback) that drilled into the right sidebar's settings
 * section. Those surfaces now live where they belong — theme/phone/
 * connectors/feedback as footer popovers on Home, plan & usage behind the
 * account menu — so the gear does exactly one thing. The dialog itself is
 * hosted once in the root chrome (`SettingsDialogHost`).
 */
import { preloadSettingsScreen } from "@/shell/topbar/nav-surface-preloads";
import { settingsDialog, useSettingsDialogOpen } from "./settings-dialog-store";
import { Settings } from "@/ui/icons";

export function SettingsMenuButton({ className, showActiveState = false }) {
  const open = useSettingsDialogOpen();
  return (
    <button
      type="button"
      className={className}
      data-active={showActiveState && open ? "true" : undefined}
      aria-pressed={showActiveState ? open : undefined}
      aria-label="Settings"
      title="Settings"
      onClick={() => settingsDialog.open()}
      onMouseEnter={preloadSettingsScreen}
      onFocus={preloadSettingsScreen}
    >
      <Settings size={14} strokeWidth={1.75} />
    </button>
  );
}
