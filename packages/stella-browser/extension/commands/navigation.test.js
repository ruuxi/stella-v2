import assert from "node:assert/strict";
import test from "node:test";

const noopEvent = { addListener() {} };
const updateListeners = new Set();
let updateCalls = 0;
let getCalls = 0;
let postUpdateGetCalls = 0;
let storage = {
  agentWindowId: 1,
  stellaGroupId: null,
  ownerTabState: {
    "owner-a": {
      tabIds: [17],
      activeTabId: 17,
      lastTouchedAtByTabId: { 17: Date.now() },
    },
  },
};

globalThis.chrome = {
  storage: {
    session: {
      async get(keys) {
        return Object.fromEntries(keys.map((key) => [key, storage[key]]));
      },
      async set(value) {
        storage = { ...storage, ...value };
      },
    },
  },
  windows: {
    onRemoved: noopEvent,
    async get() {
      return { id: 1, type: "normal" };
    },
    async getLastFocused() {
      return { id: 1, type: "normal" };
    },
    async getAll() {
      return [{ id: 1, type: "normal" }];
    },
  },
  tabGroups: {
    async query() {
      return [];
    },
    async get() {
      throw new Error("group not found");
    },
  },
  tabs: {
    onCreated: noopEvent,
    onRemoved: noopEvent,
    onUpdated: {
      addListener(listener) {
        updateListeners.add(listener);
      },
      removeListener(listener) {
        updateListeners.delete(listener);
      },
    },
    async get(tabId) {
      getCalls += 1;
      if (updateCalls > 0) postUpdateGetCalls += 1;
      return { id: tabId, windowId: 1, groupId: -1, url: "about:blank" };
    },
    async query() {
      return [];
    },
    async update() {
      updateCalls += 1;
      return {};
    },
  },
  webNavigation: {
    onDOMContentLoaded: { addListener() {}, removeListener() {} },
  },
  debugger: {
    onEvent: noopEvent,
    onDetach: noopEvent,
    async attach() {},
    async detach() {},
    async sendCommand() {
      return {};
    },
  },
};

const { handleChain } = await import("./chain.js");
const { handleNavigate } = await import("./navigation.js");

test("navigation abort removes its load listener and reports the dispatched mutation as unknown", async () => {
  updateCalls = 0;
  getCalls = 0;
  postUpdateGetCalls = 0;
  updateListeners.clear();

  const response = await handleChain(
    {
      id: "navigation-timeout",
      ownerId: "owner-a",
      timeout: 15,
      waitForSelector: false,
      steps: [{ action: "navigate", url: "https://example.com/slow" }],
    },
    { navigate: handleNavigate },
  );

  assert.equal(response.success, false);
  assert.equal(response.outcomeUnknown, true);
  assert.equal(response.data.results[0].outcomeUnknown, true);
  assert.equal(updateCalls, 1);
  assert.ok(getCalls >= 1);
  assert.equal(
    postUpdateGetCalls,
    0,
    "abort must stop the post-navigation tab read",
  );
  assert.equal(
    updateListeners.size,
    0,
    "abort must remove the pending load listener",
  );
});

test("an already-aborted navigation signal prevents mutation dispatch", async () => {
  updateCalls = 0;
  const controller = new AbortController();
  controller.abort(new Error("test abort"));

  await assert.rejects(
    handleNavigate({
      id: "navigation-pre-abort",
      ownerId: "owner-a",
      url: "https://example.com/must-not-open",
      signal: controller.signal,
    }),
    /test abort/,
  );
  assert.equal(updateCalls, 0);
});
