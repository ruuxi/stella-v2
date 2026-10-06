import { memo } from "react";
import { RefreshCw } from "@/ui/icons";
import { useTPlural } from "@/shared/i18n";
import { openUpdates, useAppSourceState, waitingCount } from "./app-source-store";
import "./updates-pill.css";

/**
 * The one way in to everything Stella can add to this computer: a new
 * version, a change made on another computer, a change ready to add. It only
 * exists while something is waiting for a click, and says how many; pressing
 * it opens the Updates list in the right sidebar, where each one is added or
 * skipped. Nothing waiting, no pill.
 */
export const UpdatesPill = memo(function UpdatesPill() {
  const tPlural = useTPlural();
  const state = useAppSourceState();
  const count = state ? waitingCount(state) : 0;
  if (count === 0) return null;
  const label = tPlural("shell.appSource.updates.pill", count);
  return (
    <button
      type="button"
      className="updates-pill"
      onClick={openUpdates}
      aria-label={label}
      data-testid="updates-pill"
    >
      <RefreshCw className="updates-pill__icon" size={13} strokeWidth={2} aria-hidden />
      <span className="updates-pill__label">{label}</span>
    </button>
  );
});
