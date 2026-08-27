import { lazy, Suspense, useRef, useState } from "react";
import { usePostOnboardingHint } from "@/global/onboarding/post-onboarding-hints";
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
    {
      id: "connect",
      label: "Stella on your phone",
      Icon: Smartphone,

      hint: connectHint.active,
      onSelect: () => {
        if (connectHint.active) connectHint.dismiss();
        openPhoneDialog();
      },
    },
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
