import { describe, expect, it } from "vitest";
import {
  CHAT_ATTACHMENT_MAX_COUNT,
  isChatAttachmentPath,
  normalizeChatAttachmentPaths,
  parseChatAttachmentPaths,
} from "./chat_attachments";

const uploads = (count: number) =>
  Array.from({ length: count }, (_, index) => `uploads/2026-08-29/f${index}.png`);

describe("what can name a drive file", () => {
  it("accepts a drive-relative posix path", () => {
    expect(isChatAttachmentPath("uploads/2026-08-29/photo.png")).toBe(true);
    expect(isChatAttachmentPath("lease.pdf")).toBe(true);
  });

  it("rejects everything that could not resolve to a drive row", () => {
    for (const path of [
      "",
      " ",
      "/etc/passwd",
      "C:/Windows/win.ini",
      "c:relative",
      "uploads\\2026\\photo.png",
      "uploads/../../secrets.txt",
      "uploads/./photo.png",
      "uploads//photo.png",
      "uploads/photo\u0000.png",
      "uploads/photo\u007f.png",
      " uploads/photo.png",
      "uploads/photo.png ",
      `uploads/${"a".repeat(400)}.png`,
    ]) {
      expect(isChatAttachmentPath(path), path).toBe(false);
    }
  });

  it("rejects a non-string", () => {
    for (const value of [null, undefined, 7, {}, [], true]) {
      expect(isChatAttachmentPath(value)).toBe(false);
    }
  });
});

describe("the strict envelope parse", () => {
  it("treats an absent array as no attachments", () => {
    expect(parseChatAttachmentPaths(undefined)).toEqual({ ok: true, paths: [] });
    expect(parseChatAttachmentPaths(null)).toEqual({ ok: true, paths: [] });
    expect(parseChatAttachmentPaths([])).toEqual({ ok: true, paths: [] });
  });

  it("passes a full turn through in order", () => {
    const paths = uploads(CHAT_ATTACHMENT_MAX_COUNT);
    expect(parseChatAttachmentPaths(paths)).toEqual({ ok: true, paths });
  });

  it("fails rather than truncating one over the cap", () => {
    const result = parseChatAttachmentPaths(
      uploads(CHAT_ATTACHMENT_MAX_COUNT + 1),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("too-many");
  });

  it("fails on a path that cannot resolve", () => {
    const result = parseChatAttachmentPaths([
      "uploads/ok.png",
      "../../etc/passwd",
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("invalid-path");
  });

  it("fails on a duplicate rather than collapsing it", () => {
    const result = parseChatAttachmentPaths([
      "uploads/a.png",
      "uploads/a.png",
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("duplicate-path");
  });

  it("fails on a value that is not an array", () => {
    const result = parseChatAttachmentPaths("uploads/a.png");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("not-an-array");
  });
});

describe("the lenient normalizer", () => {
  it("drops what the strict parse refuses, because its callers already committed", () => {
    expect(
      normalizeChatAttachmentPaths([
        "uploads/a.png",
        "/absolute.png",
        42,
        "uploads/a.png",
        "uploads/b.png",
      ]),
    ).toEqual(["uploads/a.png", "uploads/b.png"]);
  });

  it("caps at the turn budget", () => {
    expect(
      normalizeChatAttachmentPaths(uploads(CHAT_ATTACHMENT_MAX_COUNT + 3)),
    ).toHaveLength(CHAT_ATTACHMENT_MAX_COUNT);
  });
});
