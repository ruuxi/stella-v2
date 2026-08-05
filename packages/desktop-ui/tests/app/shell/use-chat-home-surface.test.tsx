// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uiState } from "@/platform/ui-state";
import { dispatchShowHome } from "@/shared/lib/stella-orb-chat";
import { useChatHomeSurface } from "@/shell/use-chat-home-surface";

type HarnessProps = {
  conversationId: string;
  hasMessages: boolean;
  isInitialLoading?: boolean;
};

let latestHomeState: ReturnType<typeof useChatHomeSurface> | null = null;

function Harness({
  conversationId,
  hasMessages,
  isInitialLoading = false,
}: HarnessProps) {
  latestHomeState = useChatHomeSurface({
    isOnChatRoute: true,
    hasMessages,
    isInitialLoading,
    isStreaming: false,
    activeConversationId: conversationId,
  });
  return (
    <div data-testid="surface">
      {latestHomeState.showHomeContent ? "home" : "chat"}
    </div>
  );
}

describe("useChatHomeSurface conversation tabs", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    uiState.clear();
    sessionStorage.clear();
    latestHomeState = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    uiState.clear();
    sessionStorage.clear();
    latestHomeState = null;
  });

  const render = async (props: HarnessProps) => {
    await act(async () => {
      root.render(<Harness {...props} />);
      await Promise.resolve();
    });
  };

  it("returns from an empty new tab to the populated tab timeline", async () => {
    await render({ conversationId: "existing", hasMessages: true });
    await act(async () => latestHomeState?.dismissHome());
    expect(container.textContent).toBe("chat");

    await render({ conversationId: "new", hasMessages: false });
    expect(container.textContent).toBe("home");

    await render({ conversationId: "existing", hasMessages: true });
    expect(container.textContent).toBe("chat");
  });

  it("keeps a newly selected empty conversation on Home", async () => {
    await render({ conversationId: "existing", hasMessages: true });
    await act(async () => latestHomeState?.dismissHome());

    await render({ conversationId: "new", hasMessages: false });
    expect(container.textContent).toBe("home");
  });

  it("does not flash Home while a selected populated conversation loads", async () => {
    await render({ conversationId: "existing", hasMessages: true });
    await act(async () => latestHomeState?.dismissHome());
    expect(container.textContent).toBe("chat");

    await render({
      conversationId: "other",
      hasMessages: false,
      isInitialLoading: true,
    });
    expect(container.textContent).toBe("chat");

    await render({ conversationId: "other", hasMessages: true });
    expect(container.textContent).toBe("chat");
  });

  it("shows Home after a selected empty conversation finishes loading", async () => {
    await render({ conversationId: "existing", hasMessages: true });
    await act(async () => latestHomeState?.dismissHome());

    await render({
      conversationId: "new",
      hasMessages: false,
      isInitialLoading: true,
    });
    expect(container.textContent).toBe("chat");

    await render({ conversationId: "new", hasMessages: false });
    expect(container.textContent).toBe("home");
  });

  it("opens Home from a populated conversation when the launcher is clicked", async () => {
    await render({ conversationId: "existing", hasMessages: true });
    await act(async () => latestHomeState?.dismissHome());
    expect(container.textContent).toBe("chat");

    await act(async () => dispatchShowHome());
    expect(container.textContent).toBe("home");
  });
});
