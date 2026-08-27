import { lazy, Suspense } from "react";
import {
  feedbackDialog,
  useFeedbackDialogOpen,
} from "@/shell/sidebar-sections/feedback-dialog-store";
import { useFeedbackPrompt } from "@/shell/sidebar/use-feedback-prompt";

const FeedbackDialog = lazy(() =>
  import("@/shell/sidebar/FeedbackDialog").then((module) => ({
    default: module.FeedbackDialog,
  })),
);

export function FeedbackDialogHost() {
  const open = useFeedbackDialogOpen();
  const { acknowledge } = useFeedbackPrompt();

  if (!open) return null;

  return (
    <Suspense fallback={null}>
      <FeedbackDialog
        open
        onOpenChange={(next) => feedbackDialog.setOpen(next)}
        onSubmitted={acknowledge}
      />
    </Suspense>
  );
}
