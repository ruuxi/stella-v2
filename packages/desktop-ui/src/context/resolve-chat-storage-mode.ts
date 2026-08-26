import type { ChatStorageMode } from "./chat-store-context";

// Explicit, hard-to-misconfigure resolution of whether ordinary desktop
// conversations are cloud-canonical (DO journal authority) or the explicit
// local-only mode. This is invisible wiring — there is no user-facing toggle.
//
// Invariants:
//  - Default (flag unset) stays local, so existing/production builds are
//    unchanged.
//  - When cloud conversations are enabled, the desktop's Convex issuer
//    (VITE_CONVEX_SITE_URL) MUST equal the issuer the cloud journal worker
//    verifies against (VITE_STELLA_CLOUD_JOURNAL_ISSUER). A mismatch or missing
//    config throws rather than silently creating a local-canonical conversation
//    — the "no silent fallback" rule at the configuration layer.

export interface CloudConversationEnv {
  /** VITE_STELLA_CLOUD_CONVERSATIONS — "1"/"true" enables cloud-canonical. */
  readonly cloudConversationsFlag: string | undefined;
  /** VITE_CONVEX_URL — the Convex the desktop client talks to. */
  readonly convexUrl: string | undefined;
  /** VITE_CONVEX_SITE_URL — the issuer of the desktop's Convex JWT. */
  readonly convexSiteUrl: string | undefined;
  /**
   * VITE_STELLA_CLOUD_JOURNAL_ISSUER — the issuer the cloud journal worker
   * (STELLA_CONVEX_SITE_URL) pins. Must equal convexSiteUrl or the desktop's
   * JWT will 401 at the worker. Optional; when set it is enforced.
   */
  readonly journalIssuer: string | undefined;
}

export interface ChatStorageResolution {
  readonly storageMode: ChatStorageMode;
  readonly cloudFeaturesEnabled: boolean;
}

export class CloudConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudConfigError";
  }
}

const isTruthyFlag = (value: string | undefined): boolean =>
  value === "1" || value === "true";

export function resolveChatStorageMode(
  env: CloudConversationEnv,
): ChatStorageResolution {
  if (!isTruthyFlag(env.cloudConversationsFlag)) {
    // Explicit local mode (default). Ordinary voice/automation local paths and
    // unconfigured/offline builds keep working exactly as before.
    return { storageMode: "local", cloudFeaturesEnabled: false };
  }

  // Cloud conversations requested: the configuration must be complete and
  // aligned, or we fail loudly instead of writing a local-canonical conversation.
  if (!env.convexUrl || !env.convexSiteUrl) {
    throw new CloudConfigError(
      "Cloud conversations are enabled (VITE_STELLA_CLOUD_CONVERSATIONS) but " +
        "VITE_CONVEX_URL / VITE_CONVEX_SITE_URL are not both set. Refusing to " +
        "silently fall back to a local-canonical conversation.",
    );
  }
  if (env.journalIssuer && env.convexSiteUrl !== env.journalIssuer) {
    throw new CloudConfigError(
      `Cloud journal issuer mismatch: desktop signs against ${env.convexSiteUrl} ` +
        `but the journal worker verifies ${env.journalIssuer}. The desktop JWT ` +
        `would 401 at the worker. Align VITE_CONVEX_SITE_URL with the staging ` +
        `worker's STELLA_CONVEX_SITE_URL.`,
    );
  }

  return { storageMode: "cloud", cloudFeaturesEnabled: true };
}

/**
 * Read the resolution from a Vite `import.meta.env`-shaped record. Kept separate
 * from `resolveChatStorageMode` so the core is unit-testable without Vite.
 */
export function resolveChatStorageModeFromImportEnv(
  importEnv: Record<string, string | boolean | undefined>,
): ChatStorageResolution {
  return resolveChatStorageMode({
    cloudConversationsFlag: importEnv.VITE_STELLA_CLOUD_CONVERSATIONS as
      | string
      | undefined,
    convexUrl: importEnv.VITE_CONVEX_URL as string | undefined,
    convexSiteUrl: importEnv.VITE_CONVEX_SITE_URL as string | undefined,
    journalIssuer: importEnv.VITE_STELLA_CLOUD_JOURNAL_ISSUER as
      | string
      | undefined,
  });
}
