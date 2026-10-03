import type { ErrorComponentProps } from "@tanstack/react-router";
import { CrashSurface } from "./CrashSurface";

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

/**
 * TanStack Router catches route render errors before Stella's outer React
 * boundary. Keep them on the shared crash UI.
 */
export function RouteErrorRecovery(props: ErrorComponentProps) {
  return (
    <CrashSurface
      error={asError(props.error)}
      componentStack={props.info?.componentStack ?? null}
    />
  );
}
