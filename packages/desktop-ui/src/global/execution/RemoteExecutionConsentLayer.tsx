import { useCallback, useEffect, useState } from "react";
import { getElectronApi } from "@/platform/electron/electron";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogBody,
  DialogCloseButton,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { useT } from "@/shared/i18n";
import "./remote-execution-consent.css";

type PendingRemoteExecutionRequest = {
  requestedAt: number;
  requesterLabel?: string;
};

/**
 * The "accept work from your other devices?" question, asked on the screen of
 * the computer it is about.
 *
 * It is a dialog and not a toast because an answer is wanted: something is
 * waiting on it, and a notice that scrolls away would leave the device looking
 * merely un-asked. Both answers are recorded — Allow enables this computer,
 * Not now records that it was declined — while closing the dialog answers
 * nothing, so the next attempt may ask again.
 */
export const RemoteExecutionConsentLayer = () => {
  const t = useT();
  const [pending, setPending] = useState<PendingRemoteExecutionRequest | null>(
    null,
  );
  const [answering, setAnswering] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const remoteExecution = getElectronApi()?.remoteExecution;
    if (!remoteExecution?.onRequest) return;
    // Main sends this fire-and-forget, so the subscription has to outlive any
    // particular surface being open; `App` mounts this layer eagerly.
    return remoteExecution.onRequest((request) => {
      setFailed(false);
      setAnswering(false);
      setPending(request);
    });
  }, []);

  const answer = useCallback(async (allow: boolean) => {
    const remoteExecution = getElectronApi()?.remoteExecution;
    if (!remoteExecution?.answer) return;
    setAnswering(true);
    setFailed(false);
    try {
      await remoteExecution.answer(allow);
      setPending(null);
    } catch {
      // Keep the prompt up: the answer the user gave was not recorded, and
      // guessing either way would be worse than asking again.
      setFailed(true);
    } finally {
      setAnswering(false);
    }
  }, []);

  if (!pending) return null;

  const title = t("global.remoteExecutionConsent.title");
  const body = pending.requesterLabel
    ? t("global.remoteExecutionConsent.bodyFrom", {
        requester: pending.requesterLabel,
      })
    : t("global.remoteExecutionConsent.body");

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // Dismissing is not declining; it leaves the question unanswered.
        if (!next && !answering) setPending(null);
      }}
    >
      <DialogContent fit className="remote-execution-consent">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogCloseButton aria-label={t("common.close")} />
        </DialogHeader>
        <DialogBody className="remote-execution-consent-body">
          <DialogDescription className="remote-execution-consent-text">
            {body}
          </DialogDescription>
          <p className="remote-execution-consent-note">
            {t("global.remoteExecutionConsent.note")}
          </p>
          {failed ? (
            <div className="remote-execution-consent-error">
              {t("global.remoteExecutionConsent.failed")}
            </div>
          ) : null}
          <div className="remote-execution-consent-actions">
            <Button
              type="button"
              variant="ghost"
              disabled={answering}
              className="pill-btn pill-btn--lg"
              data-consent-action="decline"
              onClick={() => void answer(false)}
            >
              {t("global.remoteExecutionConsent.decline")}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={answering}
              className="pill-btn pill-btn--primary pill-btn--lg"
              data-consent-action="allow"
              onClick={() => void answer(true)}
            >
              {t("global.remoteExecutionConsent.allow")}
            </Button>
          </div>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
};
