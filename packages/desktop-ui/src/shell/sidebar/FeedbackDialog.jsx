import { useCallback, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/api";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogCloseButton, DialogHeader, DialogTitle, } from "@/ui/dialog";
import { TextField } from "@/ui/text-field";
import { showToast } from "@/ui/toast";
const TITLE_BY_VARIANT = {
    manual: "Send feedback",
    auto: "How's Stella going?",
};
const DESCRIPTION_BY_VARIANT = {
    manual: "Your message is sent anonymously — it isn't linked to your account.",
    auto: "Anything we should know? Sent anonymously — not linked to your account.",
};
const CANCEL_LABEL_BY_VARIANT = {
    manual: "Cancel",
    auto: "Not now",
};
const FeedbackForm = ({ variant, onCancel, onSubmitted, }) => {
    const [text, setText] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const submitFeedback = useMutation(api.feedback.submitFeedback);
    const handleSubmit = useCallback(async () => {
        const trimmed = text.trim();
        if (!trimmed || submitting)
            return;
        setSubmitting(true);
        try {
            await submitFeedback({ message: trimmed });
            onCancel();
            onSubmitted?.();
            showToast({
                title: "Feedback sent",
                description: "Thanks — every note helps us shape Stella.",
            });
        }
        catch (error) {
            const description = error instanceof Error ? error.message : "Please try again.";
            showToast({
                title: "Couldn't send feedback",
                description,
                variant: "error",
            });
        }
        finally {
            setSubmitting(false);
        }
    }, [text, submitting, submitFeedback, onCancel, onSubmitted]);
    return (<>
      <div className="sidebar-feedback-description">
        {DESCRIPTION_BY_VARIANT[variant]}
      </div>
      <div className="sidebar-feedback-body">
        <TextField multiline hideLabel label="Feedback" placeholder="Tell us what's working, what isn't, or what you'd love to see…" rows={5} maxLength={4000} value={text} onChange={(event) => setText(event.target.value)} autoFocus disabled={submitting}/>
      </div>
      <div className="sidebar-confirm-actions">
        <Button variant="ghost" size="large" className="pill-btn pill-btn--lg" onClick={onCancel} disabled={submitting}>
          {CANCEL_LABEL_BY_VARIANT[variant]}
        </Button>
        <Button variant="primary" size="large" className="pill-btn pill-btn--primary pill-btn--lg" onClick={() => {
            void handleSubmit();
        }} disabled={submitting || text.trim().length === 0}>
          {submitting ? "Sending…" : "Send"}
        </Button>
      </div>
    </>);
};
export const FeedbackPanel = ({ onDone, onSubmitted, }) => (<div className="sidebar-feedback-panel">
    <FeedbackForm variant="manual" onCancel={onDone} onSubmitted={onSubmitted}/>
  </div>);
export const FeedbackDialog = ({ open, onOpenChange, variant = "manual", onSubmitted, }) => {
    const handleClose = useCallback(() => onOpenChange(false), [onOpenChange]);
    return (<Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent fit className="sidebar-feedback-dialog">
        <DialogHeader>
          <DialogTitle>{TITLE_BY_VARIANT[variant]}</DialogTitle>
          <DialogCloseButton />
        </DialogHeader>
        <FeedbackForm variant={variant} onCancel={handleClose} onSubmitted={onSubmitted}/>
      </DialogContent>
    </Dialog>);
};
