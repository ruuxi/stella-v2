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
import { useMemorySyncStatus } from "./use-memory-sync-status";

const issueCopy = (code: string | null): string => {
  if (code === "stale_epoch" || code === "owner_generation_changed") {
    return "Your account or Memory epoch changed. Reload the authoritative status before trying again.";
  }
  if (code === "active") {
    return "A cloud Memory wipe is active. Memory can't be uploaded until it finishes.";
  }
  if (code === "not_required") {
    return "This Memory epoch no longer requires upload authorization. Reload its authoritative status.";
  }
  if (code === "unauthorized") {
    return "The signed-in cloud session changed. Reconnect before uploading Memory.";
  }
  if (code === "account_unavailable") {
    return "Cloud data for this account is temporarily unavailable.";
  }
  if (code === "idempotency_conflict" || code === "invalid_response") {
    return "Stella could not verify this authorization safely. Reload status before starting a new attempt.";
  }
  return "Stella could not verify the cloud Memory upload authorization.";
};

const dialogActionsStyle = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: 20,
};

/**
 * After a wipe: the account-wide choice to let computers upload the memory
 * they kept from before it, and, on a computer whose memory sync is holding
 * for that choice, erasing its memory instead. Skills are unrelated.
 */
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
  const memorySync = useMemorySyncStatus();
  const heldHere =
    memorySync?.phase === "held" && memorySync.heldReason === "wiped";
  const [confirmation, setConfirmation] = useState<"upload" | "erase" | null>(
    null,
  );
  const [eraseState, setEraseState] = useState<
    { kind: "idle" } | { kind: "erasing" } | { kind: "failed"; error: string }
  >({ kind: "idle" });

  useLayoutEffect(() => {
    setConfirmation(null);
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
    setConfirmation(null);
    void authorizeReimport();
  }, [authorizeReimport, disabled]);

  const confirmErase = useCallback(() => {
    setConfirmation(null);
    const api = window.electronAPI?.memorySync;
    if (!api) return;
    setEraseState({ kind: "erasing" });
    void api
      .eraseLocal()
      .then((result) =>
        setEraseState(
          result.ok ? { kind: "idle" } : { kind: "failed", error: result.error },
        ),
      )
      .catch((error: unknown) =>
        setEraseState({
          kind: "failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }, []);

  if (!identity || !eligible || !status) return null;

  return (
    <>
      <div className="settings-card" data-cloud-memory-reimport>
        <h3 className="settings-card-title">Memory from before the erase</h3>
        <p className="settings-card-desc">
          Cloud Memory was erased. A computer that still has Memory from before
          pauses its Memory sync, so that Memory isn't uploaded back. Allow the
          upload and each such computer merges its Memory into the cloud again.
          This does not restore what was erased from the cloud.
        </p>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">
              Upload Memory kept on computers
            </div>
            <div className="settings-row-sublabel">
              Applies to every computer signed in to this account.
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
                onClick={() => setConfirmation("upload")}
                disabled={disabled}
              >
                {phase === "authorizing" ? "Allowing…" : "Allow upload"}
              </Button>
            )}
          </div>
        </div>
        {heldHere ? (
          <div className="settings-row" data-memory-sync-held>
            <div className="settings-row-info">
              <div className="settings-row-label">This computer</div>
              <div className="settings-row-sublabel" role="status">
                Memory sync is paused here because this computer still has
                Memory from before the erase. Erase it to start again from the
                cloud's Memory instead.
              </div>
              {eraseState.kind === "failed" ? (
                <div
                  className="settings-card-desc settings-card-desc--error"
                  role="alert"
                >
                  {eraseState.error}
                </div>
              ) : null}
            </div>
            <div className="settings-row-control">
              <Button
                type="button"
                variant="ghost"
                className="pill-btn pill-btn--danger"
                data-action="open-erase-local-memory"
                onClick={() => setConfirmation("erase")}
                disabled={eraseState.kind === "erasing"}
              >
                {eraseState.kind === "erasing"
                  ? "Erasing…"
                  : "Erase on this computer"}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <Dialog
        open={confirmation === "upload"}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <DialogContent data-cloud-memory-reimport-confirmation>
          <DialogHeader>
            <DialogTitle>Allow Memory upload for this account?</DialogTitle>
            <DialogDescription>
              Every computer signed in to this account that kept Memory from
              before the erase merges it into the cloud's new Memory. This
              computer starts right away. What was erased from the cloud stays
              erased. Skills are unaffected.
            </DialogDescription>
          </DialogHeader>
          <div style={dialogActionsStyle}>
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              onClick={() => setConfirmation(null)}
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
              Allow upload
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmation === "erase"}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <DialogContent data-erase-local-memory-confirmation>
          <DialogHeader>
            <DialogTitle>Erase this computer's Memory?</DialogTitle>
            <DialogDescription>
              Deletes core-memory.md, PERSONALITY.md and the Markdown files
              under memories/ in this computer's Stella folder, then syncs with
              the cloud's Memory. Other computers keep theirs. This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <div style={dialogActionsStyle}>
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              onClick={() => setConfirmation(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="pill-btn pill-btn--danger"
              data-action="confirm-erase-local-memory"
              onClick={confirmErase}
            >
              Erase
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
