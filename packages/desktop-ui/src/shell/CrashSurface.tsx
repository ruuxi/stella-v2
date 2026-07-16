import { useCallback, useLayoutEffect } from "react";
import "./error-boundary.css";

type Props = {
  error: Error | null;
  componentStack: string | null;
};

/**
 * Shared crash UI for the React error boundary and TanStack Router errors.
 * Recovery is intentionally limited to reloading or opening logs; packaged
 * builds do not mutate their own application source.
 */
export function CrashSurface({ error, componentStack }: Props) {
  useLayoutEffect(() => {
    document.getElementById("stella-launch")?.remove();
  }, []);

  const handleReload = useCallback(() => {
    window.location.reload();
  }, []);

  const handleOpenLogs = useCallback(() => {
    void window.electronAPI?.system?.openLogs?.();
  }, []);

  return (
    <div className="error-boundary">
      <div className="error-boundary-gradient" />
      <div className="error-boundary-content">
        <h2>Something went wrong</h2>
        <p>An unexpected error occurred. Reload Stella or inspect the logs.</p>
        <div className="error-boundary-actions">
          <button
            className="error-boundary-btn error-boundary-btn--fix"
            onClick={handleReload}
          >
            Reload
          </button>
        </div>
        <button
          className="error-boundary-loglink"
          onClick={handleOpenLogs}
          type="button"
        >
          Open logs folder
        </button>
        {import.meta.env.DEV && error ? (
          <details className="error-boundary-details">
            <summary>Technical details</summary>
            <pre>{`${error.name}: ${error.message}\n${componentStack ?? ""}`}</pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}
