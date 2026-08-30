import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/api";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogCloseButton,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { TextField } from "@/ui/text-field";
import { showToast } from "@/ui/toast";
import { useT } from "@/shared/i18n";

interface FeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted?: () => void;
}

export const FEEDBACK_MAX_LENGTH = 32_000;

interface FeedbackFormProps {
  onCancel: () => void;
  onSubmitted?: () => void;
}

const FeedbackForm = ({ onCancel, onSubmitted }: FeedbackFormProps) => {
  const t = useT();
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submitFeedback = useMutation(api.feedback.submitFeedback);

  const handleSubmit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await submitFeedback({ message: trimmed });
      onCancel();
      onSubmitted?.();
      showToast({
        title: t("shell.sidebar.feedback.toasts.sentTitle"),
        description: t("shell.sidebar.feedback.toasts.sentDescription"),
      });
    } catch (error) {
      const description =
        error instanceof Error ? error.message : t("chat.tryAgainHint");
      showToast({
        title: t("shell.sidebar.feedback.toasts.failedTitle"),
        description,
        variant: "error",
      });
    } finally {
      setSubmitting(false);
    }
  }, [text, submitting, submitFeedback, onCancel, onSubmitted, t]);

  return (
    <>
      <div className="sidebar-feedback-description">
        {t("shell.sidebar.feedback.description")}
      </div>
      <div className="sidebar-feedback-body">
        <TextField
          multiline
          hideLabel
          label={t("shell.sidebar.feedback.fieldLabel")}
          placeholder={t("shell.sidebar.feedback.placeholder")}
          rows={5}
          maxLength={FEEDBACK_MAX_LENGTH}
          value={text}
          onChange={(event) => setText(event.target.value)}
          autoFocus
          disabled={submitting}
        />
        <div className="sidebar-feedback-character-count" aria-live="polite">
          {text.length.toLocaleString()} /{" "}
          {FEEDBACK_MAX_LENGTH.toLocaleString()}
        </div>
      </div>
      <div className="sidebar-confirm-actions">
        <Button
          variant="ghost"
          size="large"
          className="pill-btn pill-btn--lg"
          onClick={onCancel}
          disabled={submitting}
        >
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          size="large"
          className="pill-btn pill-btn--primary pill-btn--lg"
          onClick={() => {
            void handleSubmit();
          }}
          disabled={submitting || text.trim().length === 0}
        >
          {submitting
            ? t("shell.sidebar.feedback.sending")
            : t("shell.sidebar.feedback.send")}
        </Button>
      </div>
    </>
  );
};

interface FeedbackPanelProps {
  onDone: () => void;
  onSubmitted?: () => void;
}

export const FeedbackPanel = ({
  onDone,
  onSubmitted,
}: FeedbackPanelProps) => (
  <div className="sidebar-feedback-panel">
    <FeedbackForm onCancel={onDone} onSubmitted={onSubmitted} />
  </div>
);

export const FeedbackDialog = ({
  open,
  onOpenChange,
  onSubmitted,
}: FeedbackDialogProps) => {
  const t = useT();
  const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent fit className="sidebar-feedback-dialog">
        <DialogHeader>
          <DialogTitle>{t("shell.sidebar.feedback.title")}</DialogTitle>
          <DialogCloseButton />
        </DialogHeader>
        <FeedbackForm onCancel={handleClose} onSubmitted={onSubmitted} />
      </DialogContent>
    </Dialog>
  );
};
