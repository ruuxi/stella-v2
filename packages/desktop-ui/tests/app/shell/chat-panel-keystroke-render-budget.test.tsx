// @vitest-environment jsdom
import { countRenders } from "../../helpers/react-render-counter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("convex/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/react")>()),
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
  useQuery: () => undefined,
  useMutation: () => async () => undefined,
  useAction: () => async () => undefined,
}));
// Hold the auth session settled; see tests/helpers/render-budget-settle.ts.
vi.mock("@/global/auth/services/auth-session", async (importOriginal) =>
  (await import("../../helpers/render-budget-settle")).settledAuthSessionModule(
    importOriginal,
  ),
);

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MessageRecord } from "@stella/contracts/local-chat";
import { ChatPanelTab } from "@/shell/ChatSidebar";
import { UiStateProvider } from "@/context/ui-state";
import { withI18n } from "../../helpers/i18n";
import { installIdleCallbackQueue } from "../../helpers/render-budget-settle";

const messages: MessageRecord[] = Array.from({ length: 20 }, (_, index) => {
  const isUser = index % 2 === 0;
  return {
    _id: `m-${index}`,
    timestamp: index + 1,
    type: isUser ? "user_message" : "assistant_message",
    payload: isUser
      ? { text: `Question ${index}` }
      : { text: `Answer ${index}`, userMessageId: `m-${index - 1}` },
    toolEvents: [],
  } as MessageRecord;
});

const noop = () => {};
const onSend = vi.fn(() => true);

const typeInto = (textarea: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
};

describe("chat panel keystroke render budget", () => {
  let container: HTMLDivElement;
  let root: Root;
  let idle: ReturnType<typeof installIdleCallbackQueue>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    idle = installIdleCallbackQueue();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("does not re-render the conversation timeline per keystroke", async () => {
    await act(async () => {
      root.render(
        withI18n(
          <UiStateProvider>
            <ChatPanelTab
              isolated
              messages={messages}
              conversationId="panel-budget"
              isStreaming={false}
              pendingUserMessageId={null}
              hasOlderMessages={false}
              hasNewerMessages={false}
              isLoadingOlder={false}
              isLoadingNewer={false}
              isInitialLoading={false}
              onLoadOlder={noop}
              onLoadNewer={noop}
              onLoadLatest={noop}
              onSend={onSend}
            />
          </UiStateProvider>,
        ),
      );
    });
    const textarea = container.querySelector("textarea")!;
    await act(async () => typeInto(textarea, "h"));
    // Settle the mount-time idle warm-up before counting.
    await act(async () => {
      idle.flush();
    });
    expect(idle.pending).toBe(0);
    const report = await countRenders(async () => {
      for (const text of ["he", "hel", "hell", "hello"]) {
        await act(async () => typeInto(textarea, text));
      }
    });
    expect(textarea.value).toBe("hello");
    // Before: ~76 renders per keystroke. The panel owned the draft text, so
    // every keystroke re-rendered it; a fresh working-indicator object also
    // busted the memoized timeline (ConversationEvents -> ChatTimeline ->
    // LegendList) and both "+" menus re-rendered their Radix trees. Now the
    // form is the only subscriber to the draft store.
    expect(report.total).toBeLessThanOrEqual(4 * 4);
    for (const name of [
      "AccountScopedChatPanelTab",
      "CompactConversationSurface",
      "ConversationEvents",
      "ChatTimeline",
      "ComposerAddMenu",
      "ComposerLeadRow",
      "ComposerNotice",
    ]) {
      expect(report.byComponent[name], name).toBeUndefined();
    }

    // The panel still sends the store's text and clears the draft.
    await act(async () => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(onSend).toHaveBeenCalledWith(
      "hello",
      null,
      null,
      expect.any(Function),
    );
    expect(container.querySelector("textarea")!.value).toBe("");
  });
});
