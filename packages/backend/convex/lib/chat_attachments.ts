/**
 * The one definition of "a file attached to a chat turn".
 *
 * An attachment reference is a drive-relative POSIX path and nothing else. The
 * drive row it names already carries the display name, the content type, the
 * byte size, and bytes whose size `finalizeDriveUpload` validated against the
 * claim they were prepared for — so a client-declared copy of any of that
 * would be a second, spoofable authority with no consumer and no rule for
 * resolving a disagreement. The path is the whole reference, which is also
 * what makes it placement-agnostic: a cloud turn hydrates it through the drive
 * sync, and a computer-placed turn resolves it through a signed drive GET.
 *
 * The bounds live here because four call sites had their own copy of them:
 * the drive attachment route, the composer normalizer, the placement payload
 * parser, and the orchestrator dispatch.
 */

/**
 * How many files one chat turn may carry. The cap is what stops the signed
 * image batch from approaching the relay's request ceiling once the bytes are
 * base64-expanded into prompt content.
 */
export const CHAT_ATTACHMENT_MAX_COUNT = 4;

/** Above this an attachment is referenced but never inlined as pixels. */
export const CHAT_ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;

/** Matches the drive index's own path shape (see `normalizeDrivePath`). */
const MAX_ATTACHMENT_PATH_LENGTH = 400;

/**
 * Whether a string can name a drive row. Absolute paths, Windows drive
 * letters, traversal segments, and control characters can never resolve, and a
 * path that cannot resolve must not reach a turn as though it might.
 */
export const isChatAttachmentPath = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const path = value.trim();
  if (!path || path.length > MAX_ATTACHMENT_PATH_LENGTH) return false;
  if (path !== value) return false;
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) return false;
  if (path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path)) return false;
  const segments = path.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
};

/**
 * Lenient normalization for the surfaces where an attachment is a hint: junk
 * is dropped rather than failing a send the user already committed to.
 */
export const normalizeChatAttachmentPaths = (
  paths: readonly unknown[],
): string[] => [
  ...new Set(paths.filter(isChatAttachmentPath).slice(0, CHAT_ATTACHMENT_MAX_COUNT)),
];

export type ChatAttachmentParseFailure = {
  ok: false;
  reason: "not-an-array" | "too-many" | "invalid-path" | "duplicate-path";
  message: string;
};

export type ChatAttachmentParseResult =
  | { ok: true; paths: string[] }
  | ChatAttachmentParseFailure;

/**
 * Strict parse for the execution-placement envelope, where an attachment is
 * not a hint. The turn is already fenced by a payload hash and a dispatch
 * identity; quietly truncating the array would execute a materially different
 * request than the one the user sent and the one that hash covers.
 */
export const parseChatAttachmentPaths = (
  value: unknown,
): ChatAttachmentParseResult => {
  if (value === undefined || value === null) return { ok: true, paths: [] };
  if (!Array.isArray(value)) {
    return {
      ok: false,
      reason: "not-an-array",
      message: "Chat attachments must be an array of drive paths.",
    };
  }
  if (value.length > CHAT_ATTACHMENT_MAX_COUNT) {
    return {
      ok: false,
      reason: "too-many",
      message: `A chat turn may carry at most ${CHAT_ATTACHMENT_MAX_COUNT} attachments.`,
    };
  }
  const paths: string[] = [];
  for (const entry of value) {
    if (!isChatAttachmentPath(entry)) {
      return {
        ok: false,
        reason: "invalid-path",
        message: "A chat attachment does not name a drive file.",
      };
    }
    if (paths.includes(entry)) {
      return {
        ok: false,
        reason: "duplicate-path",
        message: "A chat attachment was listed more than once.",
      };
    }
    paths.push(entry);
  }
  return { ok: true, paths };
};
