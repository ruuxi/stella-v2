// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SocialInviteLayer } from "@/global/social/SocialInviteLayer";
import { setPendingSocialInvite } from "@/global/social/social-invite-store";
import { parseSocialInviteLink } from "@/app/social/invite-links";
import { router } from "@/router";
import { useChatHomeSurface } from "@/shell/use-chat-home-surface";
import { uiState } from "@/platform/ui-state";

const CHAT_HOME_SURFACE_STORAGE_KEY = "stella.chatHomeSurface";

function HomeFallbackHarness() {
  const { showHomeContent } = useChatHomeSurface({
    isOnChatRoute: true,
    hasMessages: false,
    isStreaming: false,
    activeConversationId: "conversation-1",
  });
  return (
    <>
      <output>{showHomeContent ? "home" : "chat"}</output>
      <SocialInviteLayer />
    </>
  );
}

describe("retired Store invite fallback", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    setPendingSocialInvite(null);
    uiState.setItem(CHAT_HOME_SURFACE_STORAGE_KEY, "chat");
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: {},
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    setPendingSocialInvite(null);
    vi.restoreAllMocks();
    await act(async () => root.unmount());
    container.remove();
    uiState.removeItem(CHAT_HOME_SURFACE_STORAGE_KEY);
    Reflect.deleteProperty(window, "electronAPI");
  });

  it("lands a Store deep link on Home through the existing Chat route", async () => {
    const navigate = vi.spyOn(router, "navigate").mockResolvedValue(undefined);
    await act(async () => {
      root.render(<HomeFallbackHarness />);
      await Promise.resolve();
    });
    expect(container.querySelector("output")?.textContent).toBe("chat");

    await act(async () => {
      setPendingSocialInvite(
        parseSocialInviteLink(
          "stella://store/legacy-creator/legacy-addon",
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(navigate).toHaveBeenCalledWith({ to: "/chat", replace: true });
    expect(container.querySelector("output")?.textContent).toBe("home");
    expect(uiState.getItem(CHAT_HOME_SURFACE_STORAGE_KEY)).toBe("home");
  });
});
