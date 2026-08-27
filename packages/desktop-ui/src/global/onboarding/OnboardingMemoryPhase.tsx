import { useCallback, useEffect, useRef, useState } from "react";
import type { CloudMemoryPreferenceView } from "@/features/cloud/use-cloud-memory-preference";
import { useT } from "@/shared/i18n";

type OnboardingMemoryPhaseProps = {
  authError: string | null;
  memory: CloudMemoryPreferenceView;
  splitTransitionActive: boolean;
  onContinue: () => void;
  onRetryAuthBootstrap: () => void;
};

/**
 * Captures the user's cloud-authoritative Memory preference before Stella's
 * first run. A revision-zero head is only the server default, so onboarding
 * requires an explicit choice and forces a compare-and-swap acknowledgement.
 * Existing heads hydrate their saved choice and can continue unchanged.
 */
export function OnboardingMemoryPhase({
  authError,
  memory,
  splitTransitionActive,
  onContinue,
  onRetryAuthBootstrap,
}: OnboardingMemoryPhaseProps) {
  const t = useT();
  const [choice, setChoice] = useState<boolean | null>(null);
  const [retrying, setRetrying] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!memory.preference) {
      setChoice(null);
      return;
    }

    // Revision zero has never been acknowledged by a human. Do not turn its
    // seeded default into an implicit opt-in. Later revisions are explicit
    // saved choices and should be reflected when the phase is revisited.
    if (memory.preference.revision > 0) {
      setChoice(memory.preference.memoryEnabled);
    }
  }, [memory.preference]);

  const handleContinue = useCallback(async () => {
    const preference = memory.preference;
    if (
      choice === null ||
      !preference ||
      memory.disabled ||
      memory.status !== "synced" ||
      Boolean(authError) ||
      splitTransitionActive
    ) {
      return;
    }

    const saved = await memory.setMemoryEnabled(choice, {
      force: preference.revision === 0,
    });

    if (!mountedRef.current || !saved) return;
    onContinue();
  }, [authError, choice, memory, onContinue, splitTransitionActive]);

  const handleRetry = useCallback(async () => {
    if (retrying || splitTransitionActive) return;

    setRetrying(true);
    if (authError) {
      onRetryAuthBootstrap();
      if (mountedRef.current) setRetrying(false);
      return;
    }

    await memory.retry();
    if (!mountedRef.current) return;
    setRetrying(false);

    // Retry only recovers authority. A conflict retry can resolve by loading a
    // replacement revision-zero head whose default happens to match `choice`;
    // requiring another Continue guarantees that head still receives its
    // explicit force-CAS acknowledgement.
  }, [
    authError,
    memory,
    onRetryAuthBootstrap,
    retrying,
    splitTransitionActive,
  ]);

  const hasError = Boolean(authError) || memory.status === "error";
  const controlsDisabled =
    splitTransitionActive ||
    memory.disabled ||
    memory.status !== "synced" ||
    hasError ||
    !memory.preference;
  const continueDisabled = controlsDisabled || choice === null;
  const statusMessage =
    memory.status === "saving"
      ? "Saving your Memory preference…"
      : "Loading your Memory preference…";

  return (
    <div className="onboarding-step-content onboarding-memory-step">
      <p className="onboarding-step-desc">{t("settings.memory.description")}</p>

      <div
        className="onboarding-memory-choices"
        role="radiogroup"
        aria-label="Memory preference"
        aria-describedby="onboarding-memory-preservation-note"
      >
        <button
          type="button"
          className="onboarding-selection-tile onboarding-memory-choice"
          role="radio"
          aria-checked={choice === true}
          data-active={choice === true}
          disabled={controlsDisabled}
          onClick={() => setChoice(true)}
        >
          <span className="onboarding-selection-tile-label">
            Use saved Memory
          </span>
          <span className="onboarding-selection-tile-desc">
            Let Stella use your saved Memory and profile when they are relevant.
          </span>
        </button>
        <button
          type="button"
          className="onboarding-selection-tile onboarding-memory-choice"
          role="radio"
          aria-checked={choice === false}
          data-active={choice === false}
          disabled={controlsDisabled}
          onClick={() => setChoice(false)}
        >
          <span className="onboarding-selection-tile-label">Not now</span>
          <span className="onboarding-selection-tile-desc">
            Keep saved Memory out of future model context. Nothing is deleted.
          </span>
        </button>
      </div>

      <p
        className="onboarding-memory-note"
        id="onboarding-memory-preservation-note"
      >
        Turning Memory off only excludes saved Memory from future model context.
        Your existing cloud and local Memory documents stay available to view,
        edit, or download.
      </p>

      {!hasError &&
      (memory.status === "loading" || memory.status === "saving") ? (
        <p className="onboarding-memory-state" role="status">
          {statusMessage}
        </p>
      ) : null}

      {hasError ? (
        <div className="onboarding-memory-error" role="alert">
          <span>
            {authError ??
              t(
                memory.issue === "save"
                  ? "settings.errors.saveMemory"
                  : "settings.errors.loadMemory",
              )}
          </span>
          <button
            type="button"
            className="onboarding-memory-retry"
            disabled={retrying || splitTransitionActive}
            onClick={() => void handleRetry()}
          >
            {retrying ? t("common.loading") : t("common.tryAgain")}
          </button>
        </div>
      ) : null}

      <button
        type="button"
        className="onboarding-confirm"
        data-visible={true}
        disabled={continueDisabled}
        onClick={() => void handleContinue()}
      >
        {t("common.continue")}
      </button>
    </div>
  );
}
