import { useCallback, useEffect, useState } from "react";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { PromptPresetCard } from "@/global/settings/PromptPresetCard";
import {
  setDeveloperResourcePreviewsEnabled,
  useDeveloperResourcePreviewsEnabled,
} from "@/shared/lib/developer-resource-previews";
import {
  setNativeFontSmoothingEnabled,
  useNativeFontSmoothingEnabled,
} from "@/shared/lib/native-font-smoothing";
import { openExternalUrl } from "@/platform/electron/open-external";
import { useT } from "@/shared/i18n";
import type { LockedComputerUseStatus } from "@/shared/types/electron";
import { STELLA_BROWSER_EXTENSION_STORE_URL } from "@stella/contracts/browser-extension";
import { getSettingsErrorMessage } from "./shared";
import { SettingsToggleCard } from "./settings-toggle-card";
import { OnboardingReplayCard } from "@/global/onboarding/chat/OnboardingReplayCard";

const isMacAdminPromptCancelled = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message.includes("User canceled") ||
    message.includes("(-128)") ||
    message.includes("error -128")
  );
};

export function NativeDesktopGeneralSettings() {
  const t = useT();
  const platform = window.electronAPI?.platform;
  const developerResourcePreviewsEnabled =
    useDeveloperResourcePreviewsEnabled();
  const nativeFontSmoothingEnabled = useNativeFontSmoothingEnabled();
  const [preventComputerSleep, setPreventComputerSleep] = useState(false);
  const [preventSleepLoaded, setPreventSleepLoaded] = useState(false);
  const [isSavingPreventSleep, setIsSavingPreventSleep] = useState(false);
  const [preventSleepError, setPreventSleepError] = useState<string | null>(
    null,
  );
  const [lockedComputerUseStatus, setLockedComputerUseStatus] =
    useState<LockedComputerUseStatus | null>(null);
  const [lockedComputerUseLoaded, setLockedComputerUseLoaded] = useState(false);
  const [isSavingLockedComputerUse, setIsSavingLockedComputerUse] =
    useState(false);
  const [lockedComputerUseError, setLockedComputerUseError] = useState<
    string | null
  >(null);
  const [soundNotificationsEnabled, setSoundNotificationsEnabled] =
    useState(true);
  const [soundNotificationsLoaded, setSoundNotificationsLoaded] =
    useState(false);
  const [isSavingSoundNotifications, setIsSavingSoundNotifications] =
    useState(false);
  const [soundNotificationsError, setSoundNotificationsError] = useState<
    string | null
  >(null);
  const [isResettingCustomizations, setIsResettingCustomizations] =
    useState(false);
  const [resetCustomizationsStatus, setResetCustomizationsStatus] = useState<{
    kind: "done" | "none" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const enabled =
          await window.electronAPI?.system?.getPreventComputerSleep?.();
        if (!cancelled) {
          setPreventComputerSleep(enabled === true);
          setPreventSleepError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setPreventSleepError(
            getSettingsErrorMessage(error, t("settings.errors.loadPower")),
          );
        }
      } finally {
        if (!cancelled) setPreventSleepLoaded(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const status =
          await window.electronAPI?.system?.getLockedComputerUseStatus?.();
        if (!cancelled) {
          setLockedComputerUseStatus(status ?? null);
          setLockedComputerUseError(
            status && !status.ok ? status.message : null,
          );
        }
      } catch (error) {
        if (!cancelled) {
          setLockedComputerUseError(
            getSettingsErrorMessage(
              error,
              t("settings.errors.loadLockedComputerUse"),
            ),
          );
        }
      } finally {
        if (!cancelled) setLockedComputerUseLoaded(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const enabled =
          await window.electronAPI?.system?.getSoundNotificationsEnabled?.();
        if (!cancelled) {
          setSoundNotificationsEnabled(enabled !== false);
          setSoundNotificationsError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setSoundNotificationsError(
            getSettingsErrorMessage(
              error,
              t("settings.errors.loadSoundNotifications"),
            ),
          );
        }
      } finally {
        if (!cancelled) setSoundNotificationsLoaded(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [t]);

  const handlePreventSleepChange = useCallback(
    async (checked: boolean) => {
      const systemApi = window.electronAPI?.system;
      if (!systemApi?.setPreventComputerSleep) {
        setPreventSleepError(t("settings.errors.powerUnavailable"));
        return;
      }

      const previous = preventComputerSleep;
      setPreventComputerSleep(checked);
      setPreventSleepError(null);
      setIsSavingPreventSleep(true);
      try {
        const result = await systemApi.setPreventComputerSleep(checked);
        setPreventComputerSleep(result.enabled);
      } catch (error) {
        setPreventComputerSleep(previous);
        setPreventSleepError(
          getSettingsErrorMessage(error, t("settings.errors.savePower")),
        );
      } finally {
        setIsSavingPreventSleep(false);
      }
    },
    [preventComputerSleep, t],
  );

  const handleLockedComputerUseChange = useCallback(
    async (checked: boolean) => {
      const systemApi = window.electronAPI?.system;
      if (!systemApi?.setLockedComputerUseEnabled) {
        setLockedComputerUseError(
          t("settings.errors.lockedComputerUseUnavailable"),
        );
        return;
      }

      const previous = lockedComputerUseStatus;
      if (previous) {
        setLockedComputerUseStatus({ ...previous, enabled: checked });
      }
      setLockedComputerUseError(null);
      setIsSavingLockedComputerUse(true);
      try {
        const result = await systemApi.setLockedComputerUseEnabled(checked);
        setLockedComputerUseStatus(result);
        setLockedComputerUseError(
          result.ok
            ? null
            : result.message || t("settings.errors.saveLockedComputerUse"),
        );
      } catch (error) {
        setLockedComputerUseStatus(previous);
        if (isMacAdminPromptCancelled(error)) {
          setLockedComputerUseError(null);
          return;
        }
        setLockedComputerUseError(
          getSettingsErrorMessage(
            error,
            t("settings.errors.saveLockedComputerUse"),
          ),
        );
      } finally {
        setIsSavingLockedComputerUse(false);
      }
    },
    [lockedComputerUseStatus, t],
  );

  const handleResetCustomizations = useCallback(async () => {
    const systemApi = window.electronAPI?.system;
    if (!systemApi?.resetCustomizations) {
      setResetCustomizationsStatus({
        kind: "error",
        message: t("settings.resetCustomizations.error"),
      });
      return;
    }
    setIsResettingCustomizations(true);
    setResetCustomizationsStatus(null);
    try {
      const result = await systemApi.resetCustomizations();
      if (!result.ok) {
        setResetCustomizationsStatus({
          kind: "error",
          message: result.error ?? t("settings.resetCustomizations.error"),
        });
      } else if (result.movedEntries.length === 0) {
        setResetCustomizationsStatus({
          kind: "none",
          message: t("settings.resetCustomizations.none"),
        });
      } else {
        setResetCustomizationsStatus({
          kind: "done",
          message: t("settings.resetCustomizations.done"),
        });
      }
    } catch (error) {
      setResetCustomizationsStatus({
        kind: "error",
        message: getSettingsErrorMessage(
          error,
          t("settings.resetCustomizations.error"),
        ),
      });
    } finally {
      setIsResettingCustomizations(false);
    }
  }, [t]);

  const handleSoundNotificationsChange = useCallback(
    async (checked: boolean) => {
      const systemApi = window.electronAPI?.system;
      if (!systemApi?.setSoundNotificationsEnabled) {
        setSoundNotificationsError(
          t("settings.errors.soundNotificationsUnavailable"),
        );
        return;
      }

      const previous = soundNotificationsEnabled;
      setSoundNotificationsEnabled(checked);
      setSoundNotificationsError(null);
      setIsSavingSoundNotifications(true);
      try {
        const result = await systemApi.setSoundNotificationsEnabled(checked);
        setSoundNotificationsEnabled(result.enabled);
      } catch (error) {
        setSoundNotificationsEnabled(previous);
        setSoundNotificationsError(
          getSettingsErrorMessage(
            error,
            t("settings.errors.saveSoundNotifications"),
          ),
        );
      } finally {
        setIsSavingSoundNotifications(false);
      }
    },
    [soundNotificationsEnabled, t],
  );

  return (
    <>
      <div className="settings-card">
        <div className="settings-card-header">
          <h3 className="settings-card-title">
            {t("settings.developerPreviews.title")}
          </h3>
          <Switch
            checked={developerResourcePreviewsEnabled}
            onCheckedChange={(checked) =>
              setDeveloperResourcePreviewsEnabled(Boolean(checked))
            }
            hideLabel
          />
        </div>
        <p className="settings-card-desc">
          {t("settings.developerPreviews.description")}
        </p>
      </div>
      {platform === "darwin" ? (
        <SettingsToggleCard
          title={t("settings.nativeFontSmoothing.title")}
          description={t("settings.nativeFontSmoothing.description")}
          error={null}
          checked={nativeFontSmoothingEnabled}
          disabled={false}
          onChange={(checked) => setNativeFontSmoothingEnabled(checked)}
        />
      ) : null}
      <SettingsToggleCard
        title={t("settings.notifications.title")}
        description={t("settings.notifications.description")}
        error={soundNotificationsError}
        checked={soundNotificationsEnabled}
        disabled={!soundNotificationsLoaded || isSavingSoundNotifications}
        onChange={(checked) => void handleSoundNotificationsChange(checked)}
      />
      <SettingsToggleCard
        title={t("settings.power.title")}
        description={t("settings.power.description")}
        error={preventSleepError}
        checked={preventComputerSleep}
        disabled={!preventSleepLoaded || isSavingPreventSleep}
        onChange={(checked) => void handlePreventSleepChange(checked)}
      />
      <SettingsToggleCard
        title={t("settings.lockedComputerUse.title")}
        description={
          platform === "darwin"
            ? t("settings.lockedComputerUse.description")
            : t("settings.lockedComputerUse.unsupported")
        }
        error={lockedComputerUseError}
        checked={lockedComputerUseStatus?.enabled === true}
        disabled={
          platform !== "darwin" ||
          !lockedComputerUseLoaded ||
          isSavingLockedComputerUse
        }
        onChange={(checked) => void handleLockedComputerUseChange(checked)}
      />
      <div className="settings-card">
        <div className="settings-card-header">
          <h3 className="settings-card-title">
            {t("settings.resetCustomizations.title")}
          </h3>
          <Button
            type="button"
            variant="ghost"
            className="pill-btn"
            disabled={isResettingCustomizations}
            onClick={() => void handleResetCustomizations()}
          >
            {t("settings.resetCustomizations.action")}
          </Button>
        </div>
        <p
          className={
            resetCustomizationsStatus?.kind === "error"
              ? "settings-card-desc settings-card-desc--error"
              : "settings-card-desc"
          }
          role={
            resetCustomizationsStatus?.kind === "error" ? "alert" : undefined
          }
        >
          {resetCustomizationsStatus?.message ??
            t("settings.resetCustomizations.description")}
        </p>
      </div>
      <OnboardingReplayCard />
      <div className="settings-card">
        <div className="settings-card-header">
          <h3 className="settings-card-title">
            {t("settings.browserExtension.title")}
          </h3>
          <Button
            type="button"
            variant="ghost"
            className="pill-btn"
            onClick={() => openExternalUrl(STELLA_BROWSER_EXTENSION_STORE_URL)}
          >
            {t("settings.browserExtension.action")}
          </Button>
        </div>
        <p className="settings-card-desc">
          {t("settings.browserExtension.description")}
        </p>
      </div>
      <PromptPresetCard />
    </>
  );
}
