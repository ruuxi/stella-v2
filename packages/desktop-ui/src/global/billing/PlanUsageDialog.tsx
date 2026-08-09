/**
 * Plan & usage — one dialog for everything money- and quota-shaped, opened
 * from the account menu. Billing (plan, meters, credit) on top; the local
 * usage analytics below it.
 */
import { lazy, Suspense } from "react";
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

type PlanUsageDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function PlanUsageDialog({ open, onOpenChange }: PlanUsageDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="plan-usage-dialog">
        <DialogHeader>
          <DialogTitle>Plan &amp; usage</DialogTitle>
          <DialogCloseButton />
        </DialogHeader>
        <DialogBody className="plan-usage-dialog__body">
          <Suspense fallback={null}>
            <BillingPanel />
            <section
              className="plan-usage-dialog__usage"
              aria-label="Local usage"
            >
              <h2 className="plan-usage-dialog__usage-title">Local usage</h2>
              <UsagePanel />
            </section>
          </Suspense>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
