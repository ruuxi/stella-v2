/**
 * "Let me read your browser once" — the discovery consent card.
 *
 * The one step that asks for something, so it does the explaining: what is
 * read, where it goes, what the user gets. Accepting starts the discovery
 * job immediately; the card then collapses to a live status line that keeps
 * ticking while the rest of the conversation continues.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/api";
import { Button } from "@/ui/button";
import { Check, Eye, RotateCcw } from "@/ui/icons";
import { uiState } from "@/platform/ui-state";
import { getPlatform } from "@/platform/electron/platform";
import { useT } from "@/shared/i18n";
import type { DiscoveryCategory } from "@stella/contracts/discovery";
import {
  BROWSER_PROFILE_KEY,
  BROWSER_SELECTION_KEY,
  DISCOVERY_CATEGORIES_CHANGED_EVENT,
  DISCOVERY_CATEGORIES_KEY,
} from "@stella/contracts/discovery";
import { BROWSERS, type BrowserId } from "../browsers";
import type { OnboardingChatAnswer } from "../onboarding-chat-flow";
import {
  startDiscoveryJob,
  useDiscoveryJob,
  type DiscoveryJobStatus,
} from "../discovery-job";

type BrowserProfile = { id: string; name: string };

type DiscoveryCardProps = {
  active: boolean;
  answered: OnboardingChatAnswer | undefined;
  isAuthenticated: boolean;
  onAnswer: (answer: OnboardingChatAnswer) => void;
};

const SUPPORTED_BROWSER_IDS = new Set<string>(BROWSERS.map((b) => b.id));

const browserLabel = (id: string | null) =>
  BROWSERS.find((browser) => browser.id === id)?.label ?? null;

/** Best-effort default-browser detection plus the selected browser's profiles. */
function useBrowserChoice(enabled: boolean) {
  const [selectedBrowser, setSelectedBrowser] = useState<BrowserId | null>(
    null,
  );
  const [detectedBrowser, setDetectedBrowser] = useState<BrowserId | null>(
    null,
  );
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [selectedProfile, setSelectedProfile] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const detected = await window.electronAPI?.discovery.detectPreferred?.();
        if (cancelled || !detected?.browser) return;
        if (!SUPPORTED_BROWSER_IDS.has(detected.browser)) return;
        const id = detected.browser as BrowserId;
        setDetectedBrowser(id);
        setSelectedBrowser((current) => current ?? id);
      } catch {
        // Detection is best-effort only.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!selectedBrowser) return;
    let cancelled = false;
    void (async () => {
      try {
        const next =
          (await window.electronAPI?.discovery.listProfiles?.(
            selectedBrowser,
          )) ?? [];
        if (cancelled) return;
        setProfiles(next);
        setSelectedProfile((current) =>
          current && next.some((profile) => profile.id === current)
            ? current
            : (next[0]?.id ?? null),
        );
      } catch {
        if (!cancelled) {
          setProfiles([]);
          setSelectedProfile(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedBrowser]);

  const selectBrowser = useCallback((id: BrowserId) => {
    setProfiles([]);
    setSelectedProfile(null);
    setSelectedBrowser(id);
  }, []);

  return {
    detectedBrowser,
    selectedBrowser,
    selectBrowser,
    profiles,
    selectedProfile,
    setSelectedProfile,
  };
}

const STATUS_KEYS: Record<DiscoveryJobStatus, string> = {
  idle: "onboarding.chat.discovery.status.idle",
  collecting: "onboarding.chat.discovery.status.collecting",
  synthesizing: "onboarding.chat.discovery.status.synthesizing",
  saving: "onboarding.chat.discovery.status.saving",
  done: "onboarding.chat.discovery.status.done",
  failed: "onboarding.chat.discovery.status.failed",
};

const statusTone = (status: DiscoveryJobStatus) =>
  status === "done" ? "done" : status === "failed" ? "failed" : "active";

export function DiscoveryCard({
  active,
  answered,
  isAuthenticated,
  onAnswer,
}: DiscoveryCardProps) {
  const t = useT();
  const platform = getPlatform();
  const job = useDiscoveryJob();
  const choice = useBrowserChoice(active && answered === undefined);
  const [includeDev, setIncludeDev] = useState(false);
  const savePreferredBrowser = useMutation(
    api.data.preferences.setPreferredBrowser,
  );

  const browsers = useMemo(
    () =>
      BROWSERS.filter((browser) =>
        platform !== "darwin" ? browser.id !== "safari" : true,
      ),
    [platform],
  );

  // The settled summary needs the choice after the live state is gone.
  const [settledChoice, setSettledChoice] = useState<{
    browser: string | null;
    profile: string | null;
  } | null>(() => {
    if (answered !== "accepted") return null;
    return {
      browser: browserLabel(uiState.getItem(BROWSER_SELECTION_KEY)),
      profile: null,
    };
  });

  const persistSelection = useCallback(
    (categories: DiscoveryCategory[]) => {
      uiState.setItem(DISCOVERY_CATEGORIES_KEY, JSON.stringify(categories));
      window.dispatchEvent(new Event(DISCOVERY_CATEGORIES_CHANGED_EVENT));
      if (choice.selectedBrowser) {
        uiState.setItem(BROWSER_SELECTION_KEY, choice.selectedBrowser);
        if (choice.selectedProfile) {
          uiState.setItem(BROWSER_PROFILE_KEY, choice.selectedProfile);
        } else {
          uiState.removeItem(BROWSER_PROFILE_KEY);
        }
      } else {
        uiState.removeItem(BROWSER_SELECTION_KEY);
        uiState.removeItem(BROWSER_PROFILE_KEY);
      }
      if (isAuthenticated) {
        void savePreferredBrowser({
          browser: choice.selectedBrowser ?? "none",
        }).catch(() => {
          // Browser preference sync is best-effort only.
        });
      }
    },
    [choice.selectedBrowser, choice.selectedProfile, isAuthenticated, savePreferredBrowser],
  );

  const handleAccept = useCallback(() => {
    const categories: DiscoveryCategory[] = [];
    if (choice.selectedBrowser) categories.push("browsing_bookmarks");
    if (includeDev) categories.push("dev_environment");
    if (categories.length === 0) return;
    persistSelection(includeDev ? ["dev_environment"] : []);
    setSettledChoice({
      browser: browserLabel(choice.selectedBrowser),
      profile:
        choice.profiles.length > 1
          ? (choice.profiles.find((p) => p.id === choice.selectedProfile)
              ?.name ?? null)
          : null,
    });
    startDiscoveryJob({
      categories,
      selectedBrowser: choice.selectedBrowser ?? undefined,
      selectedProfile: choice.selectedProfile ?? undefined,
      includeAuth: isAuthenticated,
    });
    onAnswer("accepted");
  }, [choice, includeDev, isAuthenticated, onAnswer, persistSelection]);

  const handleSkip = useCallback(() => {
    persistSelection([]);
    onAnswer("skipped");
  }, [onAnswer, persistSelection]);

  const handleRetry = useCallback(() => {
    const selectedBrowser = uiState.getItem(BROWSER_SELECTION_KEY) ?? undefined;
    const selectedProfile = uiState.getItem(BROWSER_PROFILE_KEY) ?? undefined;
    const categories: DiscoveryCategory[] = [];
    if (selectedBrowser) categories.push("browsing_bookmarks");
    try {
      const stored = JSON.parse(
        uiState.getItem(DISCOVERY_CATEGORIES_KEY) ?? "[]",
      ) as unknown;
      if (Array.isArray(stored) && stored.includes("dev_environment")) {
        categories.push("dev_environment");
      }
    } catch {
      // Ignore a malformed stored selection; the browser alone is enough.
    }
    if (categories.length === 0) return;
    startDiscoveryJob({
      categories,
      selectedBrowser,
      selectedProfile,
      includeAuth: isAuthenticated,
    });
  }, [isAuthenticated]);

  if (answered === "skipped") {
    return (
      <div className="obc-card" data-settled>
        <span className="obc-card__settled-icon">
          <Eye size={15} />
        </span>
        <span className="obc-card__settled-text">
          <span className="obc-card__settled-title">
            {t("onboarding.chat.discovery.settledSkippedTitle")}
          </span>
          <span className="obc-card__settled-desc">
            {t("onboarding.chat.discovery.settledSkippedDesc")}
          </span>
        </span>
      </div>
    );
  }

  if (answered === "accepted") {
    // A resumed session may find the job idle (the app quit mid-run). The
    // profile either already exists on disk or the finale falls back; the
    // status line just says "done" rather than pretending to work.
    const status: DiscoveryJobStatus =
      job.status === "idle" ? "done" : job.status;
    const target = [settledChoice?.browser, settledChoice?.profile]
      .filter(Boolean)
      .join(" · ");
    return (
      <div className="obc-card" data-settled>
        <span className="obc-card__settled-icon">
          {status === "done" ? <Check size={15} /> : <Eye size={15} />}
        </span>
        <span className="obc-card__settled-text">
          <span className="obc-card__settled-title">
            {target
              ? t("onboarding.chat.discovery.settledTitle", { target })
              : t("onboarding.chat.discovery.settledTitleGeneric")}
          </span>
          <span className="obc-card__settled-desc">
            {t("onboarding.chat.discovery.settledDesc")}
          </span>
        </span>
        <span className="obc-status" data-tone={statusTone(status)} role="status">
          <span className="obc-status__dot" aria-hidden="true" />
          {t(STATUS_KEYS[status])}
          {status === "failed" ? (
            <button
              type="button"
              className="obc-link-btn"
              onClick={handleRetry}
            >
              <RotateCcw size={12} style={{ marginRight: 4, verticalAlign: -2 }} />
              {t("common.tryAgain")}
            </button>
          ) : null}
        </span>
      </div>
    );
  }

  const canAccept = Boolean(choice.selectedBrowser) || includeDev;

  return (
    <div className="obc-card">
      <div className="obc-card__section">
        <h3 className="obc-card__title">
          {t("onboarding.chat.discovery.title")}
        </h3>
        <p className="obc-card__body">{t("onboarding.chat.discovery.body")}</p>
      </div>

      <div className="obc-card__section">
        <span className="obc-card__label">
          {t("onboarding.chat.discovery.browserLabel")}
        </span>
        <div className="obc-pills">
          {browsers.map((browser) => (
            <button
              key={browser.id}
              type="button"
              className="obc-pill"
              data-active={choice.selectedBrowser === browser.id}
              disabled={!active}
              onClick={() => choice.selectBrowser(browser.id)}
            >
              {browser.label}
            </button>
          ))}
        </div>
        {choice.profiles.length > 1 ? (
          <div className="obc-pills">
            {choice.profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                className="obc-pill"
                data-active={choice.selectedProfile === profile.id}
                disabled={!active}
                onClick={() => choice.setSelectedProfile(profile.id)}
              >
                {profile.name}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="obc-card__section">
        <span className="obc-card__label">
          {t("onboarding.chat.discovery.alsoLabel")}
        </span>
        <div className="obc-pills">
          <button
            type="button"
            className="obc-pill"
            aria-pressed={includeDev}
            data-active={includeDev}
            disabled={!active}
            onClick={() => setIncludeDev((v) => !v)}
          >
            {t("onboarding.chat.discovery.includeDev")}
          </button>
        </div>
      </div>

      <p className="obc-card__fine">{t("onboarding.chat.discovery.assurance")}</p>


      <div className="obc-actions">
        <Button
          type="button"
          variant="primary"
          disabled={!active || !canAccept}
          onClick={handleAccept}
        >
          {t("onboarding.chat.discovery.accept")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!active}
          onClick={handleSkip}
        >
          {t("onboarding.chat.discovery.skip")}
        </Button>
        <span className="obc-actions__spacer" />
        <span className="obc-actions__hint">
          {t("onboarding.chat.discovery.hint")}
        </span>
      </div>
    </div>
  );
}
