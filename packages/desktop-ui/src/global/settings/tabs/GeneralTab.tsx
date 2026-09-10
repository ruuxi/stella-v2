import { useUiState } from "@/context/ui-state";
import { useState } from "react";
import {
  useChatStorageMode,
  setChatStorageMode,
} from "@/features/chat/services/chat-storage-preference";
import { lazy, Suspense } from "react";
import { Select } from "@/ui/select";
import { LanguageSettingsRow } from "@/global/settings/LanguageSettingsRow";
import {
  setReduceMotionPreference,
  useInterfacePreferences,
  type ReduceMotionPreference,
} from "@/shared/lib/interface-preferences";
import { useCloudMemoryPreference } from "@/features/cloud/use-cloud-memory-preference";
import { useT } from "@/shared/i18n";
import { platformCapabilities } from "@/platform/capabilities";
import { SettingsToggleCard } from "./settings-toggle-card";
import { CompanionSettingsCard } from "./CompanionSettingsCard";

const NativeDesktopGeneralSettings = lazy(() =>
  import("./NativeGeneralSettings").then((module) => ({
    default: module.NativeDesktopGeneralSettings,
  })),
);

const NativePermissionSettings = lazy(() =>
  import("./NativePermissionSettings").then((module) => ({
    default: module.NativePermissionSettings,
  })),
);

export function GeneralTab() {
  const t = useT();
  const storageMode = useChatStorageMode();
  const { state: uiState } = useUiState();
  const [storageError, setStorageError] = useState<string | null>(null);
  const [savingStorage, setSavingStorage] = useState(false);
  const memoryPreference = useCloudMemoryPreference();
  const { reduceMotion } = useInterfacePreferences();

  return (
    <div className="settings-tab-content">
      <LanguageSettingsRow />
      {platformCapabilities.nativeSettings ? (
        <SettingsToggleCard
          title={t("settings.chatStorage.title")}
          description={t("settings.chatStorage.description")}
          checked={storageMode === "cloud"}
          disabled={savingStorage || uiState.isVoiceRtcActive}
          error={
            storageError ??
            (uiState.isVoiceRtcActive
              ? t("settings.chatStorage.endVoice")
              : null)
          }
          onChange={(enabled) => {
            setSavingStorage(true);
            setStorageError(null);
            void setChatStorageMode(enabled ? "cloud" : "local")
              .catch(() => setStorageError(t("settings.chatStorage.error")))
              .finally(() => setSavingStorage(false));
          }}
        />
      ) : null}
      <SettingsToggleCard
        title={t("settings.memory.title")}
        description={t("settings.memory.description")}
        error={
          memoryPreference.issue
            ? t(
                memoryPreference.issue === "load"
                  ? "settings.errors.loadMemory"
                  : "settings.errors.saveMemory",
              )
            : null
        }
        checked={memoryPreference.memoryEnabled}
        disabled={
          memoryPreference.disabled || memoryPreference.status === "error"
        }
        onChange={(checked) => void memoryPreference.setMemoryEnabled(checked)}
        retry={
          memoryPreference.issue
            ? () => void memoryPreference.retry()
            : undefined
        }
        retryLabel={t("common.tryAgain")}
      />
      {platformCapabilities.nativeSettings ? <CompanionSettingsCard /> : null}
      {platformCapabilities.nativeSettings ? (
        <Suspense fallback={null}>
          <NativePermissionSettings />
        </Suspense>
      ) : null}
      <div className="settings-card">
        <h3 className="settings-card-title">{t("settings.motion.title")}</h3>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">
              {t("settings.motion.reduceMotion.label")}
            </div>
            <div className="settings-row-sublabel">
              {t("settings.motion.reduceMotion.description")}
            </div>
          </div>
          <div className="settings-row-control">
            <Select
              className="settings-runtime-select"
              value={reduceMotion}
              aria-label={t("settings.motion.reduceMotion.label")}
              onValueChange={(value) =>
                setReduceMotionPreference(value as ReduceMotionPreference)
              }
              options={[
                {
                  value: "system",
                  label: t("settings.motion.reduceMotion.system"),
                },
                {
                  value: "on",
                  label: t("settings.motion.reduceMotion.on"),
                },
                {
                  value: "off",
                  label: t("settings.motion.reduceMotion.off"),
                },
              ]}
            />
          </div>
        </div>
      </div>
      {platformCapabilities.nativeSettings ? (
        <Suspense fallback={null}>
          <NativeDesktopGeneralSettings />
        </Suspense>
      ) : null}
    </div>
  );
}
