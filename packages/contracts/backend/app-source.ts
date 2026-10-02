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
};
