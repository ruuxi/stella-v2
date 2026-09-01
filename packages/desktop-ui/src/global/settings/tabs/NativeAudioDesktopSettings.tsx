import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Switch } from "@/ui/switch";
import {
  isLocalDictationEnabled,
  isLocalDictationPlatform,
  setLocalDictationPreference,
} from "@/features/dictation/services/inworld-dictation";
import { useMicrophoneRecovery } from "@/global/permissions/use-microphone-recovery";
import { useT } from "@/shared/i18n";

export async function darwinMicrophoneIsDenied(): Promise<boolean> {
  if (window.electronAPI?.platform !== "darwin") return false;
  const status = await window.electronAPI.system.getPermissionStatus?.();
  return status?.microphoneStatus === "denied";
}

export function NativeAudioDesktopRows({
  micEnabled,
  afterWakeWord,
  afterSounds,
}: {
  micEnabled: boolean;
  afterWakeWord: ReactNode;
  afterSounds: ReactNode;
}) {
  return (
    <>
      <NativeMicrophoneRecoveryRow />
      <NativeWakeWordRow micEnabled={micEnabled} />
      {afterWakeWord}
      <NativeDictationSoundsRow />
      {afterSounds}
      <NativeLocalDictationRow micEnabled={micEnabled} />
    </>
  );
}

type MicrophonePermissionStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

export function NativeMicrophoneRecoveryRow() {
  if (window.electronAPI?.platform !== "darwin") return null;
  return <MacMicrophoneRecoveryRow />;
}

function MacMicrophoneRecoveryRow() {
  const t = useT();
  const microphoneRecovery = useMicrophoneRecovery();
  const [microphoneStatus, setMicrophoneStatus] =
    useState<MicrophonePermissionStatus>("unknown");

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.system.getPermissionStatus?.().then((result) => {
      if (!cancelled && result) setMicrophoneStatus(result.microphoneStatus);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const microphoneDenied = microphoneStatus === "denied";

  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <div className="settings-row-label">
          {microphoneDenied
            ? t("settings.audio.recovery.recoverLabel")
            : t("settings.audio.recovery.manageLabel")}
        </div>
        <div className="settings-row-sublabel">
          {microphoneDenied
            ? t("settings.audio.recovery.recoverDescription")
            : t("settings.audio.recovery.manageDescription")}
        </div>
      </div>
      <div className="settings-row-control settings-row-control--stacked">
        <button
          type="button"
          className="pill-btn"
          disabled={microphoneRecovery.isResetting}
          onClick={microphoneRecovery.openSettings}
        >
          {t("settings.audio.recovery.openSettings")}
        </button>
        <button
          type="button"
          className="pill-btn pill-btn--danger"
          disabled={microphoneRecovery.isResetting}
          onClick={() => void microphoneRecovery.resetAndRestart()}
        >
          {microphoneRecovery.isResetting
            ? t("settings.audio.recovery.closing")
            : t("settings.audio.recovery.reset")}
        </button>
      </div>
    </div>
  );
}

export function NativeWakeWordRow({ micEnabled }: { micEnabled: boolean }) {
  const t = useT();
  const [wakeWordEnabled, setWakeWordEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.system
      ?.getWakeWordEnabled?.()
      .then((enabled) => {
        if (cancelled) return;
        const nextEnabled = micEnabled && enabled;
        setWakeWordEnabled(nextEnabled);
        if (enabled && !nextEnabled) {
          void window.electronAPI?.system?.setWakeWordEnabled?.(false);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [micEnabled]);

  useEffect(() => {
    if (micEnabled || !wakeWordEnabled) return;
    setWakeWordEnabled(false);
    void window.electronAPI?.system?.setWakeWordEnabled?.(false);
  }, [micEnabled, wakeWordEnabled]);

  const handleWakeWordToggle = useCallback((checked: boolean) => {
    setWakeWordEnabled(checked);
    void window.electronAPI?.system?.setWakeWordEnabled?.(checked).catch(() => {
      setWakeWordEnabled(!checked);
    });
  }, []);

  if (!micEnabled) return null;

  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <div className="settings-row-label">
          {t("settings.audio.wakeWord.label")}
        </div>
        <div className="settings-row-sublabel">
          {t("settings.audio.wakeWord.description")}
        </div>
      </div>
      <div className="settings-row-control">
        <Switch
          checked={wakeWordEnabled}
          onCheckedChange={handleWakeWordToggle}
          hideLabel
        />
      </div>
    </div>
  );
}

export function NativeDictationSoundsRow() {
  const t = useT();
  const [dictationSoundEffects, setDictationSoundEffects] = useState(true);
  const [savingDictationSoundEffects, setSavingDictationSoundEffects] =
    useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI?.dictation
      ?.getSoundEffectsEnabled?.()
      .then((enabled) => {
        if (!cancelled) setDictationSoundEffects(enabled !== false);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDictationSoundEffectsToggle = useCallback(
    (checked: boolean) => {
      const previous = dictationSoundEffects;
      setDictationSoundEffects(checked);
      setSavingDictationSoundEffects(true);
      void window.electronAPI?.dictation
        ?.setSoundEffectsEnabled?.(checked)
        .then((result) => {
          setDictationSoundEffects(result.enabled);
        })
        .catch(() => {
          setDictationSoundEffects(previous);
        })
        .finally(() => {
          setSavingDictationSoundEffects(false);
        });
    },
    [dictationSoundEffects],
  );

  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <div className="settings-row-label">
          {t("settings.audio.dictationSounds.label")}
        </div>
        <div className="settings-row-sublabel">
          {t("settings.audio.dictationSounds.description")}
        </div>
      </div>
      <div className="settings-row-control">
        <Switch
          checked={dictationSoundEffects}
          disabled={savingDictationSoundEffects}
          onCheckedChange={(checked) =>
            handleDictationSoundEffectsToggle(Boolean(checked))
          }
          hideLabel
        />
      </div>
    </div>
  );
}

export function NativeLocalDictationRow({
  micEnabled,
}: {
  micEnabled: boolean;
}) {
  const t = useT();
  const localDictationSupported = isLocalDictationPlatform();
  const [localDictation, setLocalDictation] = useState(() =>
    isLocalDictationEnabled(),
  );
  const [localDictationUnavailableReason, setLocalDictationUnavailableReason] =
    useState<string | null>(null);

  useEffect(() => {
    if (!localDictationSupported) return;
    let cancelled = false;
    void window.electronAPI?.dictation
      ?.localStatus?.()
      .then((status) => {
        if (cancelled) return;
        setLocalDictationUnavailableReason(
          status.available
            ? null
            : (status.reason ??
                t("settings.audio.localDictation.unavailableFallback")),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [localDictationSupported, t]);

  const handleLocalDictationToggle = useCallback((checked: boolean) => {
    setLocalDictation(checked);
    setLocalDictationPreference(checked);
  }, []);

  if (!localDictationSupported || !micEnabled) return null;

  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <div className="settings-row-label">
          {t("settings.audio.localDictation.label")}
        </div>
        <div className="settings-row-sublabel">
          {localDictationUnavailableReason ??
            t("settings.audio.localDictation.description")}
        </div>
      </div>
      <div className="settings-row-control">
        <Switch
          checked={localDictation && !localDictationUnavailableReason}
          onCheckedChange={handleLocalDictationToggle}
          disabled={Boolean(localDictationUnavailableReason)}
          hideLabel
        />
      </div>
    </div>
  );
}
