import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  fallback?: ReactNode;
  /** Changing this retries the surface, so a new conversation gets a fresh try. */
  resetKey?: unknown;
};

type State = { failed: boolean };

/**
 * Containment for a cloud surface that depends on account-scoped Convex
 * functions, mirroring desktop's `features/cloud/CloudBoundary`. A
 * subscription the backend refuses throws out of render; without this the
 * nearest boundary is the root layout's, which replaces the whole app with
 * the boot crash screen over one optional card. Here the failed surface
 * renders its fallback (nothing, by default) and the chat stays usable.
 */
export class CloudBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.warn("[cloud] surface unavailable:", error, info.componentStack);
  }

  componentDidUpdate(previous: Props): void {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  render(): ReactNode {
    if (this.state.failed) return this.props.fallback ?? null;
    return this.props.children;
  }
}
