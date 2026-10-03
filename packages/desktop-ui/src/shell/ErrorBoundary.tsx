import { Component, type ErrorInfo, type ReactNode } from "react";
import { CrashSurface } from "./CrashSurface";
import { reportRendererError } from "@/platform/diagnostics/report-error";
import {
  STELLA_BUILD_ERROR_CLEARED_EVENT,
  STELLA_BUILD_ERROR_EVENT,
  type StellaBuildErrorDetail,
} from "@/platform/dev/vite-error-recovery";

type Props = { children: ReactNode };

/**
 * Account data resets fence every owner query until they finish, so a live
 * query can throw this mid-reset. It is a wait, not a crash: retry until the
 * reset lifts, and only show the crash surface if it never does.
 */
const OWNER_RESET_CODE = "OWNER_DATA_PURGE_ACTIVE";
const OWNER_RESET_RETRY_MS = 2_000;
const OWNER_RESET_MAX_RETRIES = 60;
const isOwnerResetError = (error: Error | null) =>
  Boolean(error?.message?.includes(OWNER_RESET_CODE));
type State = {
  hasError: boolean;
  caughtError: Error | null;
  componentStack: string | null;
  source: "react" | "build";
  /** A mid-reset owner query failed; render nothing while it retries. */
  waitingForReset: boolean;
};

/**
 * React error boundary for crashes that bubble up through normal React
 * rendering (i.e. anything outside a TanStack Router route subtree). Router
 * crashes are intercepted by `defaultErrorComponent` in `router.tsx` before
 * they reach this boundary; both code paths render the same `CrashSurface`.
 *
 * Also listens for Vite dev-server build / parse errors forwarded from
 * `platform/dev/vite-error-recovery.ts` so oxc transform failures surface
 * through the same surface (Reload / Ask Stella to repair / Undo update)
 * instead of Vite's red overlay.
 */
export class ErrorBoundary extends Component<Props, State> {
  private resetRetries = 0;
  private resetRetryTimer: ReturnType<typeof setTimeout> | null = null;

  state: State = {
    hasError: false,
    caughtError: null,
    componentStack: null,
    source: "react",
    waitingForReset: false,
  };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return {
      hasError: true,
      caughtError: error,
      source: "react",
      waitingForReset: isOwnerResetError(error),
    };
  }

  componentDidMount() {
    window.addEventListener(
      STELLA_BUILD_ERROR_EVENT,
      this.handleBuildError as EventListener,
    );
    window.addEventListener(
      STELLA_BUILD_ERROR_CLEARED_EVENT,
      this.handleBuildErrorCleared,
    );
  }

  componentWillUnmount() {
    if (this.resetRetryTimer) clearTimeout(this.resetRetryTimer);
    window.removeEventListener(
      STELLA_BUILD_ERROR_EVENT,
      this.handleBuildError as EventListener,
    );
    window.removeEventListener(
      STELLA_BUILD_ERROR_CLEARED_EVENT,
      this.handleBuildErrorCleared,
    );
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (isOwnerResetError(error)) {
      if (this.resetRetries < OWNER_RESET_MAX_RETRIES) {
        this.resetRetries += 1;
        this.resetRetryTimer = setTimeout(() => {
          this.resetRetryTimer = null;
          this.setState({
            hasError: false,
            caughtError: null,
            componentStack: null,
            waitingForReset: false,
          });
        }, OWNER_RESET_RETRY_MS);
        return;
      }
      this.setState({ waitingForReset: false });
    }
    console.error("ErrorBoundary caught:", error, info);
    reportRendererError({
      kind: "react",
      message: error.message,
      stack: error.stack,
      source: info.componentStack?.trim().split("\n")[0]?.trim(),
    });
    this.setState({
      caughtError: error,
      componentStack: info.componentStack ?? null,
      source: "react",
    });
  }

  private handleBuildError = (event: CustomEvent<StellaBuildErrorDetail>) => {
    const detail = event.detail;
    if (!detail?.error) return;
    console.error("ErrorBoundary received build error:", detail.error);
    this.setState({
      hasError: true,
      caughtError: detail.error,
      componentStack: detail.frame ?? null,
      source: "build",
    });
  };

  private handleBuildErrorCleared = () => {
    if (this.state.source !== "build" || !this.state.hasError) return;
    this.setState({
      hasError: false,
      caughtError: null,
      componentStack: null,
      source: "react",
    });
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.state.waitingForReset) return null;
    return (
      <CrashSurface
        error={this.state.caughtError}
        componentStack={this.state.componentStack}
      />
    );
  }
}
