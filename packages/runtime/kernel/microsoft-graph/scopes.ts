/**
 * OAuth scopes required by the first-party Microsoft Graph integration.
 *
 * Stella uses a SINGLE shared Microsoft identity grant/account for every
 * in-scope Microsoft service (Outlook, Microsoft Teams, Excel). The OAuth
 * flow requests the complete {@link MICROSOFT_GRAPH_SCOPES} union so one
 * consent covers all services, while {@link MICROSOFT_GRAPH_SERVICE_SCOPES}
 * records the per-service minimum so connection status can be reported
 * scope-aware (e.g. a token granted before Teams support existed reads as
 * "needs reconnect" for Teams only, not for Outlook or Excel).
 *
 * SharePoint / OneDrive are intentionally OUT of the current top-60 scope
 * and are not represented here.
 *
 * Shared with the desktop OAuth handler and the connector readiness checks.
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
 * Identity + baseline scopes granted to every service. `offline_access`
 * yields the refresh token, `User.Read` backs the signed-in profile
 * lookup, and the OpenID scopes carry the account association.
 */
export const MICROSOFT_IDENTITY_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
] as const;

/**
 * Per-service required scopes keyed by native connector id. These are the
 * minimum least-privilege scopes each service needs; the shared grant
 * always requests the full union so a single connect enables all of them.
 * Delegated (user-context) scopes only — never application scopes that
 * would require tenant admin consent by default.
 */
export const MICROSOFT_GRAPH_SERVICE_SCOPES = {
  outlook: ["Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite"],
  microsoft_teams: [
    "Team.ReadBasic.All",
    "Channel.ReadBasic.All",
    "ChannelMessage.Read.All",
    "ChannelMessage.Send",
  ],
  excel: ["Files.ReadWrite"],
} as const satisfies Record<string, readonly string[]>;

export type MicrosoftGraphServiceId = keyof typeof MICROSOFT_GRAPH_SERVICE_SCOPES;

export const MICROSOFT_GRAPH_SERVICE_IDS = Object.keys(
  MICROSOFT_GRAPH_SERVICE_SCOPES,
) as MicrosoftGraphServiceId[];

/**
 * Complete union of identity + every in-scope service scope. This is the
 * exact set requested by the shared Microsoft grant.
 */
export const MICROSOFT_GRAPH_SCOPES: string[] = dedupeScopes([
  ...MICROSOFT_IDENTITY_SCOPES,
  ...Object.values(MICROSOFT_GRAPH_SERVICE_SCOPES).flat(),
]);

const SERVICE_ALIASES: Record<string, MicrosoftGraphServiceId> = {
  outlook: "outlook",
  microsoft_teams: "microsoft_teams",
  teams: "microsoft_teams",
  excel: "excel",
};

/** Normalizes an incoming connector id/alias to a known service id. */
export const resolveMicrosoftGraphServiceId = (
  id: string,
): MicrosoftGraphServiceId | undefined =>
  SERVICE_ALIASES[id.trim().toLowerCase()];

/**
 * Required scopes for a given native connector id (identity baseline +
 * that service's scopes). Unknown ids fall back to identity scopes only.
 */
export const getRequiredScopesForMicrosoftService = (id: string): string[] => {
  const service = resolveMicrosoftGraphServiceId(id);
  return dedupeScopes([
    ...MICROSOFT_IDENTITY_SCOPES,
    ...(service ? MICROSOFT_GRAPH_SERVICE_SCOPES[service] : []),
  ]);
};

/**
 * True when every scope in `required` is present in `granted`. Used to
 * report per-service connection status scope-aware. Microsoft returns the
 * granted scopes without the `openid`/`profile`/`email` OIDC scopes echoed
 * back, so those identity scopes are treated as always satisfied once any
 * token exists.
 */
const OIDC_ONLY_SCOPES = new Set(["openid", "profile", "email"]);

export const hasRequiredMicrosoftScopes = (
  granted: readonly string[] | undefined,
  required: readonly string[],
): boolean => {
  if (required.length === 0) return true;
  const grantedSet = new Set((granted ?? []).map((scope) => scope.trim()));
  return required.every(
    (scope) => OIDC_ONLY_SCOPES.has(scope) || grantedSet.has(scope),
  );
};
