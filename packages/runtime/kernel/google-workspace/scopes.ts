/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OAuth scopes required by the first-party Google Workspace integration.
 *
 * Stella uses a SINGLE shared Google grant/account for every Workspace
 * service (Gmail, Calendar, Drive, Docs, Sheets, Tasks). The OAuth flow
 * requests the complete {@link SCOPES} union so one consent covers all
 * services, while {@link GOOGLE_WORKSPACE_SERVICE_SCOPES} records the
 * per-service minimum so connection status can be reported scope-aware
 * (e.g. an older token granted before Sheets/Tasks existed reads as
 * "needs reconnect" for those services only).
 *
 * Shared with the desktop OAuth handler and the headless login CLI.
 */

const dedupeScopes = (scopes: readonly string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const scope of scopes) {
    const trimmed = scope.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
};

/**
 * Identity scopes granted to every service. Needed for `people.getMe`,
 * the signed-in profile lookup, and the OpenID account association.
 */
export const IDENTITY_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
] as const;

/**
 * Per-service required scopes keyed by native integration id. These are
 * the minimum write-capable scopes each service needs; the shared grant
 * always requests the full union so a single connect enables all of them.
 */
export const GOOGLE_WORKSPACE_SERVICE_SCOPES = {
  gmail: ["https://www.googleapis.com/auth/gmail.modify"],
  googlecalendar: ["https://www.googleapis.com/auth/calendar"],
  googledocs: ["https://www.googleapis.com/auth/documents"],
  googledrive: ["https://www.googleapis.com/auth/drive"],
  googlesheets: ["https://www.googleapis.com/auth/spreadsheets"],
  googletasks: ["https://www.googleapis.com/auth/tasks"],
} as const satisfies Record<string, readonly string[]>;

export type GoogleWorkspaceServiceId =
  keyof typeof GOOGLE_WORKSPACE_SERVICE_SCOPES;

/**
 * Complete union of identity + every service scope. This is the exact set
 * requested by the shared Google grant.
 */
export const SCOPES: string[] = dedupeScopes([
  ...IDENTITY_SCOPES,
  ...Object.values(GOOGLE_WORKSPACE_SERVICE_SCOPES).flat(),
]);

/**
 * Internal id/alias for the one-tap all-Google bundle. Its user-facing name
 * is "Google Workspace"; the id stays `googlesuper` for compatibility. The
 * bundle requests the exact six-service scope union ({@link SCOPES}).
 */
export const GOOGLE_WORKSPACE_BUNDLE_ID = "googlesuper";

/**
 * Required scopes for a given native integration id (identity baseline +
 * that service's scopes). Unknown ids fall back to identity scopes only.
 */
export const getRequiredScopesForIntegration = (id: string): string[] => {
  // The one-tap bundle requires the complete six-service union.
  if (id === GOOGLE_WORKSPACE_BUNDLE_ID) return [...SCOPES];
  const service =
    GOOGLE_WORKSPACE_SERVICE_SCOPES[id as GoogleWorkspaceServiceId];
  return dedupeScopes([...IDENTITY_SCOPES, ...(service ?? [])]);
};

/**
 * True when every scope in `required` is present in `granted`. Used to
 * report connection status scope-aware.
 */
export const hasRequiredScopes = (
  granted: readonly string[] | undefined,
  required: readonly string[],
): boolean => {
  if (required.length === 0) return true;
  const grantedSet = new Set(granted ?? []);
  return required.every((scope) => grantedSet.has(scope));
};
