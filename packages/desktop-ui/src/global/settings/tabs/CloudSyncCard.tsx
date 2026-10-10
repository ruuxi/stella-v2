import { useCallback, useState, useSyncExternalStore } from "react";
import { Button } from "@/ui/button";
import { useLocale, useT } from "@/shared/i18n";
import type { MemorySyncStatus } from "@stella/contracts/desktop/memory-sync";
import {
  cloudHomeStatusForAccount,
  cloudHomeSyncRetryStore,
  cloudHomeSyncStatusStore,
} from "@/features/cloud/cloud-home-sync";
import { useCloudConversationSession } from "@/global/auth/hooks/use-cloud-conversation-session";
import {
  requestMemorySync,
  useMemorySyncStatus,
} from "@/features/cloud/use-memory-sync-status";

type Translate = ReturnType<typeof useT>;

const memorySyncSummary = (
  t: Translate,
  status: MemorySyncStatus | null,
): string => {
  const key = "settings.account.cloudHome.memory";
  switch (status?.phase) {
    case "synced":
      return status.merging > 0 ? t(`${key}.merging`) : t(`${key}.synced`);
    case "syncing":
      return t(`${key}.syncing`);
    case "off":
      return t(`${key}.off`);
    case "held":
      return status.heldReason === "other_account"
        ? t(`${key}.heldOtherAccount`)
        : t(`${key}.heldWiped`);
    case "error":
      return t(`${key}.error`);
    default:
      return t(`${key}.signedOut`);
  }
};

const syncedAtLabel = (locale: string, at: number): string => {
  const sameDay = new Date(at).toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(
    locale,
    sameDay ? { timeStyle: "short" } : { dateStyle: "medium", timeStyle: "short" },
  ).format(at);
};

/** Cloud sync status for memory and skills. Rendered only where `cloudHome` exists. */
export function CloudSyncCard() {
  const t = useT();
  const locale = useLocale();
  const memorySync = useMemorySyncStatus();
  const [isConfirmingCloudHome, setIsConfirmingCloudHome] = useState(false);
  const { accountScope } = useCloudConversationSession();
  const cloudHomeStatusSnapshot = useSyncExternalStore(
    cloudHomeSyncStatusStore.subscribe,
    cloudHomeSyncStatusStore.getSnapshot,
    cloudHomeSyncStatusStore.getServerSnapshot,
  );
  const cloudHomeStatus = cloudHomeStatusForAccount(
    cloudHomeStatusSnapshot,
    accountScope,
  );
  const cloudHomeBusy =
    cloudHomeStatus.phase === "scanning" ||
    cloudHomeStatus.phase === "reconciling";
  const cloudHomeNeedsConfirmation = cloudHomeStatus.issues.some(
    (issue) => issue.code === "import_confirmation_required",
  );
  const cloudHomeOwnerMismatch = cloudHomeStatus.issues.some(
    (issue) => issue.code === "local_owner_mismatch",
  );
  const cloudHomeOwnerInvalid = cloudHomeStatus.issues.some(
    (issue) => issue.code === "local_owner_record_invalid",
  );
  const handleCloudHomeAction = useCallback(async () => {
    if (cloudHomeNeedsConfirmation) {
      setIsConfirmingCloudHome(true);
      try {
        const confirmed =
          await window.electronAPI?.cloudHome.confirmImportOwnership(
            accountScope,
          );
        if (!confirmed) return;
      } finally {
        setIsConfirmingCloudHome(false);
      }
    }
    cloudHomeSyncRetryStore.request();
    void requestMemorySync();
  }, [accountScope, cloudHomeNeedsConfirmation]);
  const cloudHomeSummary = cloudHomeBusy
    ? t("settings.account.cloudHome.summary.checking")
    : cloudHomeStatus.phase === "complete"
      ? t("settings.account.cloudHome.summary.current", {
          skillCount: cloudHomeStatus.skillsUploaded,
        })
      : cloudHomeStatus.phase === "attention"
        ? t("settings.account.cloudHome.summary.attention")
        : cloudHomeStatus.phase === "unavailable"
          ? t("settings.account.cloudHome.summary.unavailable")
          : t("settings.account.cloudHome.summary.intro");

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">
        {t("settings.account.cloudHome.title")}
      </h3>
      <div className="settings-row" data-memory-sync={memorySync?.phase}>
        <div className="settings-row-info">
          <div className="settings-row-label">
            {t("settings.memory.title")}
          </div>
          <div className="settings-row-sublabel" role="status">
            {memorySync?.phase === "synced" &&
            memorySync.merging === 0 &&
            memorySync.lastSyncedAt
              ? t("settings.account.cloudHome.memory.lastSynced", {
                  time: syncedAtLabel(locale, memorySync.lastSyncedAt),
                })
              : memorySyncSummary(t, memorySync)}
          </div>
          {memorySync && memorySync.refused.length > 0 ? (
            <div className="settings-row-sublabel" role="alert">
              {t("settings.account.cloudHome.memory.refused", {
                files: memorySync.refused.join(", "),
              })}
            </div>
          ) : null}
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">
            {t("settings.account.cloudHome.skillsLabel")}
          </div>
          <div className="settings-row-sublabel" role="status">
            {cloudHomeSummary}
          </div>
          {cloudHomeStatus.issues.slice(0, 4).map((issue, index) => (
            <div
              className="settings-row-sublabel"
              role="alert"
              key={`${issue.code}:${issue.item ?? "general"}:${index}`}
            >
              {issue.item ? `${issue.item}: ` : ""}
              {issue.message}
            </div>
          ))}
          {cloudHomeStatus.warnings.slice(0, 3).map((warning, index) => (
            <div
              className="settings-row-sublabel"
              key={`${warning.code}:${warning.path}:${index}`}
            >
              {warning.path}: {warning.message}
            </div>
          ))}
        </div>
        <div className="settings-row-control">
          <Button
            type="button"
            variant="ghost"
            className="pill-btn"
            onClick={() => void handleCloudHomeAction()}
            disabled={
              cloudHomeBusy ||
              isConfirmingCloudHome ||
              cloudHomeOwnerMismatch ||
              cloudHomeOwnerInvalid
            }
          >
            {cloudHomeBusy || isConfirmingCloudHome
              ? t("settings.account.cloudHome.actions.syncing")
              : cloudHomeNeedsConfirmation
                ? t("settings.account.cloudHome.actions.import")
                : cloudHomeOwnerMismatch
                  ? t("settings.account.cloudHome.actions.boundElsewhere")
                  : cloudHomeOwnerInvalid
                    ? t("settings.account.cloudHome.actions.blocked")
                    : t("settings.account.cloudHome.actions.sync")}
          </Button>
        </div>
      </div>
    </div>
  );
}
