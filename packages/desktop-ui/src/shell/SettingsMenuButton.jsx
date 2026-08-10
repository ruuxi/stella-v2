/**
 * The top-bar gear: a destination menu for every settings-shaped surface.
 *
 * Settings itself opens the full screen as a dialog (hosted once in the root
 * chrome by `SettingsDialogHost`); Theme and Connectors open as popovers
 * anchored to the gear; Phone routes through the `?dialog=connect` URL and
 * Feedback through `FeedbackDialogHost`. Anchoring the two popovers means
 * the gear keeps a hidden, absolutely-positioned trigger for each — the menu
 * item only flips the popover's controlled `open`.
 */
import { lazy, Suspense, useState } from "react";
import { usePostOnboardingHint } from "@/global/onboarding/post-onboarding-hints";
import { ConnectorsPopover } from "@/shell/sidebar-sections/ConnectorsPopover";
import { feedbackDialog } from "@/shell/sidebar-sections/feedback-dialog-store";
import { preloadSettingsScreen } from "@/shell/topbar/nav-surface-preloads";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import {
  CircleQuestionMark,
  Palette,
  Plug,
  Settings,
  Smartphone,
} from "@/ui/icons";
import { settingsDialog, useSettingsDialogOpen } from "./settings-dialog-store";

const ThemePicker = lazy(() =>
  import("@/global/settings/ThemePicker").then((module) => ({
    default: module.ThemePicker,
  })),
);

const openPhoneDialog = () => {
  void import("@/router").then(({ router }) => {
    void router.navigate({
      to: ".",
      search: (prev) => ({ ...prev, dialog: "connect" }),
    });
  });
};

/** The menu owns focus until it is fully closed; opening a popover from a
 *  selection has to wait for that hand-back or Radix pulls focus straight
 *  back to the gear. */
const afterMenuCloses = (run) => setTimeout(run, 0);

const HiddenAnchor = (props) => (
  <button
    type="button"
    tabIndex={-1}
    aria-hidden="true"
    className="shell-settings-menu-anchor__target"
    {...props}
  />
);

export function SettingsMenuButton({ className, showActiveState = false }) {
  const settingsOpen = useSettingsDialogOpen();
  const connectHint = usePostOnboardingHint("connect");
  const [menuOpen, setMenuOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const active = settingsOpen || menuOpen;

  const destinations = [
    {
      id: "settings",
      label: "Settings",
      Icon: Settings,
      onSelect: () => settingsDialog.open(),
    },
    {
      id: "theme",
      label: "Theme",
      Icon: Palette,
      onSelect: () => afterMenuCloses(() => setThemeOpen(true)),
    },
    {
      id: "connect",
      label: "Stella on your phone",
      Icon: Smartphone,
      onSelect: () => {
        if (connectHint.active) connectHint.dismiss();
        openPhoneDialog();
      },
    },
    {
      id: "connectors",
      label: "Connectors",
      Icon: Plug,
      onSelect: () => afterMenuCloses(() => setConnectorsOpen(true)),
    },
    {
      id: "feedback",
      label: "Send feedback",
      Icon: CircleQuestionMark,
      onSelect: () => feedbackDialog.open(),
    },
  ];

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
      {themeOpen ? (
        <Suspense fallback={null}>
          <ThemePicker
            hideTrigger
            open={themeOpen}
            onOpenChange={setThemeOpen}
            side="bottom"
            align="end"
            trigger={<HiddenAnchor />}
          />
        </Suspense>
      ) : null}
      <ConnectorsPopover
        open={connectorsOpen}
        onOpenChange={setConnectorsOpen}
        side="bottom"
        align="end"
        trigger={<HiddenAnchor />}
      />
    </span>
  );
}
