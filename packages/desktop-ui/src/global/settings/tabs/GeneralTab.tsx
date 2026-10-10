import { lazy, Suspense } from "react";
import { Select } from "@/ui/select";
import { LanguageSettingsRow } from "@/global/settings/LanguageSettingsRow";
import {
  setReduceMotionPreference,
  useInterfacePreferences,
  type ReduceMotionPreference,
} from "@/shared/lib/interface-preferences";
import { useT } from "@/shared/i18n";
import { platformCapabilities } from "@/platform/capabilities";
import { CompanionSettingsCard } from "./CompanionSettingsCard";

const NativeDesktopGeneralSettings = lazy(() =>
  import("./NativeGeneralSettings").then((module) => ({
    default: module.NativeDesktopGeneralSettings,
  })),
);

const NativeAskEscalationSettings = lazy(() =>
  import("./NativeAskEscalationSettings").then((module) => ({
    default: module.NativeAskEscalationSettings,
  })),
);

export function GeneralTab() {
  const t = useT();
  const { reduceMotion } = useInterfacePreferences();

  return (
    <div className="settings-tab-content">
      <LanguageSettingsRow />
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
      {platformCapabilities.nativeSettings ? <CompanionSettingsCard /> : null}
      {platformCapabilities.nativeSettings ? (
        <Suspense fallback={null}>
          <NativeAskEscalationSettings />
        </Suspense>
      ) : null}
      {platformCapabilities.nativeSettings ? (
        <Suspense fallback={null}>
          <NativeDesktopGeneralSettings />
        </Suspense>
      ) : null}
    </div>
  );
}
