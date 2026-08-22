import { useState } from "react";
import { AlertCircle, ExternalLink, Globe } from "@/ui/icons";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import {
  Dialog,
  DialogBody,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/ui/dialog";
import { Button } from "@/ui/button";
import "./credential-modal.css";

type ConnectorOAuthDialogProps = {
  open: boolean;
  displayName: string;
  description?: string;
  oauthUserCode?: string;
  waitForCompletion?: boolean;
  completionError?: string;
  onOpenExternal: () => Promise<void>;
  onCancel: () => void;
  onDismiss: () => void;
};

export const ConnectorOAuthDialog = ({
  open,
  displayName,
  description,
  oauthUserCode,
  waitForCompletion = true,
  completionError,
  onOpenExternal,
  onCancel,
  onDismiss,
}: ConnectorOAuthDialogProps) => {
  const [opening, setOpening] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const failed = Boolean(completionError);
  const headline = failed
    ? `Couldn't connect ${displayName}`
    : waiting
      ? `Waiting for ${displayName}`
      : `Connect ${displayName}`;
  const defaultDescription = `Stella needs to open ${displayName} in your browser so you can sign in and approve the connection.`;
  const waitingDescription = `Finish signing in to ${displayName} in your browser. Stella will continue once the connection is approved.`;
  const dialogDescription = failed
    ? completionError!
    : waiting
      ? waitingDescription
      : (description ?? defaultDescription);

  const handleOpenExternal = async () => {
    setLaunchError(null);
    setOpening(true);
    try {
      await onOpenExternal();
      if (waitForCompletion) setWaiting(true);
    } catch (error) {
      setLaunchError(
        error instanceof Error && error.message
          ? error.message
          : "Could not open the browser.",
      );
    } finally {
      setOpening(false);
    }
  };

  const handleClose = failed ? onDismiss : onCancel;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => (!nextOpen ? handleClose() : undefined)}
    >
      <DialogContent fit className="credential-modal-content">
        <VisuallyHidden asChild>
          <DialogTitle>{headline}</DialogTitle>
        </VisuallyHidden>
        <VisuallyHidden asChild>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </VisuallyHidden>
        <DialogCloseButton className="credential-modal-close" />
        <DialogBody className="credential-modal-body">
          <div className="credential-modal-hero">
            <div className="credential-modal-icon">
              {failed ? (
                <AlertCircle size={20} />
              ) : waiting ? (
                <Globe size={20} />
              ) : (
                <ExternalLink size={20} />
              )}
            </div>
            <p className="credential-modal-headline">{headline}</p>
            <p className="credential-modal-sub">{dialogDescription}</p>
          </div>
          {oauthUserCode && !failed ? (
            <div className="credential-modal-oauth-code">
              <span className="credential-modal-oauth-code-label">
                Use this code
              </span>
              <code>{oauthUserCode}</code>
            </div>
          ) : null}
          {launchError ? (
            <div className="credential-modal-error">{launchError}</div>
          ) : null}

          <div className="credential-modal-actions">
            <Button
              type="button"
              variant="ghost"
              onClick={handleClose}
              disabled={opening}
              className="pill-btn pill-btn--lg credential-modal-cancel"
            >
              {failed ? "Close" : "Cancel"}
            </Button>
            {!waiting && !failed ? (
              <Button
                type="button"
                variant="primary"
                onClick={handleOpenExternal}
                disabled={opening}
                className="pill-btn pill-btn--primary pill-btn--lg credential-modal-submit"
              >
                {opening ? "Opening..." : "Open browser"}
              </Button>
            ) : null}
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
