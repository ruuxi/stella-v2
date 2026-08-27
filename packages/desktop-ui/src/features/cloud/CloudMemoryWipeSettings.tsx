import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { TextField } from "@/ui/text-field";
import { useT } from "@/shared/i18n";
import type { CloudMemoryWipeJob } from "./cloud-home-api";
import { useCloudMemoryWipe } from "./use-cloud-memory-wipe";

const stageCopy = (job: CloudMemoryWipeJob): string => {
  if (job.stage === "sweeping") {
    return "Permanently deleting encrypted Memory objects from cloud storage.";
  }
  if (job.stage === "metadata") {
    return "Removing Memory document metadata and indexes.";
  }
  if (job.stage === "releasing") {
    return "Releasing the previous Memory storage generation.";
  }
  return "The previous Memory epoch was permanently erased.";
};

const issueCopy = (code: string | null): string => {
  if (code === "stale_epoch" || code === "owner_generation_changed") {
    return "Your account or Memory epoch changed. Reload the authoritative status before trying again.";
  }
  if (code === "active") {
    return "A Memory wipe is already active. Reload its authoritative status.";
  }
  if (code === "unauthorized") {
    return "The signed-in cloud session changed. Reconnect before managing Memory.";
  }
  if (code === "account_unavailable") {
    return "Cloud data for this account is temporarily unavailable.";
  }
  if (code === "idempotency_conflict" || code === "invalid_response") {
    return "Stella could not verify this wipe safely. Reload status before starting a new attempt.";
  }
  return "Stella could not verify the cloud Memory wipe status.";
};

const dialogActionsStyle = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 20,
};

/** Dedicated destructive surface; document editing and the Memory toggle stay independent. */
export function CloudMemoryWipeSettings() {
  const t = useT();
  const {
    identity,
    phase,
    status,
    issueCode,
    disabled,
    startWipe,
    refresh,
    retry,
  } = useCloudMemoryWipe();
  const identityKey = identity
    ? `${identity.accountScope}:${identity.identityRevision}:${identity.ownerSubject}`
    : null;
  const [confirmationStep, setConfirmationStep] = useState<0 | 1 | 2>(0);
  const [confirmationText, setConfirmationText] = useState("");

  useLayoutEffect(() => {
    setConfirmationStep(0);
    setConfirmationText("");
  }, [identityKey]);

  const closeConfirmation = useCallback(() => {
    setConfirmationStep(0);
    setConfirmationText("");
  }, []);

  const confirmWipe = useCallback(() => {
    if (confirmationText !== "ERASE" || disabled) return;
    closeConfirmation();
    void startWipe();
  }, [closeConfirmation, confirmationText, disabled, startWipe]);

  const progress = useMemo(() => {
    const job = status?.job;
    if (!job) return null;
    return `${job.objectsDeleted.toLocaleString()} cloud objects and ${job.rowsDeleted.toLocaleString()} metadata rows erased.`;
  }, [status?.job]);

  if (!identity) return null;

  const activeJob = status?.state === "wiping" ? status.job : null;
  const completedJob =
    status?.state === "open" && status.job?.stage === "completed"
      ? status.job
      : null;

  return (
    <>
      <div className="settings-card" data-cloud-memory-wipe>
        <h3 className="settings-card-title">Erase cloud Memory</h3>
        <p className="settings-card-desc">
          Permanently erases Memory content, cloud objects, indexes, and
          document metadata for this account. Stella keeps only a non-content
          completion receipt, then opens a fresh, empty Memory epoch.
        </p>

        {phase === "loading" ? (
          <div className="settings-row-sublabel" role="status">
            {t("common.loading")}
          </div>
        ) : null}

        {activeJob ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label" role="status">
                Erasing cloud Memory
              </div>
              <div className="settings-row-sublabel">
                {stageCopy(activeJob)}
              </div>
              <div className="settings-row-sublabel">{progress}</div>
              {activeJob.lastErrorCode ? (
                <div className="settings-row-sublabel" role="status">
                  The last pass did not finish. Stella will retry automatically
                  after its protected backoff.
                </div>
              ) : null}
            </div>
            <div className="settings-row-control">
              <Button
                type="button"
                variant="ghost"
                className="pill-btn"
                onClick={() => void refresh()}
              >
                Refresh status
              </Button>
            </div>
          </div>
        ) : null}

        {completedJob ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label" role="status">
                Memory wipe completed
              </div>
              <div className="settings-row-sublabel">
                The previous Memory epoch has no reusable or recoverable Memory
                content. A new empty epoch is open. Local Memory from this Mac
                will stay blocked until you explicitly choose to import it.
              </div>
              <div className="settings-row-sublabel">{progress}</div>
            </div>
          </div>
        ) : null}

        {phase === "error" ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <div
                className="settings-card-desc settings-card-desc--error"
                role="alert"
              >
                {issueCopy(issueCode)}
              </div>
            </div>
            <div className="settings-row-control">
              <Button
                type="button"
                variant="ghost"
                className="pill-btn"
                onClick={() => void retry()}
              >
                {t("common.tryAgain")}
              </Button>
            </div>
          </div>
        ) : null}

        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">Permanent deletion</div>
            <div className="settings-row-sublabel">
              This is independent of turning Memory off and cannot be undone.
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="pill-btn pill-btn--danger"
              data-action="open-cloud-memory-wipe"
              onClick={() => setConfirmationStep(1)}
              disabled={disabled}
            >
              {phase === "starting" ? "Starting…" : "Erase cloud Memory"}
            </Button>
          </div>
        </div>
      </div>

      <Dialog
        open={confirmationStep === 1}
        onOpenChange={(open) => {
          if (!open) closeConfirmation();
        }}
      >
        <DialogContent data-cloud-memory-wipe-confirmation="review">
          <DialogHeader>
            <DialogTitle>Permanently erase cloud Memory?</DialogTitle>
            <DialogDescription>
              This deletes all Memory content, cloud objects, indexes, and
              document metadata for this account across cloud storage. It cannot
              be recovered. Stella retains only a non-content completion receipt
              so it can prove the wipe finished.
            </DialogDescription>
          </DialogHeader>
          <div style={dialogActionsStyle}>
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              onClick={closeConfirmation}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="pill-btn pill-btn--danger"
              data-action="continue-cloud-memory-wipe"
              onClick={() => setConfirmationStep(2)}
            >
              {t("common.continue")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmationStep === 2}
        onOpenChange={(open) => {
          if (!open) closeConfirmation();
        }}
      >
        <DialogContent data-cloud-memory-wipe-confirmation="final">
          <DialogHeader>
            <DialogTitle>Final confirmation</DialogTitle>
            <DialogDescription>
              Type ERASE to permanently remove every prior Memory object and its
              document metadata. The new Memory epoch starts empty.
            </DialogDescription>
          </DialogHeader>
          <TextField
            label="Type ERASE to confirm"
            value={confirmationText}
            onChange={(event) => setConfirmationText(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <div style={dialogActionsStyle}>
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              onClick={closeConfirmation}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="pill-btn pill-btn--danger"
              data-action="confirm-cloud-memory-wipe"
              onClick={confirmWipe}
              disabled={confirmationText !== "ERASE" || disabled}
            >
              Erase permanently
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
