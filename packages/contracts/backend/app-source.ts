/**
 * The app's source on Cloudflare Artifacts (v3): one upstream repo the
 * release process publishes to, and a fork per owner that the owner's local
 * clone pushes its self-modifications to. Tokens are short-lived; ask again
 * before each git operation.
 */

export type AppSourceRemote = {
  /** HTTPS git remote. */
  remote: string;
  /** Git token: send as `Authorization: Bearer <token>`. */
  token: string;
  /** Token expiry, ms since epoch. */
  expiresAt: number;
};

export type AppSourceCalls = {
  /**
   * The owner's fork (created from upstream on first use) with a write
   * token, and upstream with a read token for pulling updates.
   */
  "appSource.access": {
    args: Record<string, never>;
    result: {
      fork: AppSourceRemote & { name: string; defaultBranch: string };
      upstream: AppSourceRemote;
    };
  };
  /**
   * The owner's own browser renderer, built from their fork by their desktop
   * and uploaded after a push that changed it: `path` is relative to the
   * website's `/chat-app/` (`u/<fork>/<tree>/`). Null means the shared build.
   */
  "appSource.webRenderer": {
    args: Record<string, never>;
    result: { path: string } | null;
  };
};

/** Where the desktop uploads a fork's browser renderer: `PUT <prefix><treeSha>`, an uncompressed tar. */
export const WEB_RENDERER_UPLOAD_PREFIX = "/api/app-source/web-renderer/";
