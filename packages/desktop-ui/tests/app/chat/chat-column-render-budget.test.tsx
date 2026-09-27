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
import { act, useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MessageRecord } from "@stella/contracts/local-chat";
import { ChatColumn } from "@/app/chat/ChatColumn";
import { ChatMessagesContext } from "@/context/chat-messages-context";
import { ChatRuntimeContext } from "@/context/chat-runtime-context";
import {
  useComposerMessageSelector,
  useComposerMessageStore,
} from "@/features/chat/hooks/use-composer-message-state";
import type {
  ChatColumnComposer,
  ChatColumnConversation,
  ChatColumnScroll,
} from "@/features/chat/chat-column-types";
import { UiStateProvider } from "@/context/ui-state";
import { withI18n } from "../../helpers/i18n";
import { installIdleCallbackQueue } from "../../helpers/render-budget-settle";

const CONVERSATION_ID = "keystroke-budget";

const messages: MessageRecord[] = Array.from({ length: 40 }, (_, index) => {
  const isUser = index % 2 === 0;
  return {
    _id: `m-${index}`,
    timestamp: index + 1,
    type: isUser ? "user_message" : "assistant_message",
    payload: isUser
      ? { text: `Question ${index}` }
      : {
          text: `Answer ${index} with **markdown** and a [link](https://example.com).`,
          userMessageId: `m-${index - 1}`,
        },
    toolEvents: [],
  } as MessageRecord;
});

const tasks = Array.from({ length: 200 }, (_, index) => ({
  id: `task-${index}`,
  description: `Task ${index}`,
  status: "completed",
  modelConfigSnapshot: { provider: "stella", model: "gpt-5" },
})) as unknown as ChatColumnConversation["tasks"];

const conversation: ChatColumnConversation = {
  tasks,
  activity: {
    activities: [],
    hasOlder: false,
    isLoadingOlder: false,
    loadOlder: () => {},
  },
  files: { files: [], hasOlder: false, isLoadingOlder: false, loadOlder: () => {} },
  streaming: {
    reasoningText: "",
    isStreaming: false,
    pendingUserMessageId: null,
    queuedUserMessages: [],
    removeQueuedUserMessage: () => {},
  },
  history: {
    hasOlderMessages: false,
    hasNewerMessages: false,
    isLoadingOlder: false,
    isLoadingNewer: false,
    isInitialLoading: false,
  },
};

const scroll: ChatColumnScroll = {
  listRef: { current: null },
  showScrollButton: false,
  isAtBottom: true,
  isNearBottom: true,
  isFollowingLatest: true,
  isUserScrolling: false,
  noteManualScroll: () => {},
  getIsFollowing: () => true,
  scrollToBottom: () => {},
  thumbRef: () => {},
};

let typeKey: ((value: string) => void) | null = null;
let publishMessages: ((next: MessageRecord[]) => void) | null = null;

/**
 * Mirrors `useFullShellChat`'s ownership: the runtime owner holds the draft in
 * a composer message store, reads only "has text", and publishes the composer
 * object on the runtime context and to the chat column.
 */
function Harness() {
  const { store, setMessage } = useComposerMessageStore();
  typeKey = setMessage;
  const [timeline, setTimeline] = useState(messages);
  publishMessages = setTimeline;
  const hasText = useComposerMessageSelector(
    store,
    (text) => text.trim().length > 0,
  );
  const composer = useMemo<ChatColumnComposer>(
    () => ({
      messageStore: store,
      setMessage,
      chatContext: null,
      setChatContext: () => {},
      selectedText: null,
      setSelectedText: () => {},
      canSubmit: hasText,
      onSend: () => {},
      onStop: () => {},
    }),
    [hasText, setMessage, store],
  );
  const runtime = useMemo(
    () => ({ conversation, composer, scroll }),
    [composer],
  );
  return (
    <ChatRuntimeContext.Provider value={runtime as never}>
      <ChatMessagesContext.Provider value={timeline}>
        <ChatColumn
          conversation={conversation}
          composer={composer}
          scroll={scroll}
          conversationId={CONVERSATION_ID}
          showHomeContent={false}
        />
      </ChatMessagesContext.Provider>
    </ChatRuntimeContext.Provider>
  );
}

describe("composer keystroke render budget", () => {
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

  it("re-renders only the composer leaf per keystroke", async () => {
    await act(async () => {
      root.render(
        withI18n(
          <UiStateProvider>
            <Harness />
          </UiStateProvider>,
        ),
      );
    });
    // The first character flips "has text" (submit enablement), which is a
    // legitimate runtime-wide change; the budget covers the keystrokes after.
    await act(async () => {
      typeKey?.("h");
    });
    // Settle the mount-time idle warm-up before counting.
    await act(async () => {
      idle.flush();
    });
    expect(idle.pending).toBe(0);
    const keystrokes = ["he", "hel", "hell", "hello"];
    const report = await countRenders(async () => {
      for (const text of keystrokes) {
        await act(async () => {
          typeKey?.(text);
        });
      }
    });

    expect(container.querySelector("textarea")?.value).toBe("hello");
    // Before the store split a keystroke re-rendered the runtime owner, the
    // chat column and ~73 components under it (two Radix add-menu trees,
    // cards, the activity pill); now it is the composer leaf alone.
    expect(report.total).toBeLessThanOrEqual(keystrokes.length * 6);
    for (const name of [
      "Harness",
      "ChatColumn",
      "ConversationEvents",
      "ComposerActivityPill",
      "ComposerAddMenu",
      "ComposerLeadRow",
      "ComposerNotice",
    ]) {
      expect(report.byComponent[name], name).toBeUndefined();
    }
  });
});

describe("timeline append render budget", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("commits once and skips composer-side subtrees per new reply", async () => {
    await act(async () => {
      root.render(
        withI18n(
          <UiStateProvider>
            <Harness />
          </UiStateProvider>,
        ),
      );
    });
    const report = await countRenders(async () => {
      await act(async () => {
        publishMessages?.([
          ...messages,
          {
            _id: "m-new",
            timestamp: 1_000,
            type: "assistant_message",
            payload: { text: "A new reply", userMessageId: "m-38" },
            toolEvents: [],
          } as MessageRecord,
        ]);
      });
    });
    // Before: two commits (the reply-peek baseline was synced in an effect)
    // and the composer, the four above-composer cards and the column all
    // rendered twice. jsdom has no layout, so virtualized rows are not
    // mounted here; this budget covers the chrome around them.
    expect(report.commits).toBe(1);
    expect(report.byComponent.ChatColumn).toBe(1);
    for (const name of [
      "StoreBackedComposer",
      "ComposerImpl",
      "ConnectorConnectCard",
      "CloudConnectorConnectCard",
      "CloudBrowserInterventionCard",
      "ComposerNotice",
    ]) {
      expect(report.byComponent[name], name).toBeUndefined();
    }
  });
});
