import type { ErrorComponentProps } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useCloudConversationSession } from "@/global/auth/hooks/use-cloud-conversation-session";
import { CrashSurface } from "./CrashSurface";

export const OWNERSHIP_MIGRATION_RECOVERY_TIMEOUT_MS = 20_000;

const OWNERSHIP_MIGRATED_CODE = "OWNERSHIP_MIGRATED";
const SERIALIZED_OWNERSHIP_MIGRATED_CODE =
  /["']code["']\s*:\s*["']OWNERSHIP_MIGRATED["']/;

const readStructuredErrorCode = (value: unknown): string | null => {
  if (!value || typeof value !== "object") return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
};

/**
 * Match only the ownership fence raised while an anonymous owner is being
 * linked to its account. Convex exposes the code as structured `data` in the
 * browser and embeds that same JSON field in some serialized error messages.
 */
export const isOwnershipMigratedError = (error: unknown): boolean => {
  if (!error || typeof error !== "object") return false;

  const data = (error as { data?: unknown }).data;
  if (readStructuredErrorCode(data) === OWNERSHIP_MIGRATED_CODE) return true;
  if (
    typeof data === "string" &&
    SERIALIZED_OWNERSHIP_MIGRATED_CODE.test(data)
  ) {
    return true;
  }

  const message = (error as { message?: unknown }).message;
  return (
    typeof message === "string" &&
    SERIALIZED_OWNERSHIP_MIGRATED_CODE.test(message)
  );
};

const asError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

function OwnershipMigrationRecovery({
  error,
  info,
  reset,
}: ErrorComponentProps) {
  const { accountScope, isCloudConversationReady } =
    useCloudConversationSession();
  const [timedOut, setTimedOut] = useState(false);
  const timedOutRef = useRef(false);
  const resetCalledRef = useRef(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      timedOutRef.current = true;
      setTimedOut(true);
    }, OWNERSHIP_MIGRATION_RECOVERY_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    const destinationIdentityReady =
      isCloudConversationReady && accountScope.startsWith("account:");
    if (
      !destinationIdentityReady ||
      timedOutRef.current ||
      resetCalledRef.current
    ) {
      return;
    }
    resetCalledRef.current = true;
    reset();
  }, [accountScope, isCloudConversationReady, reset]);

  if (timedOut) {
    return (
      <CrashSurface
        error={asError(error)}
        componentStack={info?.componentStack ?? null}
      />
    );
  }

  return (
    <div
      className="error-boundary"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="error-boundary-gradient" />
      <div className="error-boundary-content">
        <h2>Finishing sign-in…</h2>
      </div>
    </div>
  );
}

/**
 * TanStack Router catches route render errors before Stella's outer React
 * boundary. Keep ordinary failures on the shared crash UI, while the one
 * expected ownership-transition fence gets a bounded, identity-gated retry.
 */
export function RouteErrorRecovery(props: ErrorComponentProps) {
  if (isOwnershipMigratedError(props.error)) {
    return <OwnershipMigrationRecovery {...props} />;
  }
  return (
    <CrashSurface
      error={asError(props.error)}
      componentStack={props.info?.componentStack ?? null}
    />
  );
}
