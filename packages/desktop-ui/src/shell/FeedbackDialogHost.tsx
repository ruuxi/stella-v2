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
