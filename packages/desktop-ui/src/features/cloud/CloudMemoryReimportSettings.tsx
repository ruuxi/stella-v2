import { useCallback, useLayoutEffect, useState } from "react";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/ui/dialog";
import { useT } from "@/shared/i18n";
import { useCloudMemoryReimport } from "./use-cloud-memory-reimport";

const issueCopy = (code: string | null): string => {
  if (code === "stale_epoch" || code === "owner_generation_changed") {
    return "Your account or Memory epoch changed. Reload the authoritative status before trying again.";
  }
  if (code === "active") {
    return "A cloud Memory wipe is active. Local Memory cannot be imported until it finishes.";
  }
  if (code === "not_required") {
    return "This Memory epoch no longer requires import authorization. Reload its authoritative status.";
  }
  if (code === "unauthorized") {
    return "The signed-in cloud session changed. Reconnect before importing Memory.";
  }
  if (code === "account_unavailable") {
    return "Cloud data for this account is temporarily unavailable.";
  }
  if (code === "idempotency_conflict" || code === "invalid_response") {
    return "Stella could not verify this authorization safely. Reload status before starting a new attempt.";
  }
  return "Stella could not verify the cloud Memory import authorization.";
};

const dialogActionsStyle = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 20,
};

/** Explicit account-wide post-wipe Memory gate; skills are unrelated. */
export function CloudMemoryReimportSettings() {
  const t = useT();
  const {
    identity,
    phase,
    status,
    issueCode,
    eligible,
    disabled,
    authorizeReimport,
    retry,
  } = useCloudMemoryReimport();
  const [confirmationOpen, setConfirmationOpen] = useState(false);

  useLayoutEffect(() => {
    setConfirmationOpen(false);
  }, [
    identity?.accountScope,
    identity?.identityRevision,
    identity?.ownerSubject,
    status?.ownerGeneration,
    status?.memoryEpoch,
    status?.importDisposition,
  ]);

  const confirmImport = useCallback(() => {
    if (disabled) return;
    setConfirmationOpen(false);
    void authorizeReimport();
  }, [authorizeReimport, disabled]);

  if (!identity || !eligible || !status) return null;

  return (
    <>
      <div className="settings-card" data-cloud-memory-reimport>
        <h3 className="settings-card-title">Import local Memory again</h3>
        <p className="settings-card-desc">
          Cloud Memory was erased and its new epoch is empty. Stella will not
          automatically upload local Memory documents. You must explicitly allow
          that import for this account's new epoch.
        </p>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">
              Local Memory for this account
            </div>
            <div className="settings-row-sublabel">
              Authorization applies account-wide to this new cloud epoch. This
              Mac retries immediately; other Stella devices signed into this
              account may import their local Memory on their next sync. It does
              not restore the erased epoch.
            </div>
            <div className="settings-row-sublabel">
              Skill synchronization is separate and remains available.
            </div>
            {phase === "error" ? (
              <div
                className="settings-card-desc settings-card-desc--error"
                role="alert"
              >
                {issueCopy(issueCode)}
              </div>
            ) : null}
          </div>
          <div className="settings-row-control">
            {phase === "error" ? (
              <Button
                type="button"
                variant="ghost"
                className="pill-btn"
                data-action="retry-cloud-memory-reimport"
                onClick={() => void retry()}
              >
                {t("common.tryAgain")}
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                className="pill-btn"
                data-action="open-cloud-memory-reimport"
                onClick={() => setConfirmationOpen(true)}
                disabled={disabled}
              >
                {phase === "authorizing" ? "Allowing…" : "Allow Memory import"}
              </Button>
            )}
          </div>
        </div>
      </div>

      <Dialog
        open={confirmationOpen}
        onOpenChange={(open) => setConfirmationOpen(open)}
      >
        <DialogContent data-cloud-memory-reimport-confirmation>
          <DialogHeader>
            <DialogTitle>
              Allow local Memory import for this account?
            </DialogTitle>
            <DialogDescription>
              This explicitly allows Stella devices signed into this account to
              upload local Memory documents into the new, empty cloud Memory
              epoch. This Mac retries immediately. The erased epoch stays
              permanently deleted. Skills are unaffected.
            </DialogDescription>
          </DialogHeader>
          <div style={dialogActionsStyle}>
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              onClick={() => setConfirmationOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              data-action="confirm-cloud-memory-reimport"
              onClick={confirmImport}
              disabled={disabled}
            >
              Allow reimport
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
