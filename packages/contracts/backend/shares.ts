/**
 * Canvas shares: a self-contained HTML document at an unguessable URL
 * (`<CANVAS_SHARE_BASE_URL>/c/<slug>`).
 *
 * Every canvas the `html` tool writes is saved here under its canvas slug, as
 * a **private** link: only its owner, signed in to Stella, can open it (see
 * `shares.viewLink`). Making it **public** lets anyone with the link view it;
 * the link stays the same either way, and saving the canvas again updates
 * what the link shows. A link lives until its owner revokes it or it expires
 * (90 days after it was last saved); either one deletes the object, which is
 * what makes the URL 404.
 *
 * `shares.publish` is the older, one-off public snapshot with no canvas
 * behind it, kept for app versions that still call it.
 */

/** Largest document `shares.publish` and `shares.save` accept, in UTF-8 bytes. */
export const SHARE_MAX_HTML_BYTES = 5 * 1024 * 1024;
export const SHARE_MAX_TITLE_CHARS = 300;
/** A canvas slug, as the `html` tool names its file. */
export const SHARE_CANVAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** `private`: only the owner can open the link. `public`: anyone with it. */
export type ShareVisibility = "private" | "public";

export type PublishedShare = {
  url: string;
  slug: string;
  expiresAt: number;
};

/** A canvas's link as `shares.save` and `shares.setVisibility` return it. */
export type SavedCanvasShare = {
  url: string;
  slug: string;
  visibility: ShareVisibility;
  expiresAt: number;
};

/** One live link as `shares.list` shows it. */
export type ShareLink = {
  slug: string;
  url: string;
  title: string | null;
  createdAt: number;
  expiresAt: number;
  /** Absent on rows written before links had visibility: those are public. */
  visibility?: ShareVisibility;
  /** The canvas slug behind the link; null for a one-off `shares.publish`. */
  canvas?: string | null;
};

export type ShareCalls = {
  /** Publish a one-off public snapshot; it stays up for 90 days unless revoked. */
  "shares.publish": {
    args: { html: string; title?: string };
    result: PublishedShare;
  };
  /**
   * Save a canvas to its link, creating the link (private) on first save.
   * `visibility` changes it; omitted, the link keeps its current one.
   */
  "shares.save": {
    args: {
      canvas: string;
      html: string;
      title?: string;
      visibility?: ShareVisibility;
    };
    result: SavedCanvasShare;
  };
  /** Make one of the caller's links public or private. Same URL either way. */
  "shares.setVisibility": {
    args: { slug: string; visibility: ShareVisibility };
    result: SavedCanvasShare;
  };
  /**
   * A URL that opens the link in a browser for its owner: for a private link,
   * the link plus a grant good for a few minutes; for a public one, the link.
   */
  "shares.viewLink": {
    args: { slug: string };
    result: { url: string };
  };
  /** Take one of the caller's links down. `NOT_FOUND` for any other slug. */
  "shares.revoke": {
    args: { slug: string };
    result: { revoked: true };
  };
};

export type ShareViews = {
  /** The owner's live public links, newest first. */
  "shares.list": { args: Record<string, never>; result: ShareLink[] };
  /** One canvas's link, or null before it has been saved. */
  "shares.canvas": { args: { canvas: string }; result: ShareLink | null };
};
