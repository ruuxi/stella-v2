import {
  lazy,
  Suspense,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { uiState } from "@/platform/ui-state";
import { Switch } from "@/ui/switch";
import { Select } from "@/ui/select";
import {
  PREFERRED_MIC_KEY,
  PREFERRED_SPEAKER_KEY,
  MIC_ENABLED_KEY,
  isMicrophoneEnabled,
} from "@/features/voice/services/shared-microphone";
import {
  isDictationEnhanceEnabled,
  isDictationSuperFastEnabled,
  setDictationEnhancePreference,
  setDictationSuperFastModeEnabled,
  setDictationSuperFastPreference,
} from "@/features/dictation/services/inworld-dictation";
import { requestBrowserMicrophoneAccess } from "@/global/permissions/microphone-permission";
import { useT } from "@/shared/i18n";
import { platformCapabilities } from "@/platform/capabilities";

const NativeAudioDesktopRows = lazy(() =>
  import("./tabs/NativeAudioDesktopSettings").then((module) => ({
    default: module.NativeAudioDesktopRows,
  })),
);

const darwinMicrophoneIsDenied = async (): Promise<boolean> => {
  if (!platformCapabilities.nativeSettings) return false;
  const nativeAudio = await import("./tabs/NativeAudioDesktopSettings");
  return nativeAudio.darwinMicrophoneIsDenied();
};

export function AudioTab() {
  const t = useT();
  const [micEnabled, setMicEnabled] = useState(() => isMicrophoneEnabled());
  const [dictationSuperFast, setDictationSuperFast] = useState(
    () => isMicrophoneEnabled() && isDictationSuperFastEnabled(),
  );
  const [enhanceDictation, setEnhanceDictation] = useState(() =>
    isDictationEnhanceEnabled(),
  );
  const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>(
    [],
  );
  const [audioOutputDevices, setAudioOutputDevices] = useState<
    MediaDeviceInfo[]
  >([]);
  const [selectedMicId, setSelectedMicId] = useState(
    () => uiState.getItem(PREFERRED_MIC_KEY) ?? "",
  );
  const [selectedSpeakerId, setSelectedSpeakerId] = useState(
    () => uiState.getItem(PREFERRED_SPEAKER_KEY) ?? "",
  );
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const micTransactionRef = useRef(0);

  const loadDevices = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter(
        (d) => d.kind === "audioinput" && d.deviceId,
      );
      const outputs = devices.filter(
        (d) => d.kind === "audiooutput" && d.deviceId,
      );
      setAudioInputDevices(inputs);
      setAudioOutputDevices(outputs);
      setPermissionError(null);
    } catch {
      setPermissionError(t("settings.audio.errors.listDevices"));
    }
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (isMicrophoneEnabled()) {
        await loadDevices();
        return;
      }
      if (isDictationSuperFastEnabled()) {
        setDictationSuperFastPreference(false);
        void setDictationSuperFastModeEnabled(false).catch(() => undefined);
      }
      if (cancelled) return;
    })();
    return () => {
      cancelled = true;
    };
  }, [loadDevices]);

  const handleMicToggle = useCallback(
    (checked: boolean) => {
      const transaction = ++micTransactionRef.current;

      setMicEnabled(checked);
      uiState.setItem(MIC_ENABLED_KEY, checked ? "true" : "false");

      if (!checked) {
        if (dictationSuperFast) {
          setDictationSuperFast(false);
          setDictationSuperFastPreference(false);
          void setDictationSuperFastModeEnabled(false).catch(() => undefined);
        }
        return;
      }

      void (async () => {
        if (await darwinMicrophoneIsDenied()) {
          if (micTransactionRef.current !== transaction) return;
          setPermissionError(t("settings.audio.errors.micDeniedReset"));
          setMicEnabled(false);
          uiState.setItem(MIC_ENABLED_KEY, "false");
          return;
        }

        try {
          await requestBrowserMicrophoneAccess();
          if (micTransactionRef.current !== transaction) return;
          await loadDevices();
        } catch {
          const deniedReset = await darwinMicrophoneIsDenied();
          if (micTransactionRef.current !== transaction) return;
          setPermissionError(
            deniedReset
              ? t("settings.audio.errors.micDeniedReset")
              : t("settings.audio.errors.micDenied"),
          );
          setMicEnabled(false);
          uiState.setItem(MIC_ENABLED_KEY, "false");
        }
      })();
    },
    [dictationSuperFast, loadDevices, t],
  );

  const handleDictationSuperFastToggle = useCallback((checked: boolean) => {
    setDictationSuperFast(checked);
    setDictationSuperFastPreference(checked);
    void setDictationSuperFastModeEnabled(checked).catch((error: Error) => {
      setPermissionError(error.message);
      setDictationSuperFast(false);
      setDictationSuperFastPreference(false);
    });
  }, []);

  const handleEnhanceDictationToggle = useCallback((checked: boolean) => {
    setEnhanceDictation(checked);
    setDictationEnhancePreference(checked);
  }, []);

  const handleMicChange = useCallback((deviceId: string) => {
    setSelectedMicId(deviceId);
    if (deviceId) {
      uiState.setItem(PREFERRED_MIC_KEY, deviceId);
    } else {
      uiState.removeItem(PREFERRED_MIC_KEY);
    }
  }, []);

  const handleSpeakerChange = useCallback((deviceId: string) => {
    setSelectedSpeakerId(deviceId);
    if (deviceId) {
      uiState.setItem(PREFERRED_SPEAKER_KEY, deviceId);
    } else {
      uiState.removeItem(PREFERRED_SPEAKER_KEY);
    }
  }, []);

  const afterWakeWord = (
    <>
      {micEnabled && audioInputDevices.length > 0 ? (
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">
              {t("settings.audio.microphone.deviceLabel")}
            </div>
            <div className="settings-row-sublabel">
              {t("settings.audio.microphone.deviceDescription")}
            </div>
          </div>
          <div className="settings-row-control">
            <Select
              className="settings-runtime-select"
              value={selectedMicId}
              onValueChange={(value) => handleMicChange(value)}
              aria-label={t("settings.audio.microphone.deviceLabel")}
              options={[
                { value: "", label: t("settings.audio.systemDefault") },
                ...audioInputDevices.map((device, index) => ({
                  value: device.deviceId,
                  label:
                    device.label ||
                    t("settings.audio.microphoneDeviceFallback", {
                      index: index + 1,
                    }),
                })),
              ]}
            />
          </div>
        </div>
      ) : null}
      {micEnabled ? (
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">
              {t("settings.audio.superFast.label")}
            </div>
            <div className="settings-row-sublabel">
              {t("settings.audio.superFast.description")}
            </div>
          </div>
          <div className="settings-row-control">
            <Switch
              checked={dictationSuperFast}
              onCheckedChange={handleDictationSuperFastToggle}
              hideLabel
            />
          </div>
        </div>
      ) : null}
    </>
  );
  const afterSounds = micEnabled ? (
    <div className="settings-row">
      <div className="settings-row-info">
        <div className="settings-row-label">
          {t("settings.audio.enhance.label")}
        </div>
        <div className="settings-row-sublabel">
          {t("settings.audio.enhance.description")}
        </div>
      </div>
      <div className="settings-row-control">
        <Switch
          checked={enhanceDictation}
          onCheckedChange={handleEnhanceDictationToggle}
          hideLabel
        />
      </div>
    </div>
  ) : null;

  return (
    <div className="settings-tab-content">
      <div className="settings-card">
        <h3 className="settings-card-title">
          {t("settings.audio.microphone.title")}
        </h3>
        {permissionError ? (
          <p
            className="settings-card-desc settings-card-desc--error"
            role="alert"
          >
            {permissionError}
          </p>
        ) : null}
        <div className="settings-row">
          <div className="settings-row-info">
            <div className="settings-row-label">
              {t("settings.audio.microphone.enableLabel")}
            </div>
            <div className="settings-row-sublabel">
              {t("settings.audio.microphone.enableDescription")}
            </div>
          </div>
          <div className="settings-row-control">
            <Switch
              checked={micEnabled}
              onCheckedChange={handleMicToggle}
              hideLabel
            />
          </div>
        </div>
        {platformCapabilities.nativeSettings ? (
          <Suspense fallback={null}>
            <NativeAudioDesktopRows
              micEnabled={micEnabled}
              afterWakeWord={afterWakeWord}
              afterSounds={afterSounds}
            />
          </Suspense>
        ) : (
          <>
            {afterWakeWord}
            {afterSounds}
          </>
        )}
      </div>

      {platformCapabilities.canSelectSpeaker() ? (
        <div className="settings-card">
          <h3 className="settings-card-title">
            {t("settings.audio.speaker.title")}
          </h3>
          {audioOutputDevices.length > 0 ? (
            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-label">
                  {t("settings.audio.speaker.outputLabel")}
                </div>
                <div className="settings-row-sublabel">
                  {t("settings.audio.speaker.outputDescription")}
                </div>
              </div>
              <div className="settings-row-control">
                <Select
                  className="settings-runtime-select"
                  value={selectedSpeakerId}
                  onValueChange={(value) => handleSpeakerChange(value)}
                  aria-label={t("settings.audio.speaker.outputLabel")}
                  options={[
                    { value: "", label: t("settings.audio.systemDefault") },
                    ...audioOutputDevices.map((device, index) => ({
                      value: device.deviceId,
                      label:
                        device.label ||
                        t("settings.audio.speakerDeviceFallback", {
                          index: index + 1,
                        }),
                    })),
                  ]}
                />
              </div>
            </div>
          ) : (
            <div className="settings-row">
              <div className="settings-row-info">
                <div className="settings-row-sublabel">
                  {micEnabled
                    ? t("settings.audio.speaker.empty")
                    : t("settings.audio.speaker.emptyMicOff")}
                </div>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
