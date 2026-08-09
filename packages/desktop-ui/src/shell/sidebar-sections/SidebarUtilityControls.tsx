/**
 * The sidebar footer's utility cluster: Theme, Phone, Connectors, and
 * Feedback as popovers/dialogs, so none of them need a page of their own.
 * Sits beside `SidebarModelsControl` in both footers — Home's inside the
 * panel, and the workspace strip's when the panel is closed.
 *
 * Every surface here is either locally-stated (the Theme and Connectors
 * popovers, so two mounted clusters can't fight) or routed through a
 * global store whose dialog is hosted once in the root chrome (Phone via
 * the `?dialog=connect` URL, Feedback via `FeedbackDialogHost`). That is
 * what makes this component safe to mount twice.
 */
import { lazy, Suspense } from "react";
import { usePostOnboardingHint } from "@/global/onboarding/post-onboarding-hints";
import { CircleQuestionMark, Palette, Plug, Smartphone } from "@/ui/icons";
import { ConnectorsPopover } from "./ConnectorsPopover";
import { feedbackDialog } from "./feedback-dialog-store";

const ThemePicker = lazy(() =>
  import("@/global/settings/ThemePicker").then((module) => ({
    default: module.ThemePicker,
  })),
);

const openPhoneDialog = () => {
  void import("@/router").then(({ router }) => {
    void router.navigate({
      to: ".",
      search: (prev: { dialog?: "auth" | "connect" }) => ({
        ...prev,
        dialog: "connect" as const,
      }),
    });
  });
};

type UtilityButtonProps = {
  label: string;
  onClick?: () => void;
  children: React.ReactNode;
};

const UtilityButton = ({ label, onClick, children }: UtilityButtonProps) => (
  <button
    type="button"
    className="work-utility-btn"
    aria-label={label}
    title={label}
    onClick={onClick}
  >
    {children}
  </button>
);

export function SidebarUtilityControls() {
  const connectHint = usePostOnboardingHint("connect");

  return (
    <div className="work-utility-controls">
      <Suspense fallback={null}>
        <ThemePicker
          side="top"
          align="start"
          trigger={
            <button
              type="button"
              className="work-utility-btn"
              aria-label="Theme"
              title="Theme"
            >
              <Palette size={14} strokeWidth={1.75} />
            </button>
          }
        />
      </Suspense>
      <UtilityButton
        label="Stella on your phone"
        onClick={() => {
          if (connectHint.active) connectHint.dismiss();
          openPhoneDialog();
        }}
      >
        <Smartphone size={14} strokeWidth={1.75} />
        {connectHint.active ? (
          <span className="shell-topbar-nav-hint-dot" aria-hidden="true" />
        ) : null}
      </UtilityButton>
      <ConnectorsPopover
        trigger={
          <button
            type="button"
            className="work-utility-btn"
            aria-label="Connectors"
            title="Connectors"
          >
            <Plug size={14} strokeWidth={1.75} />
          </button>
        }
      />
      <UtilityButton
        label="Send feedback"
        onClick={() => feedbackDialog.open()}
      >
        <CircleQuestionMark size={14} strokeWidth={1.75} />
      </UtilityButton>
    </div>
  );
}
