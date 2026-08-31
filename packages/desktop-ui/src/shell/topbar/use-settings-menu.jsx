/**
 * Shared settings-menu machinery for the top bar.
 *
 * The gear's destinations and its two anchored popovers (Theme, Connectors)
 * are rendered in two places: the standalone gear (`SettingsMenuButton`, shown
 * while signed out) and the unified account+settings menu (`ShellTopBarAccount`,
 * shown while signed in). Centralizing the destination list, the pending-popover
 * handoff, and the popover elements keeps both surfaces byte-for-byte identical.
 *
 * Theme and Connectors open as popovers anchored to hidden, absolutely
 * positioned targets that sit on top of the trigger button — the menu item only
 * queues which popover to open, and `applyPendingPopover` flips it open once the
 * dropdown has closed (see the note there for why the handoff is deferred).
 */
import { lazy, Suspense, useRef, useState } from "react";
import { usePostOnboardingHint } from "@/global/onboarding/post-onboarding-hints";
import { platformCapabilities } from "@/platform/capabilities";
import { ConnectorsPopover } from "@/shell/sidebar-sections/ConnectorsPopover";
import { feedbackDialog } from "@/shell/sidebar-sections/feedback-dialog-store";
import {
  CircleQuestionMark,
  Palette,
  Plug,
  Settings,
  Smartphone,
} from "@/ui/icons";
import { settingsDialog } from "@/shell/settings-dialog-store";

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

const HiddenAnchor = (props) => (
  <button
    type="button"
    tabIndex={-1}
    aria-hidden="true"
    className="shell-settings-menu-anchor__target"
    {...props}
  />
);

export function useSettingsMenu() {
  const connectHint = usePostOnboardingHint("connect");
  const [themeOpen, setThemeOpen] = useState(false);
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const pendingPopoverRef = useRef(null);

  // Opens whichever popover a menu item queued, returning `true` when it did so
  // the caller can `preventDefault()` the dropdown's focus restore. The dropdown
  // otherwise restores focus to the trigger while the next Radix layer is
  // mounting, and that focus-out dismisses the new popover as soon as it opens.
  const applyPendingPopover = () => {
    const pendingPopover = pendingPopoverRef.current;
    if (!pendingPopover) return false;
    pendingPopoverRef.current = null;
    if (pendingPopover === "theme") setThemeOpen(true);
    else setConnectorsOpen(true);
    return true;
  };

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
      onSelect: () => {
        pendingPopoverRef.current = "theme";
      },
    },
    ...(platformCapabilities.phoneAccess
      ? [
          {
            id: "connect",
            label: "Stella on your phone",
            Icon: Smartphone,
            // Mirrors the trigger's hint dot inside the opened menu so the user can
            // see which row clears it; selecting the row dismisses both.
            hint: connectHint.active,
            onSelect: () => {
              if (connectHint.active) connectHint.dismiss();
              openPhoneDialog();
            },
          },
        ]
      : []),
    {
      id: "connectors",
      label: "Connectors",
      Icon: Plug,
      onSelect: () => {
        pendingPopoverRef.current = "connectors";
      },
    },
    {
      id: "feedback",
      label: "Send feedback",
      Icon: CircleQuestionMark,
      onSelect: () => feedbackDialog.open(),
    },
  ];

  // Rendered inside the trigger's positioned wrapper so the hidden anchors line
  // up on top of the button that opened the menu.
  const popovers = (
    <>
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
    </>
  );

  return { destinations, connectHint, applyPendingPopover, popovers };
}
