import { afterEach, describe, expect, test } from "bun:test";
import {
  classifyComposerNotice,
  clearComposerNotices,
  dismissComposerNotice,
  getComposerNotices,
  resetComposerNotices,
  selectComposerNotice,
  showComposerNotice,
  showComposerNoticeForError,
} from "../composer-notice";

const titles = () => getComposerNotices().map((entry) => entry.title);

afterEach(() => {
  resetComposerNotices();
});

describe("composer notice store", () => {
  test("prefers the conversation-scoped notice and falls back to unscoped", () => {
    showComposerNotice({
      conversationId: null,
      kind: "sign-in",
      title: "Sign in",
    });
    showComposerNotice({
      conversationId: "c1",
      kind: "upgrade",
      title: "Upgrade",
    });
    const entries = getComposerNotices();
    expect(selectComposerNotice(entries, "c1")?.title).toBe("Upgrade");
    expect(selectComposerNotice(entries, "c2")?.title).toBe("Sign in");
    expect(selectComposerNotice(entries, null)?.title).toBe("Sign in");
  });

  test("keeps one notice per scope, newest wins", () => {
    showComposerNotice({
      conversationId: "c1",
      kind: "upgrade",
      title: "First",
    });
    showComposerNotice({
      conversationId: "c1",
      kind: "limit",
      title: "Second",
    });
    expect(titles()).toEqual(["Second"]);
  });

  test("a new send clears its own and unscoped notices only", () => {
    showComposerNotice({
      conversationId: null,
      kind: "sign-in",
      title: "Sign in",
    });
    showComposerNotice({ conversationId: "c1", kind: "upgrade", title: "A" });
    showComposerNotice({ conversationId: "c2", kind: "limit", title: "B" });
    clearComposerNotices("c1");
    expect(titles()).toEqual(["B"]);
  });

  test("dismisses by id", () => {
    const id = showComposerNotice({
      conversationId: "c1",
      kind: "provider",
      title: "Key",
    });
    dismissComposerNotice("nope");
    expect(titles()).toEqual(["Key"]);
    dismissComposerNotice(id);
    expect(titles()).toEqual([]);
  });
});

describe("classifyComposerNotice", () => {
  test("maps blocking account and plan failures to a notice kind", () => {
    expect(classifyComposerNotice("Sign in required")?.kind).toBe("sign-in");
    expect(classifyComposerNotice("Authentication required.")?.kind).toBe(
      "sign-in",
    );
    expect(classifyComposerNotice("401 Unauthorized")?.kind).toBe("sign-in");
    expect(classifyComposerNotice("Your session expired")?.kind).toBe(
      "sign-in",
    );
    expect(classifyComposerNotice("Usage limit reached")?.kind).toBe("upgrade");
    expect(classifyComposerNotice("free_allowance_exhausted")?.kind).toBe(
      "upgrade",
    );
    expect(
      classifyComposerNotice(
        "[capability/video_generation] capability_required",
      )?.kind,
    ).toBe("upgrade");
    expect(
      classifyComposerNotice("Unsupported Stella model selection")?.kind,
    ).toBe("upgrade");
    expect(classifyComposerNotice("Rate limit exceeded")?.kind).toBe("limit");
    expect(classifyComposerNotice("status 429 too many requests")?.kind).toBe(
      "limit",
    );
    expect(
      classifyComposerNotice("Authentication failed: bad api key")?.kind,
    ).toBe("provider");
  });

  test("free allowance never reads as a wait-and-retry limit", () => {
    const notice = classifyComposerNotice(
      "free_allowance_exhausted: usage limit reached",
    );
    expect(notice?.kind).toBe("upgrade");
    expect(notice?.description).not.toContain("resets");
  });

  test("leaves transient failures to the reply bubble", () => {
    for (const message of [
      "fetch failed",
      "Could not connect to your desktop.",
      "timed out",
      "Something went wrong.",
      "",
      null,
    ]) {
      expect(classifyComposerNotice(message)).toBeNull();
    }
  });

  test("showComposerNoticeForError pins only actionable errors", () => {
    expect(showComposerNoticeForError(new Error("network error"), "c1")).toBe(
      false,
    );
    expect(titles()).toEqual([]);
    expect(
      showComposerNoticeForError(new Error("Sign in required"), "c1"),
    ).toBe(true);
    expect(getComposerNotices()[0]?.conversationId).toBe("c1");
  });
});
