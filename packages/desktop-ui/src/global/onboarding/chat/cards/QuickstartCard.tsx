/**
 * The finale — "Quickstart", or skip.
 *
 * Offered once everything else is set: Stella reads the browser (and
 * optionally the coding setup) once, writes a starting memory, and comes
 * back with what she picked up and a few requests written for this person.
 * Skipping goes straight into the chat. While it runs the card shows the
 * work as it happens, and the user can head into the chat at any point;
 * the job is a module store, so it finishes in the background and its
 * greeting still lands in the thread.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { backendClient } from "@/platform/backend/backend-client";
import { Button } from "@/ui/button";
import { ChevronDown, RotateCcw } from "@/ui/icons";
import { uiState } from "@/platform/ui-state";
import { getPlatform } from "@/platform/electron/platform";
import { useT } from "@/shared/i18n";
import type { DiscoveryCategory } from "@stella/contracts/discovery";
import type { OnboardingStarter } from "@stella/contracts/desktop/onboarding";
import {
  BROWSER_PROFILE_KEY,
  BROWSER_SELECTION_KEY,
  DISCOVERY_CATEGORIES_CHANGED_EVENT,
  DISCOVERY_CATEGORIES_KEY,
} from "@stella/contracts/discovery";
import { BROWSERS, type BrowserId } from "../browsers";
import {
  startDiscoveryJob,
  useDiscoveryJob,
  type DiscoveryJobStatus,
} from "../discovery-job";
import type { PendingComposerDraft } from "../pending-handoff";

type BrowserProfile = { id: string; name: string };

type QuickstartCardProps = {
  active: boolean;
  isAuthenticated: boolean;
  onStart: (draft?: PendingComposerDraft) => void;
  onSkip: () => void;
};

const SUPPORTED_BROWSER_IDS = new Set<string>(BROWSERS.map((b) => b.id));

/** Best-effort default-browser detection plus the selected browser's profiles. */
function useBrowserChoice(enabled: boolean) {
  const [selectedBrowser, setSelectedBrowser] = useState<BrowserId | null>(null);
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
          (await window.electronAPI?.discovery.listProfiles?.(selectedBrowser)) ?? [];
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

  return { selectedBrowser, selectBrowser, profiles, selectedProfile, setSelectedProfile };
}

/** The three beats of the run, in order, keyed to the job's status. */
const STAGES: { id: string; key: string; reached: DiscoveryJobStatus[] }[] = [
  {
    id: "read",
    key: "onboarding.chat.quickstart.stages.read",
    reached: ["collecting", "synthesizing", "saving", "done"],
  },
  {
    id: "notice",
    key: "onboarding.chat.quickstart.stages.notice",
    reached: ["synthesizing", "saving", "done"],
  },
  {
    id: "write",
    key: "onboarding.chat.quickstart.stages.write",
    reached: ["saving", "done"],
  },
];

const STAGE_INDEX: Partial<Record<DiscoveryJobStatus, number>> = {
  collecting: 0,
  synthesizing: 1,
  saving: 2,
  done: 3,
};

const GENERIC_STARTER_KEYS = [
  "onboarding.chat.ready.generic.plan",
  "onboarding.chat.ready.generic.browse",
  "onboarding.chat.ready.generic.file",
  "onboarding.chat.ready.generic.watch",
] as const;

export function QuickstartCard({
  active,
  isAuthenticated,
  onStart,
  onSkip,
}: QuickstartCardProps) {
  const t = useT();
  const platform = getPlatform();
  const job = useDiscoveryJob();
  const [started, setStarted] = useState(job.status !== "idle");
  const choice = useBrowserChoice(active && !started);
  const [includeDev, setIncludeDev] = useState(false);

  const browsers = useMemo(
    () => BROWSERS.filter((browser) => (platform !== "darwin" ? browser.id !== "safari" : true)),
    [platform],
  );

  const genericStarters = useMemo<OnboardingStarter[]>(
    () =>
      GENERIC_STARTER_KEYS.map((key) => ({
        title: t(`${key}.title`),
        prompt: t(`${key}.prompt`),
      })),
    [t],
  );

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
        void backendClient
          .call("preferences.set", { preferredBrowser: choice.selectedBrowser ?? "none" })
          .catch(() => {
            // Browser preference sync is best-effort only.
          });
      }
    },
    [choice.selectedBrowser, choice.selectedProfile, isAuthenticated],
  );

  const run = useCallback(() => {
    const categories: DiscoveryCategory[] = [];
    if (choice.selectedBrowser) categories.push("browsing_bookmarks");
    if (includeDev) categories.push("dev_environment");
    if (categories.length === 0) return;
    persistSelection(includeDev ? ["dev_environment"] : []);
    setStarted(true);
    startDiscoveryJob({
      categories,
      selectedBrowser: choice.selectedBrowser ?? undefined,
      selectedProfile: choice.selectedProfile ?? undefined,
    });
  }, [choice, includeDev, persistSelection]);

  const retry = useCallback(() => {
    const selectedBrowser = uiState.getItem(BROWSER_SELECTION_KEY) ?? undefined;
    const selectedProfile = uiState.getItem(BROWSER_PROFILE_KEY) ?? undefined;
    const categories: DiscoveryCategory[] = [];
    if (selectedBrowser) categories.push("browsing_bookmarks");
    try {
      const stored = JSON.parse(uiState.getItem(DISCOVERY_CATEGORIES_KEY) ?? "[]") as unknown;
      if (Array.isArray(stored) && stored.includes("dev_environment")) {
        categories.push("dev_environment");
      }
    } catch {
      // Ignore a malformed stored selection; the browser alone is enough.
    }
    if (categories.length === 0) return;
    startDiscoveryJob({ categories, selectedBrowser, selectedProfile });
  }, []);

  /* ── Offer ─────────────────────────────────────────────────────── */
  if (!started) {
    const canRun = Boolean(choice.selectedBrowser) || includeDev;
    return (
      <div className="obc-card obc-quickstart" data-phase="offer">
        <div className="obc-card__section">
          <span className="obc-quickstart__eyebrow">{t("onboarding.chat.quickstart.eyebrow")}</span>
          <h3 className="obc-card__title">{t("onboarding.chat.quickstart.title")}</h3>
          <p className="obc-card__body">{t("onboarding.chat.quickstart.body")}</p>
        </div>

        <div className="obc-card__section">
          <span className="obc-card__label">{t("onboarding.chat.discovery.browserLabel")}</span>
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
          <span className="obc-card__label">{t("onboarding.chat.discovery.alsoLabel")}</span>
          <div className="obc-pills">
            <button
              type="button"
              className="obc-pill"
              aria-pressed={includeDev}
              data-active={includeDev}
              disabled={!active}
              onClick={() => setIncludeDev((value) => !value)}
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
            disabled={!active || !canRun}
            onClick={run}
          >
            {t("onboarding.chat.quickstart.run")}
          </Button>
          <Button type="button" variant="ghost" disabled={!active} onClick={onSkip}>
            {t("onboarding.chat.quickstart.skip")}
          </Button>
          <span className="obc-actions__spacer" />
          <span className="obc-actions__hint">{t("onboarding.chat.discovery.hint")}</span>
        </div>
      </div>
    );
  }

  /* ── Running / result ──────────────────────────────────────────── */
  const failed = job.status === "failed";
  const result = job.status === "done" ? job.result : null;
  const stageIndex = STAGE_INDEX[job.status] ?? (result ? 3 : 0);
  const starters = result && result.starters.length > 0 ? result.starters : genericStarters;

  if (!result && !failed) {
    return (
      <div className="obc-card obc-quickstart" data-phase="running">
        <div className="obc-quickstart__run">
          <span className="obc-quickstart__orbit" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <div className="obc-quickstart__run-text">
            <h3 className="obc-card__title">{t("onboarding.chat.quickstart.runningTitle")}</h3>
            <p className="obc-card__body">{t("onboarding.chat.quickstart.runningBody")}</p>
          </div>
        </div>
        <ol className="obc-quickstart__stages" role="status">
          {STAGES.map((stage, index) => (
            <li
              key={stage.id}
              className="obc-quickstart__stage"
              data-state={
                index < stageIndex ? "done" : index === stageIndex ? "active" : "waiting"
              }
            >
              <span className="obc-quickstart__tick" aria-hidden="true">
                <svg viewBox="0 0 24 24" width={12} height={12}>
                  <path d="M5 12.8 9.9 17.7 19 7.3" pathLength={24} />
                </svg>
              </span>
              {t(stage.key)}
            </li>
          ))}
        </ol>
        <div className="obc-actions">
          <Button type="button" variant="ghost" disabled={!active} onClick={() => onStart()}>
            {t("onboarding.chat.quickstart.continueInBackground")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="obc-card obc-quickstart" data-phase={failed ? "failed" : "done"}>
      {failed ? (
        <div className="obc-card__section">
          <h3 className="obc-card__title">{t("onboarding.chat.quickstart.failedTitle")}</h3>
          <p className="obc-card__body">{t("onboarding.chat.quickstart.failedBody")}</p>
        </div>
      ) : (
        <div className="obc-card__section">
          <span className="obc-card__label">{t("onboarding.chat.ready.highlightsLabel")}</span>
          <div className="obc-chips">
            {(result?.profileHighlights ?? []).map((highlight, index) => (
              <span
                key={highlight}
                className="obc-chip"
                style={{ animationDelay: `${index * 70}ms` }}
              >
                {highlight}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="obc-card__section">
        <span className="obc-card__label">
          {result ? t("onboarding.chat.ready.startersLabelPersonal") : t("onboarding.chat.ready.startersLabel")}
        </span>
        <div className="obc-starters">
          {starters.map((starter, index) => (
            <button
              key={`${starter.title}:${index}`}
              type="button"
              className="obc-starter"
              disabled={!active}
              style={{ animationDelay: `${200 + index * 60}ms` }}
              onClick={() => onStart({ text: starter.prompt, send: true })}
            >
              <span className="obc-starter__title">{starter.title}</span>
              <span className="obc-starter__prompt">{starter.prompt}</span>
            </button>
          ))}
        </div>
      </div>

      {result?.coreMemory ? (
        <details className="obc-notes">
          <summary>
            {t("onboarding.chat.ready.notesSummary")}
            <ChevronDown size={14} className="obc-notes__chevron" />
          </summary>
          <pre className="obc-notes__body">{result.coreMemory}</pre>
          <div className="obc-notes__foot">{t("onboarding.chat.ready.notesFoot")}</div>
        </details>
      ) : null}

      <div className="obc-actions">
        <Button type="button" variant="primary" disabled={!active} onClick={() => onStart()}>
          {t("onboarding.chat.ready.start")}
        </Button>
        {failed ? (
          <Button type="button" variant="ghost" disabled={!active} onClick={retry}>
            <RotateCcw size={13} />
            {t("common.tryAgain")}
          </Button>
        ) : null}
        <span className="obc-actions__spacer" />
        <span className="obc-actions__hint">{t("onboarding.chat.ready.hint")}</span>
      </div>
    </div>
  );
}
