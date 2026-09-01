import { afterEach, describe, expect, it, vi } from "vitest";

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("@/ui/toast", () => ({ showToast }));

import {
  clearComposerNotices,
  dismissComposerNotice,
  getComposerNotices,
  presentComposerNotice,
  registerComposerNoticeSurface,
  resetComposerNotices,
  selectComposerNotice,
  showComposerNotice,
} from "@/features/chat/composer-notice-store";

const titles = () => getComposerNotices().map((entry) => entry.title);

afterEach(() => {
  resetComposerNotices();
  showToast.mockReset();
});

describe("composer notice store", () => {
  it("prefers the chat-scoped notice and falls back to an unscoped one", () => {
    showComposerNotice({
      conversationId: null,
      kind: "sign-in",
      title: "Sign in",
    });
    showComposerNotice({
      conversationId: "chat-a",
      kind: "upgrade",
      title: "Upgrade",
    });
    const entries = getComposerNotices();
    expect(selectComposerNotice(entries, "chat-a")?.title).toBe("Upgrade");
    expect(selectComposerNotice(entries, "chat-b")?.title).toBe("Sign in");
    expect(selectComposerNotice(entries, null)?.title).toBe("Sign in");
  });

  it("keeps one notice per scope, newest wins", () => {
    showComposerNotice({
      conversationId: "chat-a",
      kind: "upgrade",
      title: "First",
    });
    showComposerNotice({
      conversationId: "chat-a",
      kind: "limit",
      title: "Second",
    });
    expect(titles()).toEqual(["Second"]);
    expect(selectComposerNotice(getComposerNotices(), "chat-b")).toBeNull();
  });

  it("clears the chat's notice and unscoped notices on a new send, keeping other chats", () => {
    showComposerNotice({
      conversationId: null,
      kind: "sign-in",
      title: "Sign in",
    });
    showComposerNotice({
      conversationId: "chat-a",
      kind: "upgrade",
      title: "A",
    });
    showComposerNotice({ conversationId: "chat-b", kind: "limit", title: "B" });
    clearComposerNotices("chat-a");
    expect(titles()).toEqual(["B"]);
  });

  it("dismisses by id and ignores unknown ids", () => {
    const id = showComposerNotice({
      conversationId: "chat-a",
      kind: "provider",
      title: "Key",
    });
    const before = getComposerNotices();
    dismissComposerNotice("nope");
    expect(getComposerNotices()).toBe(before);
    dismissComposerNotice(id);
    expect(titles()).toEqual([]);
  });

  it("falls back to a toast when no chat surface is mounted", () => {
    presentComposerNotice(
      {
        conversationId: null,
        kind: "sign-in",
        title: "Sign in",
        description: "d",
      },
      { title: "Toast", variant: "error" },
    );
    expect(showToast).toHaveBeenCalledWith({
      title: "Toast",
      variant: "error",
    });
    expect(titles()).toEqual([]);
  });

  it("builds the fallback toast from the notice when none is given", () => {
    const action = { label: "Sign in", onClick: () => {} };
    presentComposerNotice({
      conversationId: null,
      kind: "sign-in",
      title: "Sign in",
      action,
    });
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Sign in", variant: "error", action }),
    );
  });

  it("pins the notice instead of toasting while a surface is mounted", () => {
    const release = registerComposerNoticeSurface();
    presentComposerNotice(
      { conversationId: "chat-a", kind: "upgrade", title: "Upgrade" },
      { title: "Toast", variant: "error" },
    );
    expect(showToast).not.toHaveBeenCalled();
    expect(titles()).toEqual(["Upgrade"]);
    release();
    presentComposerNotice({
      conversationId: null,
      kind: "limit",
      title: "Later",
    });
    expect(showToast).toHaveBeenCalledTimes(1);
  });
});
