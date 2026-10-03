/**
 * Canvas shares: a self-contained HTML document published to a public,
 * unguessable URL (`<CANVAS_SHARE_BASE_URL>/c/<slug>`). The share lives until
 * its owner revokes it or it expires; either one deletes the object, which is
 * what makes the URL 404.
 */

/** Largest document `shares.publish` accepts, in UTF-8 bytes. */
export const SHARE_MAX_HTML_BYTES = 5 * 1024 * 1024;
export const SHARE_MAX_TITLE_CHARS = 300;

export type PublishedShare = {
  url: string;
  slug: string;
  expiresAt: number;
};

/** One live share as `shares.list` shows it. */
export type ShareLink = {
  slug: string;
  url: string;
  title: string | null;
  createdAt: number;
  expiresAt: number;
};

export type ShareCalls = {
  /** Publish a document; it stays public for 90 days unless revoked. */
  "shares.publish": {
    args: { html: string; title?: string };
    result: PublishedShare;
  };
  /** Take one of the caller's shares down. `NOT_FOUND` for any other slug. */
  "shares.revoke": {
    args: { slug: string };
    result: { revoked: true };
  };
};

export type ShareViews = {
  /** The owner's live shares, newest first. */
  "shares.list": { args: Record<string, never>; result: ShareLink[] };
};
