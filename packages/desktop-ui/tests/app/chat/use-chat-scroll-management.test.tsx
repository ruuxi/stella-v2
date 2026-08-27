import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatScrollManagement } from "@/shell/use-chat-scroll-management";

type HistoryProps = {
  hasOlderEvents?: boolean;
  hasNewerEvents: boolean;
  isLoadingOlder: boolean;
  isLoadingNewer?: boolean;
  onLoadOlder?: () => boolean | void | Promise<boolean>;
  onLoadLatest?: () => boolean | void | Promise<boolean>;
  paginationKey?: string;
};
type LoadLatest = NonNullable<HistoryProps["onLoadLatest"]>;

describe("useChatScrollManagement pagination wiring", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ReturnType<typeof useChatScrollManagement> | null;
  let nextAnimationFrameId: number;
  let animationFrameCallbacks: Map<number, FrameRequestCallback>;

  function Harness(props: HistoryProps) {
    latest = useChatScrollManagement(props);
    return null;
  }

  const render = async (props: HistoryProps) => {
    await act(async () => {
      root.render(<Harness {...props} />);
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    nextAnimationFrameId = 0;
    animationFrameCallbacks = new Map();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = ++nextAnimationFrameId;
      animationFrameCallbacks.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      animationFrameCallbacks.delete(id);
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = null;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("queues a latest jump behind an active cursor read and retries exactly once", async () => {
    const onLoadLatest = vi
      .fn<LoadLatest>()
      .mockReturnValueOnce(false)
      .mockResolvedValueOnce(true);

    await render({
      hasNewerEvents: true,
      isLoadingOlder: true,
      onLoadLatest,
      paginationKey: "conversation-a",
    });

    act(() => latest?.scrollToBottom("instant"));
    expect(onLoadLatest).toHaveBeenCalledTimes(1);

    await render({
      hasNewerEvents: true,
      isLoadingOlder: false,
      onLoadLatest,
      paginationKey: "conversation-a",
    });
    expect(onLoadLatest).toHaveBeenCalledTimes(2);

    await render({
      hasNewerEvents: false,
      isLoadingOlder: false,
      onLoadLatest,
      paginationKey: "conversation-a",
    });
    expect(onLoadLatest).toHaveBeenCalledTimes(2);
    expect(window.requestAnimationFrame).toHaveBeenCalled();
  });

  it("clears rejected latest intent and does not retry on later renders", async () => {
    const onLoadLatest = vi
      .fn<LoadLatest>()
      .mockRejectedValue(new Error("latest failed"));

    await render({
      hasNewerEvents: true,
      isLoadingOlder: false,
      onLoadLatest,
      paginationKey: "conversation-a",
    });
    await act(async () => {
      latest?.scrollToBottom();
      await Promise.resolve();
    });

    await render({
      hasNewerEvents: true,
      isLoadingOlder: true,
      onLoadLatest,
      paginationKey: "conversation-a",
    });
    await render({
      hasNewerEvents: true,
      isLoadingOlder: false,
      onLoadLatest,
      paginationKey: "conversation-a",
    });
    expect(onLoadLatest).toHaveBeenCalledTimes(1);
  });

  it("does not retain latest intent after an idle synchronous rejection", async () => {
    const onLoadLatest = vi.fn<LoadLatest>(() => false);
    await render({
      hasNewerEvents: true,
      isLoadingOlder: false,
      isLoadingNewer: false,
      onLoadLatest,
      paginationKey: "conversation-a",
    });

    act(() => latest?.scrollToBottom("instant"));
    expect(onLoadLatest).toHaveBeenCalledTimes(1);

    await render({
      hasNewerEvents: true,
      isLoadingOlder: true,
      isLoadingNewer: false,
      onLoadLatest,
      paginationKey: "conversation-a",
    });
    await render({
      hasNewerEvents: true,
      isLoadingOlder: false,
      isLoadingNewer: false,
      onLoadLatest,
      paginationKey: "conversation-a",
    });
    expect(onLoadLatest).toHaveBeenCalledTimes(1);
  });

  it("drops queued latest intent when the conversation changes", async () => {
    const onLoadLatest = vi.fn<LoadLatest>(() => false);

    await render({
      hasNewerEvents: true,
      isLoadingOlder: true,
      onLoadLatest,
      paginationKey: "conversation-a",
    });
    act(() => latest?.scrollToBottom());

    await render({
      hasNewerEvents: true,
      isLoadingOlder: false,
      onLoadLatest,
      paginationKey: "conversation-b",
    });
    expect(onLoadLatest).toHaveBeenCalledTimes(1);
  });

  it("uses Legend's end movement directly when the current window is live", async () => {
    await render({
      hasNewerEvents: false,
      isLoadingOlder: false,
      paginationKey: "conversation-a",
    });
    const scrollToEnd = vi.fn(() => Promise.resolve());
    if (!latest) throw new Error("scroll hook did not render");
    latest.listRef.current = { scrollToEnd } as never;

    act(() => latest?.scrollToBottom("instant"));
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
  });

  it("does not turn editor navigation keys into pagination intent", async () => {
    const onLoadOlder = vi.fn(() => false);
    await render({
      hasOlderEvents: true,
      hasNewerEvents: false,
      isLoadingOlder: false,
      onLoadOlder,
      paginationKey: "conversation-a",
    });

    const scrollNode = document.createElement("div");
    const editor = document.createElement("textarea");
    scrollNode.appendChild(editor);
    container.appendChild(scrollNode);
    if (!latest) throw new Error("scroll hook did not render");
    latest.listRef.current = {
      getScrollableNode: () => scrollNode,
      getState: () => ({
        scroll: 50,
        scrollLength: 100,
        contentLength: 1_000,
        isAtEnd: false,
      }),
    } as never;

    const attach = animationFrameCallbacks.values().next().value;
    if (!attach) throw new Error("attach watcher was not scheduled");
    act(() => attach(0));

    act(() => {
      editor.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      );
    });
    expect(onLoadOlder).not.toHaveBeenCalled();

    act(() => {
      scrollNode.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      );
    });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });
});
