/**
 * Plan & usage — one dialog for everything money- and quota-shaped, opened
 * from the account menu.
 *
 * Two tabs rather than one long scroll: "Plan" is a decision surface
 * (what you're on, what else costs what) and "Usage" is an analytics
 * surface (what you've spent locally). Stacking them made the second one
 * feel like a footnote and buried the plan cards behind a scroll.
 */
import { lazy, Suspense, useState } from "react";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import {
  Dialog,
  DialogBody,
  DialogCloseButton,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import "./plan-usage-dialog.css";

const BillingPanel = lazy(() =>
  import("./BillingScreen").then((module) => ({
    default: module.BillingPanel,
  })),
);
const UsagePanel = lazy(() =>
  import("@/app/usage/App").then((module) => ({
    default: module.UsagePanel,
  })),
);

const TABS = [
  { key: "plan", label: "Plan" },
  { key: "usage", label: "Usage" },
] as const;

type PlanUsageTab = (typeof TABS)[number]["key"];

type PlanUsageDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function PlanUsageDialog({ open, onOpenChange }: PlanUsageDialogProps) {
  const [tab, setTab] = useState<PlanUsageTab>("plan");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="xl"
        className="plan-usage-dialog"
        aria-describedby={undefined}
      >
        {/* The tabs name the surface, so the title would only repeat them.
            Keep it for the accessible name and give the row to the tabs. */}
        <DialogHeader className="plan-usage-dialog__header">
          <VisuallyHidden asChild>
            <DialogTitle>Plan &amp; usage</DialogTitle>
          </VisuallyHidden>
          <nav
            className="plan-usage-tabs"
            role="tablist"
            aria-label="Plan and usage"
          >
            {TABS.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                role="tab"
                id={`plan-usage-tab-${key}`}
                aria-selected={tab === key}
                aria-controls={`plan-usage-panel-${key}`}
                className="plan-usage-tabs__item"
                data-active={tab === key || undefined}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </nav>
          <DialogCloseButton />
        </DialogHeader>
        <DialogBody
          className="plan-usage-dialog__body"
          role="tabpanel"
          id={`plan-usage-panel-${tab}`}
          aria-labelledby={`plan-usage-tab-${tab}`}
        >
          <Suspense fallback={null}>
            {tab === "plan" ? <BillingPanel /> : <UsagePanel />}
          </Suspense>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
