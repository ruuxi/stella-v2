import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Containment for the cloud surfaces that depend on Convex modules the
 * desktop build does not compile against (drive, projects). A deployment
 * missing one of those functions must cost the user that one surface — not
 * the sidebar or the settings tab hosting it.
 */
export class CloudBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn("[cloud] surface unavailable:", error, info.componentStack);
  }

  render() {
    if (this.state.failed) return this.props.fallback ?? null;
    return this.props.children;
  }
}
