import { afterAll, beforeAll, describe, expect, test } from "bun:test";
// The root workspace owns this test-only dependency (see the RN acceptance
// preload); the mobile bundle never ships it.
// @ts-expect-error jsdom intentionally has no installed declaration package.
import { JSDOM } from "jsdom";
import { act, createElement, useState } from "react";
import {
  createChatDraftStore,
  useChatDraft,
  useChatDraftSelector,
  type ChatDraftStore,
} from "../chat-draft-store";

describe("chat draft store", () => {
  test("functional updates, no-op writes and unsubscribe", () => {
    const store = createChatDraftStore();
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    store.set("hi");
    store.set((previous) => `${previous} there`);
    store.set("hi there");
    expect(store.get()).toBe("hi there");
    expect(notified).toBe(2);
    unsubscribe();
    store.set("");
    expect(notified).toBe(2);
  });
});

// Ratchet for the typing path. The draft used to be React state in the chat
// thread hook, so every keystroke re-rendered the thread hooks, the chat
// screen and the whole chat pane. This mirrors that tree: the screen owns the
// store, the pane selects "has text", and only the input reads the value.
describe("chat draft renders", () => {
  let dom: { window: Window & typeof globalThis } | null = null;
  const globals = globalThis as Record<string, unknown>;
  beforeAll(() => {
    dom = new JSDOM("<!doctype html><div id=root></div>");
    globals.window = dom!.window;
    globals.document = dom!.window.document;
    globals.IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete globals.window;
    delete globals.document;
    delete globals.IS_REACT_ACT_ENVIRONMENT;
  });

  test("a keystroke re-renders only the input", async () => {
    const { createRoot } = await import("react-dom/client");
    const renders = { screen: 0, pane: 0, input: 0 };
    let store: ChatDraftStore | null = null;
    const hasText = (draft: string) => draft.trim().length > 0;
    const Input = ({ draftStore }: { draftStore: ChatDraftStore }) => {
      renders.input += 1;
      return createElement("span", null, useChatDraft(draftStore));
    };
    const Pane = ({ draftStore }: { draftStore: ChatDraftStore }) => {
      renders.pane += 1;
      const canSend = useChatDraftSelector(draftStore, hasText);
      return createElement("div", { "data-send": String(canSend) },
        createElement(Input, { draftStore }));
    };
    const Screen = () => {
      renders.screen += 1;
      const [draftStore] = useState(createChatDraftStore);
      store = draftStore;
      return createElement(Pane, { draftStore });
    };
    const root = createRoot(dom!.window.document.getElementById("root")!);
    await act(async () => root.render(createElement(Screen)));
    const typed = "hello stella";
    for (let index = 1; index <= typed.length; index += 1) {
      await act(async () => store!.set(typed.slice(0, index)));
    }
    await act(async () => store!.set(""));
    expect(renders.screen).toBe(1);
    // Mount, the empty → text flip, and the clear after send.
    expect(renders.pane).toBe(3);
    expect(renders.input).toBe(1 + typed.length + 1);
    await act(async () => root.unmount());
  });
});
