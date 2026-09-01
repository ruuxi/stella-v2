import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/ui/button";
import {
  useDesktopPermissions,
  type DesktopPermissionStatus,
} from "@/global/permissions/use-desktop-permissions";
import { requestBrowserMicrophoneAccess } from "@/global/permissions/microphone-permission";
import { useT } from "@/shared/i18n";
import { getSettingsErrorMessage } from "./shared";

const MAC_PERMISSION_INITIAL_STATUS: DesktopPermissionStatus = {
  accessibility: false,
  screen: false,
  microphone: false,
  microphoneStatus: "unknown",
};
const SETTINGS_PERMISSION_RESTART_KINDS = ["screen"] as const;
const ACCESSIBILITY_RESET_CONFIRM_TIMEOUT_MS = 8_000;

type PermissionKind = "accessibility" | "screen" | "microphone";

export function NativePermissionSettings() {
  if (window.electronAPI?.platform !== "darwin") return null;
  return <MacPermissionSettings />;
}

function MacPermissionSettings() {
  const t = useT();
  const formatPermissionLoadError = useCallback(
    (error: unknown) =>
      getSettingsErrorMessage(error, t("settings.errors.loadPermissions")),
    [t],
  );
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
    enabled: true,
    pollMs: 1500,
    initialStatus: MAC_PERMISSION_INITIAL_STATUS,
    restartKinds: SETTINGS_PERMISSION_RESTART_KINDS,
    normalizeStatus: normalizePermissionStatus,
    errorMessage: formatPermissionLoadError,
  });

  useEffect(() => {
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
  }, [refreshPermissions]);

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

  const permissionStatusLabel = useCallback(
    (granted: boolean, opening: boolean) =>
      granted
        ? t("settings.permissions.granted")
        : opening
          ? t("settings.permissions.opening")
          : t("settings.permissions.enable"),
    [t],
  );

  return (
    <div className="settings-card">
      <h3 className="settings-card-title">{t("settings.permissions.title")}</h3>
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
            disabled={!permissionsLoaded || resettingPermission === "screen"}
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
  );
}

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
