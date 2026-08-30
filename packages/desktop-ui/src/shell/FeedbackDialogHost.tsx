/**
 * The single mounted host for the feedback dialog.
 *
 * Hosted in the root chrome rather than beside a trigger because feedback
 * has several openers — the utility button in either sidebar footer, and
 * the periodic auto-prompt in `ShellTopBarAccount` — and both footers can
 * be mounted at once. They all go through `feedbackDialog`, so exactly one
 * dialog exists regardless of how many triggers are on screen.
 */
import { lazy, Suspense } from "react";
import {
  feedbackDialog,
  useFeedbackDialogOpen,
} from "@/shell/sidebar-sections/feedback-dialog-store";

const FeedbackDialog = lazy(() =>
  import("@/shell/sidebar/FeedbackDialog").then((module) => ({
    default: module.FeedbackDialog,
  })),
);

export function FeedbackDialogHost() {
  const open = useFeedbackDialogOpen();

  if (!open) return null;

  return (
    <Suspense fallback={null}>
      <FeedbackDialog
        open
        onOpenChange={(next) => feedbackDialog.setOpen(next)}
      />
    </Suspense>
  );
}
