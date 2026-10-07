import { useCallback, useEffect, useState } from "react";
import type {
  UserAskEscalationPolicy,
  UserAskUrgencyLevel,
} from "@stella/contracts/user-ask";
import {
  DEFAULT_USER_ASK_ESCALATION_POLICY,
  USER_ASK_MAX_PER_HOUR_LIMIT,
  USER_ASK_URGENCY_NAMES,
  isWithinQuietHours,
  normalizeUserAskEscalationPolicy,
} from "@stella/contracts/user-ask";
import { Select } from "@/ui/select";
import { Switch } from "@/ui/switch";
import { TextField } from "@/ui/text-field";
import { useT } from "@/shared/i18n";
import { getElectronApi } from "@/platform/electron/electron";
import { getSettingsErrorMessage } from "./shared";

const minuteToTimeValue = (minute: number): string => {
  const safe = ((Math.round(minute) % 1440) + 1440) % 1440;
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
};

const timeValueToMinute = (value: string, fallback: number): number => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return fallback;
  return (((hours * 60 + minutes) % 1440) + 1440) % 1440;
};

const RATE_LIMIT_CHOICES = [1, 2, 3, 4, 6, 8, 10, 12, 15, 20].filter(
  (value) => value <= USER_ASK_MAX_PER_HOUR_LIMIT,
);

const deviceTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export function NativeAskEscalationSettings() {
  const t = useT();
  const [policy, setPolicy] = useState<UserAskEscalationPolicy>(() =>
    normalizeUserAskEscalationPolicy(DEFAULT_USER_ASK_ESCALATION_POLICY),
  );
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const bridge = getElectronApi()?.userAsk;
      if (!bridge?.policyGet) {
        if (!cancelled) setLoaded(true);
        return;
      }
      try {
        const loadedPolicy = await bridge.policyGet();
        if (!cancelled) {
          setPolicy(normalizeUserAskEscalationPolicy(loadedPolicy));
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            getSettingsErrorMessage(
              loadError,
              t("settings.escalation.errors.load"),
            ),
          );
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [t]);

  const commit = useCallback(
    async (patch: Partial<UserAskEscalationPolicy>) => {
      const bridge = getElectronApi()?.userAsk;
      const previous = policy;
      const next = normalizeUserAskEscalationPolicy({ ...policy, ...patch });
      setPolicy(next);
      setError(null);
      if (!bridge?.policySet) {
        setError(t("settings.escalation.errors.unavailable"));
        setPolicy(previous);
        return;
      }
      setSaving(true);
      try {
        const saved = await bridge.policySet(next);
        setPolicy(normalizeUserAskEscalationPolicy(saved ?? next));
      } catch (saveError) {
        setPolicy(previous);
        setError(
          getSettingsErrorMessage(
            saveError,
            t("settings.escalation.errors.save"),
          ),
        );
      } finally {
        setSaving(false);
      }
    },
    [policy, t],
  );

  const disabled = !loaded || saving;
  const levelOptions = USER_ASK_URGENCY_NAMES.map((name, index) => ({
    value: String(index + 1),
    label: t(`settings.escalation.levels.${name}`),
  }));
  const now = new Date();
  const quietNow = isWithinQuietHours(
    policy.quietHours,
    now.getHours() * 60 + now.getMinutes(),
  );
  const zone = policy.timeZone ?? deviceTimeZone();

  return (
    <div className="settings-card">
      <div className="settings-card-header">
        <h3 className="settings-card-title">
          {t("settings.escalation.title")}
        </h3>
      </div>
      <p className="settings-card-desc">
        {t("settings.escalation.description")}
      </p>

      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">
            {t("settings.escalation.ceiling.label")}
          </div>
          <div className="settings-row-sublabel">
            {t("settings.escalation.ceiling.sublabel")}
          </div>
        </div>
        <div className="settings-row-control">
          <Select
            className="settings-runtime-select"
            value={String(policy.ceiling)}
            aria-label={t("settings.escalation.ceiling.label")}
            disabled={disabled}
            options={levelOptions}
            onValueChange={(value) =>
              void commit({ ceiling: Number(value) as UserAskUrgencyLevel })
            }
          />
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">
            {t("settings.escalation.sound.label")}
          </div>
          <div className="settings-row-sublabel">
            {t("settings.escalation.sound.sublabel")}
          </div>
        </div>
        <div className="settings-row-control">
          <Switch
            aria-label={t("settings.escalation.sound.label")}
            checked={policy.soundEnabled}
            disabled={disabled}
            onCheckedChange={(checked) =>
              void commit({ soundEnabled: Boolean(checked) })
            }
            hideLabel
          />
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">
            {t("settings.escalation.rateLimit.label")}
          </div>
          <div className="settings-row-sublabel">
            {t("settings.escalation.rateLimit.sublabel")}
          </div>
        </div>
        <div className="settings-row-control">
          <Select
            className="settings-runtime-select"
            value={String(policy.maxPerHour)}
            aria-label={t("settings.escalation.rateLimit.label")}
            disabled={disabled}
            options={RATE_LIMIT_CHOICES.map((value) => ({
              value: String(value),
              label: t("settings.escalation.rateLimit.value", {
                count: String(value),
              }),
            }))}
            onValueChange={(value) =>
              void commit({ maxPerHour: Number(value) })
            }
          />
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-info">
          <div className="settings-row-label">
            {t("settings.escalation.quietHours.label")}
          </div>
          <div className="settings-row-sublabel">
            {quietNow
              ? t("settings.escalation.quietHours.activeNow")
              : t("settings.escalation.quietHours.sublabel")}
          </div>
        </div>
        <div className="settings-row-control">
          <Switch
            aria-label={t("settings.escalation.quietHours.label")}
            checked={policy.quietHours.enabled}
            disabled={disabled}
            onCheckedChange={(checked) =>
              void commit({
                quietHours: {
                  ...policy.quietHours,
                  enabled: Boolean(checked),
                },
              })
            }
            hideLabel
          />
        </div>
      </div>

      {policy.quietHours.enabled ? (
        <>
          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">
                {t("settings.escalation.quietHours.window")}
              </div>
              <div className="settings-row-sublabel">
                {t("settings.escalation.quietHours.windowSublabel", { zone })}
              </div>
            </div>
            <div className="settings-row-control settings-escalation-window">
              <TextField
                type="time"
                label={t("settings.escalation.quietHours.start")}
                hideLabel
                aria-label={t("settings.escalation.quietHours.start")}
                disabled={disabled}
                value={minuteToTimeValue(policy.quietHours.startMinute)}
                onChange={(event) =>
                  void commit({
                    quietHours: {
                      ...policy.quietHours,
                      startMinute: timeValueToMinute(
                        event.target.value,
                        policy.quietHours.startMinute,
                      ),
                    },
                  })
                }
              />
              <TextField
                type="time"
                label={t("settings.escalation.quietHours.end")}
                hideLabel
                aria-label={t("settings.escalation.quietHours.end")}
                disabled={disabled}
                value={minuteToTimeValue(policy.quietHours.endMinute)}
                onChange={(event) =>
                  void commit({
                    quietHours: {
                      ...policy.quietHours,
                      endMinute: timeValueToMinute(
                        event.target.value,
                        policy.quietHours.endMinute,
                      ),
                    },
                  })
                }
              />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <div className="settings-row-label">
                {t("settings.escalation.quietHours.ceilingLabel")}
              </div>
              <div className="settings-row-sublabel">
                {t("settings.escalation.quietHours.ceilingSublabel")}
              </div>
            </div>
            <div className="settings-row-control">
              <Select
                className="settings-runtime-select"
                value={String(policy.quietHoursCeiling)}
                aria-label={t("settings.escalation.quietHours.ceilingLabel")}
                disabled={disabled}
                options={levelOptions}
                onValueChange={(value) =>
                  void commit({
                    quietHoursCeiling: Number(value) as UserAskUrgencyLevel,
                  })
                }
              />
            </div>
          </div>
        </>
      ) : null}

      {error ? (
        <p
          className="settings-card-desc settings-card-desc--error"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
