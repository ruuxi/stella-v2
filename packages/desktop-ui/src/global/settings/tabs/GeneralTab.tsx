import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/ui/button";
import { Select } from "@/ui/select";
import { Switch } from "@/ui/switch";
import { LanguageSettingsRow } from "@/global/settings/LanguageSettingsRow";
import { PromptPresetCard } from "@/global/settings/PromptPresetCard";
import {
  useDesktopPermissions,
  type DesktopPermissionStatus,
} from "@/global/permissions/use-desktop-permissions";
import { requestBrowserMicrophoneAccess } from "@/global/permissions/microphone-permission";
import {
  setDeveloperResourcePreviewsEnabled,
  useDeveloperResourcePreviewsEnabled,
} from "@/shared/lib/developer-resource-previews";
import {
  setNativeFontSmoothingEnabled,
  useNativeFontSmoothingEnabled,
} from "@/shared/lib/native-font-smoothing";
import {
  setReduceMotionPreference,
  useInterfacePreferences,
  type ReduceMotionPreference,
} from "@/shared/lib/interface-preferences";
import { openExternalUrl } from "@/platform/electron/open-external";
import { useCloudMemoryPreference } from "@/features/cloud/use-cloud-memory-preference";
import { useT } from "@/shared/i18n";
import type { LockedComputerUseStatus } from "@/shared/types/electron";
import { STELLA_BROWSER_EXTENSION_STORE_URL } from "@stella/contracts/browser-extension";
import { getSettingsErrorMessage } from "./shared";

const SETTINGS_PERMISSION_RESTART_KINDS = ["screen"] as const;
const ACCESSIBILITY_RESET_CONFIRM_TIMEOUT_MS = 8_000;

type PermissionKind = "accessibility" | "screen" | "microphone";

const isMacAdminPromptCancelled = (error: unknown) => {
  const message =
    error instanceof Error ? error.message : String(error ?? "");
  return (
    message.includes("User canceled") ||
    message.includes("(-128)") ||
    message.includes("error -128")
  );
};

export function GeneralTab() {
  const t = useT();
  const memoryPreference = useCloudMemoryPreference();
  const platform = window.electronAPI?.platform;
  const developerResourcePreviewsEnabled =
    useDeveloperResourcePreviewsEnabled();
  const nativeFontSmoothingEnabled = useNativeFontSmoothingEnabled();
  const { reduceMotion } = useInterfacePreferences();
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
  const initialPermissionStatus = useMemo<DesktopPermissionStatus>(
    () => ({
      accessibility: platform === "darwin" ? false : true,
      screen: platform === "darwin" ? false : true,
      microphone: platform === "darwin" ? false : true,
      microphoneStatus: platform === "darwin" ? "unknown" : "granted",
    }),
    [platform],
  );

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
            status && !status.ok
              ? status.message
              : null,
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

  const formatPermissionLoadError = useCallback(
    (error: unknown) =>
      getSettingsErrorMessage(error, t("settings.errors.loadPermissions")),
    [t],
  );
  // macOS reports Screen Capture as off in-process until Stella is relaunched.
  // screenSettingsOpenedRef tracks that we sent the user to System Settings for
  // it; screenRestartPendingRef records that they came back with it still off
  // (so they almost certainly enabled it and just need a relaunch).
  const screenSettingsOpenedRef = useRef(false);
  const screenRestartPendingRef = useRef(false);
  const normalizePermissionStatus = useCallback(
    (result: DesktopPermissionStatus): DesktopPermissionStatus => ({
      ...result,
      screen: result.screen || screenRestartPendingRef.current,
    }),
    [],
  );

  const {
    status: permissionStatus,
    loaded: permissionsLoaded,
    error: permissionsError,
    setError: setPermissionsError,
    activeAction: activePermissionAction,
    cooldownAction: permissionCooldownAction,
    restartRecommended: screenRestartRecommended,
    isRestarting: isRestartingAfterPermissions,
    refresh: refreshPermissions,
    requestWithSettingsFallback,
    restart: restartAfterPermissionChange,
  } = useDesktopPermissions({
    enabled: platform === "darwin",
    pollMs: 1500,
    initialStatus: initialPermissionStatus,
    restartKinds: SETTINGS_PERMISSION_RESTART_KINDS,
    normalizeStatus: normalizePermissionStatus,
    errorMessage: formatPermissionLoadError,
  });

  // Returning from System Settings frequently does not fire a visibilitychange
  // (the window was never occluded), so also listen for window focus. When the
  // user comes back and Screen Capture still reads off, promote it to
  // "pending restart" so the restart affordance appears instead of a row that
  // is stuck at "Enable" forever.
  useEffect(() => {
    if (platform !== "darwin") return;

    const markScreenPendingAfterSettingsReturn = () => {
      if (
        !screenSettingsOpenedRef.current ||
        screenRestartPendingRef.current ||
        document.visibilityState === "hidden"
      ) {
        return;
      }
      void refreshPermissions().then((latestStatus) => {
        if (!screenSettingsOpenedRef.current || latestStatus.screen) {
          screenSettingsOpenedRef.current = false;
          return;
        }
        screenRestartPendingRef.current = true;
        screenSettingsOpenedRef.current = false;
        void refreshPermissions();
      });
    };

    window.addEventListener("focus", markScreenPendingAfterSettingsReturn);
    document.addEventListener(
      "visibilitychange",
      markScreenPendingAfterSettingsReturn,
    );
    return () => {
      window.removeEventListener("focus", markScreenPendingAfterSettingsReturn);
      document.removeEventListener(
        "visibilitychange",
        markScreenPendingAfterSettingsReturn,
      );
    };
  }, [platform, refreshPermissions]);

  // Clear a stale "still off / turn it on in System Settings" banner the moment
  // a live poll detects a permission flipping on, so the user is never told a
  // permission is off after they have already enabled it.
  const prevPermissionStatusRef = useRef(permissionStatus);
  useEffect(() => {
    const prev = prevPermissionStatusRef.current;
    const newlyGranted =
      (!prev.accessibility && permissionStatus.accessibility) ||
      (!prev.screen && permissionStatus.screen) ||
      (!prev.microphone && permissionStatus.microphone);
    prevPermissionStatusRef.current = permissionStatus;
    if (newlyGranted) {
      setPermissionsError(null);
    }
  }, [permissionStatus, setPermissionsError]);

  const [requestingMicrophonePermission, setRequestingMicrophonePermission] =
    useState(false);
  // Guard + cooldown so repeated clicks can't stack openExternal calls against
  // the System Settings URL (which corrupts its view). The ref reads the live
  // busy state without a stale closure; the button stays disabled until the
  // cooldown clears.
  const microphoneBusyRef = useRef(false);
  const microphoneCooldownTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (microphoneCooldownTimerRef.current !== null) {
        window.clearTimeout(microphoneCooldownTimerRef.current);
      }
    },
    [],
  );

  const requestMicrophonePermission = useCallback(async () => {
    if (microphoneBusyRef.current) return;
    microphoneBusyRef.current = true;
    setRequestingMicrophonePermission(true);
    try {
      const latestStatus = await refreshPermissions();
      if (latestStatus.microphone) return;

      if (latestStatus.microphoneStatus === "denied") {
        await window.electronAPI?.system.openPermissionSettings?.("microphone");
        throw new Error(t("settings.errors.microphoneDeniedReopen"));
      }

      await requestBrowserMicrophoneAccess();

      const nextStatus = await refreshPermissions();
      if (!nextStatus.microphone) {
        throw new Error(t("settings.errors.microphoneStillOff"));
      }
    } finally {
      if (microphoneCooldownTimerRef.current !== null) {
        window.clearTimeout(microphoneCooldownTimerRef.current);
      }
      microphoneCooldownTimerRef.current = window.setTimeout(() => {
        microphoneBusyRef.current = false;
        microphoneCooldownTimerRef.current = null;
        setRequestingMicrophonePermission(false);
      }, 2000);
    }
  }, [refreshPermissions, t]);

  const handlePermissionEnable = useCallback(
    async (kind: PermissionKind) => {
      setPermissionsError(null);
      try {
        if (kind === "microphone") {
          await requestMicrophonePermission();
        } else if (kind === "screen") {
          const nextStatus = await requestWithSettingsFallback("screen");
          // We've sent the user to System Settings for Screen Capture. Record
          // that so the focus/visibility listener can promote it to "granted —
          // restart to finish" when they return and macOS still reports it off.
          if (!nextStatus.screen) {
            screenSettingsOpenedRef.current = true;
          }
        } else {
          await requestWithSettingsFallback(kind);
        }
      } catch (error) {
        setPermissionsError(
          getSettingsErrorMessage(
            error,
            t("settings.errors.savePermission", { kind }),
          ),
        );
      }
    },
    [
      requestMicrophonePermission,
      requestWithSettingsFallback,
      setPermissionsError,
      t,
    ],
  );

  const handlePermissionRestart = useCallback(async () => {
    setPermissionsError(null);
    try {
      await restartAfterPermissionChange();
    } catch (error) {
      setPermissionsError(
        getSettingsErrorMessage(error, t("settings.errors.restart")),
      );
    }
  }, [restartAfterPermissionChange, setPermissionsError, t]);

  const [resettingPermission, setResettingPermission] =
    useState<PermissionKind | null>(null);
  const [confirmingAccessibilityReset, setConfirmingAccessibilityReset] =
    useState(false);

  useEffect(() => {
    if (!confirmingAccessibilityReset) return;
    const timeoutId = window.setTimeout(() => {
      setConfirmingAccessibilityReset(false);
    }, ACCESSIBILITY_RESET_CONFIRM_TIMEOUT_MS);
    return () => window.clearTimeout(timeoutId);
  }, [confirmingAccessibilityReset]);

  const handlePermissionReset = useCallback(
    async (kind: PermissionKind) => {
      if (kind === "accessibility" && !confirmingAccessibilityReset) {
        setPermissionsError(null);
        setConfirmingAccessibilityReset(true);
        return;
      }

      const reset = window.electronAPI?.system.resetPermission;
      if (!reset) return;
      setPermissionsError(null);
      setConfirmingAccessibilityReset(false);
      setResettingPermission(kind);
      try {
        const result = await reset(kind);
        if (!result?.ok) {
          setPermissionsError(
            t("settings.errors.resetPermissionMaybeReopen", { kind }),
          );
        }
      } catch (error) {
        setPermissionsError(
          getSettingsErrorMessage(
            error,
            t("settings.errors.resetPermission", { kind }),
          ),
        );
      } finally {
        setResettingPermission(null);
      }
    },
    [confirmingAccessibilityReset, setPermissionsError, t],
  );

  // Single-row toggle cards: collapse the eyebrow into the card title so
  // we don't stack title → eyebrow → sublabel for one switch.
  const renderToggleCard = (args: {
    title: string;
    description: string;
    error: string | null;
    checked: boolean;
    disabled: boolean;
    onChange: (checked: boolean) => void;
    retry?: () => void;
  }) => (
    <div className="settings-card">
      <div className="settings-card-header">
        <h3 className="settings-card-title">{args.title}</h3>
        <Switch
          checked={args.checked}
          disabled={args.disabled}
          onCheckedChange={(checked) => args.onChange(Boolean(checked))}
          hideLabel
        />
      </div>
      <p className="settings-card-desc">{args.description}</p>
      {args.error ? (
        <>
          <p
            className="settings-card-desc settings-card-desc--error"
            role="alert"
          >
            {args.error}
          </p>
          {args.retry ? (
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              onClick={args.retry}
            >
              {t("common.tryAgain")}
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );

  const permissionStatusLabel = useCallback(
    (granted: boolean, opening: boolean) =>
      granted
        ? t("settings.permissions.granted")
        : opening
          ? t("settings.permissions.opening")
          : t("settings.permissions.enable"),
    [t],
  );

  const permissionsCard =
    platform === "darwin" ? (
      <div className="settings-card">
        <h3 className="settings-card-title">
          {t("settings.permissions.title")}
        </h3>
        {permissionsError ? (
          <p
            className="settings-card-desc settings-card-desc--error"
            role="alert"
          >
            {permissionsError}
          </p>
        ) : null}
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">
              {t("settings.permissions.accessibility.label")}
            </div>
            <div className="settings-row-sublabel">
              {t("settings.permissions.accessibility.description")}
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              disabled={
                !permissionsLoaded ||
                permissionStatus.accessibility ||
                activePermissionAction === "accessibility" ||
                permissionCooldownAction === "accessibility"
              }
              onClick={() => void handlePermissionEnable("accessibility")}
            >
              {permissionStatusLabel(
                permissionStatus.accessibility,
                activePermissionAction === "accessibility" ||
                  permissionCooldownAction === "accessibility",
              )}
            </Button>
            <PermissionResetButton
              disabled={
                !permissionsLoaded || resettingPermission === "accessibility"
              }
              onClick={() => void handlePermissionReset("accessibility")}
              label={
                confirmingAccessibilityReset
                  ? t("settings.permissions.restart.action")
                  : t("settings.permissions.reset")
              }
            />
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">
              {t("settings.permissions.screen.label")}
            </div>
            <div className="settings-row-sublabel">
              {t("settings.permissions.screen.description")}
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              disabled={
                !permissionsLoaded ||
                permissionStatus.screen ||
                activePermissionAction === "screen" ||
                permissionCooldownAction === "screen"
              }
              onClick={() => void handlePermissionEnable("screen")}
            >
              {permissionStatusLabel(
                permissionStatus.screen,
                activePermissionAction === "screen" ||
                  permissionCooldownAction === "screen",
              )}
            </Button>
            <PermissionResetButton
              disabled={
                !permissionsLoaded || resettingPermission === "screen"
              }
              onClick={() => void handlePermissionReset("screen")}
              label={t("settings.permissions.reset")}
            />
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">
              {t("settings.permissions.microphone.label")}
            </div>
            <div className="settings-row-sublabel">
              {t("settings.permissions.microphone.description")}
            </div>
          </div>
          <div className="settings-row-control">
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              disabled={
                !permissionsLoaded ||
                permissionStatus.microphone ||
                requestingMicrophonePermission
              }
              onClick={() => void handlePermissionEnable("microphone")}
            >
              {permissionStatusLabel(
                permissionStatus.microphone,
                requestingMicrophonePermission,
              )}
            </Button>
            <PermissionResetButton
              disabled={
                !permissionsLoaded || resettingPermission === "microphone"
              }
              onClick={() => void handlePermissionReset("microphone")}
              label={t("settings.permissions.reset")}
            />
          </div>
        </div>
        {screenRestartRecommended ? (
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">
                {t("settings.permissions.restart.label")}
              </div>
              <div className="settings-row-sublabel">
                {t("settings.permissions.restart.description")}
              </div>
            </div>
            <div className="settings-row-control">
              <Button
                type="button"
                variant="ghost"
                className="pill-btn pill-btn--danger"
                disabled={isRestartingAfterPermissions}
                onClick={() => void handlePermissionRestart()}
              >
                {isRestartingAfterPermissions
                  ? t("settings.permissions.restart.closing")
                  : t("settings.permissions.restart.action")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    ) : null;

  return (
    <>
      <div className="settings-tab-content">
        <LanguageSettingsRow />
        {renderToggleCard({
          title: t("settings.memory.title"),
          description: t("settings.memory.description"),
          error: memoryPreference.issue
            ? t(
                memoryPreference.issue === "load"
                  ? "settings.errors.loadMemory"
                  : "settings.errors.saveMemory",
              )
            : null,
          checked: memoryPreference.memoryEnabled,
          disabled:
            memoryPreference.disabled || memoryPreference.status === "error",
          onChange: (checked) =>
            void memoryPreference.setMemoryEnabled(checked),
          retry: memoryPreference.issue
            ? () => void memoryPreference.retry()
            : undefined,
        })}
        {permissionsCard}
        <div className="settings-card">
          <h3 className="settings-card-title">
            {t("settings.motion.title")}
          </h3>
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
        {platform === "darwin"
          ? renderToggleCard({
              title: t("settings.nativeFontSmoothing.title"),
              description: t("settings.nativeFontSmoothing.description"),
              error: null,
              checked: nativeFontSmoothingEnabled,
              disabled: false,
              onChange: (checked) => setNativeFontSmoothingEnabled(checked),
            })
          : null}
        {renderToggleCard({
          title: t("settings.notifications.title"),
          description: t("settings.notifications.description"),
          error: soundNotificationsError,
          checked: soundNotificationsEnabled,
          disabled: !soundNotificationsLoaded || isSavingSoundNotifications,
          onChange: (checked) => void handleSoundNotificationsChange(checked),
        })}
        {renderToggleCard({
          title: t("settings.power.title"),
          description: t("settings.power.description"),
          error: preventSleepError,
          checked: preventComputerSleep,
          disabled: !preventSleepLoaded || isSavingPreventSleep,
          onChange: (checked) => void handlePreventSleepChange(checked),
        })}
        {renderToggleCard({
          title: t("settings.lockedComputerUse.title"),
          description:
            platform === "darwin"
              ? t("settings.lockedComputerUse.description")
              : t("settings.lockedComputerUse.unsupported"),
          error: lockedComputerUseError,
          checked: lockedComputerUseStatus?.enabled === true,
          disabled:
            platform !== "darwin" ||
            !lockedComputerUseLoaded ||
            isSavingLockedComputerUse,
          onChange: (checked) => void handleLockedComputerUseChange(checked),
        })}
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
        <div className="settings-card">
          <div className="settings-card-header">
            <h3 className="settings-card-title">
              {t("settings.browserExtension.title")}
            </h3>
            <Button
              type="button"
              variant="ghost"
              className="pill-btn"
              onClick={() =>
                openExternalUrl(STELLA_BROWSER_EXTENSION_STORE_URL)
              }
            >
              {t("settings.browserExtension.action")}
            </Button>
          </div>
          <p className="settings-card-desc">
            {t("settings.browserExtension.description")}
          </p>
        </div>
        <PromptPresetCard />
      </div>
    </>
  );
}

// Reset is rare and slightly destructive — render it as a small icon-style
// affordance next to Enable rather than a co-equal pill so users don't
// nuke their TCC entry by accident.
function PermissionResetButton({
  disabled,
  onClick,
  label,
}: {
  disabled: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      className="pill-btn pill-btn--quiet pill-btn--danger"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {label}
    </Button>
  );
}
