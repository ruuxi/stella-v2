import assert from "node:assert/strict";
import test from "node:test";

const noopEvent = { addListener() {} };
const tab = { id: 23, windowId: 1, groupId: -1, url: "https://example.com" };
let runtimeValue = null;
let runtimeExpression = "";
let screenshotParams = null;
let storage = {
  agentWindowId: 1,
  stellaGroupId: null,
  ownerTabState: {
    "owner-a": {
      tabIds: [23],
      activeTabId: 23,
      lastTouchedAtByTabId: { 23: Date.now() },
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
    async get(tabId) {
      if (tabId !== tab.id) throw new Error("tab not found");
      return { ...tab };
    },
    async query() {
      return [{ ...tab }];
    },
  },
  debugger: {
    onEvent: noopEvent,
    onDetach: noopEvent,
    async attach() {},
    async detach() {},
    async sendCommand(_target, method, params) {
      if (method === "Runtime.evaluate") {
        runtimeExpression = params.expression;
        return { result: { value: runtimeValue } };
      }
      if (method === "Page.captureScreenshot") {
        screenshotParams = params;
        return { data: "image-data" };
      }
      throw new Error(`Unexpected debugger method: ${method}`);
    },
  },
};

const { handleGetText, handleScreenshot } = await import("./capture.js");
const { detachAllDebuggers } = await import("../lib/debugger.js");

test("selector text capture uses composed-root CSS matching", async () => {
  runtimeValue = "nested text";
  const response = await handleGetText({
    id: "text-composed",
    ownerId: "owner-a",
    selector: ".target",
  });

  assert.equal(response.data.text, "nested text");
  assert.match(runtimeExpression, /shadowRoot/);
  assert.match(runtimeExpression, /contentDocument\.documentElement/);
  await detachAllDebuggers();
});

test("selector screenshot crops with top-frame coordinates accumulated across frames", async () => {
  runtimeValue = { x: 128, y: 90, width: 40, height: 18, scale: 1 };
  screenshotParams = null;
  const response = await handleScreenshot({
    id: "shot-composed",
    ownerId: "owner-a",
    selector: ".target",
    format: "png",
  });

  assert.equal(response.data.base64, "image-data");
  assert.deepEqual(screenshotParams.clip, runtimeValue);
  assert.equal(screenshotParams.captureBeyondViewport, true);
  assert.match(runtimeExpression, /ancestorFrames\.reverse/);
  assert.match(
    runtimeExpression,
    /frameRect\.left \+ \(frameElement\.clientLeft \|\| 0\)/,
  );
  assert.match(runtimeExpression, /topWindow\.scrollX/);
  await detachAllDebuggers();
});
