/**
 * "Two quick extras" — the housekeeping step, folded into one card.
 *
 *  - macOS only: the Accessibility and Screen Recording permissions Stella
 *    needs to act on the screen. Enabled inline; a screen grant needs a
 *    relaunch, which the card offers rather than nags about.
 *  - The Chrome extension, which lets Stella see and act inside the
 *    user's own browser tabs.
 *  - Signed-in users only: the cloud Memory preference, which the server
 *    requires an explicit acknowledgement for before Stella's first run.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/ui/button";
import { Switch } from "@/ui/switch";
import { AppWindowMac, Check, Eye, Globe, KeyRound } from "@/ui/icons";
import { openExternalUrl } from "@/platform/electron/open-external";
import { getPlatform } from "@/platform/electron/platform";
import { useT } from "@/shared/i18n";
import {
  useDesktopPermissions,
  type DesktopPermissionKind,
  type DesktopPermissionStatus,
} from "@/global/permissions/use-desktop-permissions";
import { useCloudMemoryPreference } from "@/features/cloud/use-cloud-memory-preference";
import { STELLA_BROWSER_EXTENSION_STORE_URL } from "@stella/contracts/browser-extension";
import type { OnboardingChatAnswer } from "../onboarding-chat-flow";

const CHROME_WEB_STORE_URL = STELLA_BROWSER_EXTENSION_STORE_URL;

const PERMISSION_POLL_MS = 3000;

const INITIAL_PERMISSION_STATUS: DesktopPermissionStatus = {
  accessibility: false,
  screen: false,
  microphone: false,
  microphoneStatus: "unknown",
};

const PERMISSION_ROWS: {
  kind: Exclude<DesktopPermissionKind, "microphone">;
  titleKey: string;
  descKey: string;
}[] = [
  {
    kind: "accessibility",
    titleKey: "onboarding.chat.extras.accessibilityTitle",
    descKey: "onboarding.chat.extras.accessibilityDesc",
  },
  {
    kind: "screen",
    titleKey: "onboarding.chat.extras.screenTitle",
    descKey: "onboarding.chat.extras.screenDesc",
  },
];

type ExtrasCardProps = {
  active: boolean;
  answered: OnboardingChatAnswer | undefined;
  isAuthenticated: boolean;
  onAnswer: (answer: OnboardingChatAnswer) => void;
};

export function ExtrasCard({
  active,
  answered,
  isAuthenticated,
  onAnswer,
}: ExtrasCardProps) {
  const t = useT();
  const isMac = getPlatform() === "darwin";
  const permissionsEnabled = isMac && answered === undefined;
  const permissions = useDesktopPermissions({
    enabled: permissionsEnabled,
    pollMs: PERMISSION_POLL_MS,
    initialStatus: INITIAL_PERMISSION_STATUS,
    restartKinds: ["screen"],
  });
  const memory = useCloudMemoryPreference();
  const showMemory = isAuthenticated && !memory.disabled;
  const [memoryChoice, setMemoryChoice] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [extensionOpened, setExtensionOpened] = useState(false);

  useEffect(() => {
    if (!memory.preference) return;
    setMemoryChoice((current) =>
      current === null ? memory.preference!.memoryEnabled : current,
    );
  }, [memory.preference]);

  const handleEnable = useCallback(
    (kind: DesktopPermissionKind) => {
      void permissions.requestWithSettingsFallback(kind).catch((error) => {
        console.warn("[onboarding-chat] Permission request failed", error);
      });
    },
    [permissions],
  );

  const handleContinue = useCallback(async () => {
    if (
      showMemory &&
      memory.preference &&
      memoryChoice !== null &&
      memory.status === "synced"
    ) {
      const needsSave =
        memory.preference.revision === 0 ||
        memory.preference.memoryEnabled !== memoryChoice;
      if (needsSave) {
        setSaving(true);
        const saved = await memory.setMemoryEnabled(memoryChoice, {
          force: memory.preference.revision === 0,
        });
        setSaving(false);
        if (!saved) return;
      }
    }
    onAnswer("done");
  }, [memory, memoryChoice, onAnswer, showMemory]);

  if (answered !== undefined) {
    const parts: string[] = [];
    if (isMac) parts.push(t("onboarding.chat.extras.settledPermissions"));
    parts.push(t("onboarding.chat.extras.settledExtension"));
    if (showMemory) parts.push(t("onboarding.chat.extras.settledMemory"));
    return (
      <div className="obc-card" data-settled>
        <span className="obc-card__settled-icon">
          <Check size={15} />
        </span>
        <span className="obc-card__settled-text">
          <span className="obc-card__settled-title">
            {answered === "skipped"
              ? t("onboarding.chat.extras.settledSkippedTitle")
              : t("onboarding.chat.extras.settledTitle")}
          </span>
          <span className="obc-card__settled-desc">{parts.join(" · ")}</span>
        </span>
      </div>
    );
  }

  const rowCount = (isMac ? PERMISSION_ROWS.length : 0) + 1 + (showMemory ? 1 : 0);
  const continueDisabled =
    !active ||
    saving ||
    (showMemory && (memory.status === "loading" || memory.status === "saving"));

  return (
    <div className="obc-card">
      <div className="obc-card__section">
        <h3 className="obc-card__title">
          {t(rowCount === 1 ? "onboarding.chat.extras.titleOne" : "onboarding.chat.extras.title")}
        </h3>
        <p className="obc-card__body">
          {t(rowCount === 1 ? "onboarding.chat.extras.bodyOne" : "onboarding.chat.extras.body")}
        </p>
      </div>

      <div className="obc-rows">
        {isMac
          ? PERMISSION_ROWS.map((row) => {
              const granted = permissions.status[row.kind];
              const busy = permissions.activeAction === row.kind;
              return (
                <div className="obc-row-item" key={row.kind}>
                  <span className="obc-row-item__icon">
                    {row.kind === "screen" ? (
                      <AppWindowMac size={16} />
                    ) : (
                      <Eye size={16} />
                    )}
                  </span>
                  <span className="obc-row-item__text">
                    <span className="obc-row-item__title">{t(row.titleKey)}</span>
                    <span className="obc-row-item__desc">{t(row.descKey)}</span>
                  </span>
                  {granted ? (
                    <span className="obc-row-item__done">
                      <Check size={14} />
                      {t("onboarding.chat.extras.enabled")}
                    </span>
                  ) : (
                    <Button
                      type="button"
                      size="small"
                      disabled={!active || busy}
                      onClick={() => handleEnable(row.kind)}
                    >
                      {busy
                        ? t("common.loading")
                        : t("onboarding.chat.extras.enable")}
                    </Button>
                  )}
                </div>
              );
            })
          : null}

        <div className="obc-row-item">
          <span className="obc-row-item__icon">
            <img
              src="stella-extension-icon-128.png"
              alt=""
              width={26}
              height={26}
              draggable={false}
            />
          </span>
          <span className="obc-row-item__text">
            <span className="obc-row-item__title">
              {t("onboarding.chat.extras.extensionTitle")}
            </span>
            <span className="obc-row-item__desc">
              {t("onboarding.chat.extras.extensionDesc")}
            </span>
          </span>
          {extensionOpened ? (
            <span className="obc-row-item__done">
              <Globe size={14} />
              {t("onboarding.chat.extras.extensionOpened")}
            </span>
          ) : (
            <Button
              type="button"
              size="small"
              disabled={!active}
              onClick={() => {
                openExternalUrl(CHROME_WEB_STORE_URL);
                setExtensionOpened(true);
              }}
            >
              {t("onboarding.chat.extras.getExtension")}
            </Button>
          )}
        </div>

        {showMemory ? (
          <div className="obc-row-item">
            <span className="obc-row-item__icon">
              <KeyRound size={16} />
            </span>
            <span className="obc-row-item__text">
              <span className="obc-row-item__title">
                {t("onboarding.chat.extras.memoryTitle")}
              </span>
              <span className="obc-row-item__desc">
                {memory.status === "error"
                  ? t(
                      memory.issue === "save"
                        ? "settings.errors.saveMemory"
                        : "settings.errors.loadMemory",
                    )
                  : t("onboarding.chat.extras.memoryDesc")}
              </span>
            </span>
            {memory.status === "error" ? (
              <Button
                type="button"
                size="small"
                variant="ghost"
                onClick={() => void memory.retry()}
              >
                {t("common.tryAgain")}
              </Button>
            ) : (
              <Switch
                checked={memoryChoice ?? false}
                disabled={
                  !active || !memory.preference || memory.status !== "synced"
                }
                onCheckedChange={(next) => setMemoryChoice(Boolean(next))}
                hideLabel
                label={t("onboarding.chat.extras.memoryTitle")}
              />
            )}
          </div>
        ) : null}
      </div>

      {isMac && permissions.restartRecommended ? (
        <div className="obc-actions">
          <span className="obc-actions__hint">
            {t("onboarding.chat.extras.restartHint")}
          </span>
          <span className="obc-actions__spacer" />
          <Button
            type="button"
            size="small"
            variant="ghost"
            disabled={permissions.isRestarting}
            onClick={() => void permissions.restart()}
          >
            {t("onboarding.chat.extras.restart")}
          </Button>
        </div>
      ) : null}

      <div className="obc-actions">
        <Button
          type="button"
          variant="primary"
          disabled={continueDisabled}
          onClick={() => void handleContinue()}
        >
          {saving ? t("common.loading") : t("common.continue")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!active || saving}
          onClick={() => onAnswer("skipped")}
        >
          {t("onboarding.chat.extras.skip")}
        </Button>
        <span className="obc-actions__spacer" />
        <span className="obc-actions__hint">
          {t("onboarding.chat.extras.hint")}
        </span>
      </div>
    </div>
  );
}
