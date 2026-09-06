import assert from "node:assert/strict";
import test from "node:test";

const noopEvent = { addListener() {} };
const tab = { id: 17, windowId: 1, groupId: -1, url: "https://example.com" };
let evaluationOutcome = {
  ok: true,
  reason: null,
  tag: "input",
  inputType: "text",
  actualLength: 6,
};
let evaluatedExpression = "";
let debuggerCalls = [];
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
    async sendCommand(target, method, params) {
      debuggerCalls.push({ target, method, params });
      if (method === "Runtime.evaluate") {
        evaluatedExpression = params.expression;
        return {
          result: {
            value: params.expression.includes("const ancestorFrames = []")
              ? { x: 128, y: 90 }
              : evaluationOutcome,
          },
        };
      }
      return {};
    },
  },
};

const { handleClick, handleDblclick, handleFill, handleWait } =
  await import("./interaction.js");
const { handleChain } = await import("./chain.js");
const { detachAllDebuggers } = await import("../lib/debugger.js");

test("fill replaces through native setters, emits input lifecycle events, and verifies", async () => {
  debuggerCalls = [];
  evaluationOutcome = {
    ok: true,
    reason: null,
    tag: "input",
    inputType: "text",
    actualLength: 6,
  };
  const response = await handleFill({
    id: "fill-a",
    ownerId: "owner-a",
    selector: "#version",
    value: "1.0.27",
  });

  assert.equal(response.success, true);
  assert.match(evaluatedExpression, /HTMLInputElement\.prototype/);
  assert.match(evaluatedExpression, /HTMLTextAreaElement\.prototype/);
  assert.match(evaluatedExpression, /insertReplacementText/);
  assert.match(evaluatedExpression, /beforeinput/);
  assert.match(evaluatedExpression, /new Event\('change'/);
  assert.match(evaluatedExpression, /actual === nextValue/);
  await detachAllDebuggers();
});

test("fill mismatch reports lengths without exposing the observed value", async () => {
  debuggerCalls = [];
  evaluationOutcome = {
    ok: false,
    reason: "value-mismatch",
    tag: "input",
    inputType: "password",
    actualLength: 17,
  };

  await assert.rejects(
    handleFill({
      id: "fill-secret",
      ownerId: "owner-a",
      selector: "#password",
      value: "replacement",
    }),
    (error) => {
      assert.match(error.message, /input_type=password/);
      assert.match(error.message, /expected_chars=11/);
      assert.match(error.message, /actual_chars=17/);
      assert.doesNotMatch(error.message, /existing-secret/);
      return true;
    },
  );
  await detachAllDebuggers();
});

test("click and wait resolve CSS through open shadow roots and same-origin frames", async () => {
  debuggerCalls = [];
  evaluationOutcome = true;
  const clickResponse = await handleClick({
    id: "click-composed",
    ownerId: "owner-a",
    selector: ".target",
  });
  assert.equal(clickResponse.success, true);
  assert.match(evaluatedExpression, /shadowRoot/);
  assert.match(evaluatedExpression, /contentDocument\.documentElement/);
  assert.match(evaluatedExpression, /el\.click\(\)/);

  const waitResponse = await handleWait({
    id: "wait-composed",
    ownerId: "owner-a",
    selector: ".target",
    timeout: 20,
  });
  assert.equal(waitResponse.data.found, true);
  assert.match(evaluatedExpression, /shadowRoot/);
  assert.match(evaluatedExpression, /contentDocument\.documentElement/);
  await detachAllDebuggers();
});

test("dblclick dispatches accumulated top-frame coordinates for nested iframe targets", async () => {
  debuggerCalls = [];
  evaluationOutcome = { x: 128, y: 90 };
  const response = await handleDblclick({
    id: "dblclick-frame",
    ownerId: "owner-a",
    selector: ".target",
  });

  assert.equal(response.success, true);
  const pointExpression = debuggerCalls.find(
    (call) =>
      call.method === "Runtime.evaluate" &&
      call.params.expression.includes("const ancestorFrames = []"),
  )?.params.expression;
  assert.match(pointExpression, /ancestorFrames\.reverse/);
  assert.match(
    pointExpression,
    /frameRect\.left \+ \(frameElement\.clientLeft \|\| 0\)/,
  );
  const mouseCalls = debuggerCalls.filter(
    (call) => call.method === "Input.dispatchMouseEvent",
  );
  assert.deepEqual(
    mouseCalls.map((call) => ({
      type: call.params.type,
      x: call.params.x,
      y: call.params.y,
      clickCount: call.params.clickCount,
    })),
    [
      { type: "mouseMoved", x: 128, y: 90, clickCount: undefined },
      { type: "mousePressed", x: 128, y: 90, clickCount: 1 },
      { type: "mouseReleased", x: 128, y: 90, clickCount: 1 },
      { type: "mousePressed", x: 128, y: 90, clickCount: 2 },
      { type: "mouseReleased", x: 128, y: 90, clickCount: 2 },
    ],
  );
  await detachAllDebuggers();
});

test("a timed-out production click reports unknown outcome when its CDP mutation finishes later", async () => {
  const originalSendCommand = chrome.debugger.sendCommand;
  let mutationCount = 0;
  let laterStepCalls = 0;
  chrome.debugger.sendCommand = async (target, method, params) => {
    if (
      method === "Runtime.evaluate" &&
      params.expression.includes("el.click()")
    ) {
      return await new Promise((resolve) => {
        setTimeout(() => {
          mutationCount += 1;
          resolve({ result: { value: true } });
        }, 40);
      });
    }
    return await originalSendCommand(target, method, params);
  };

  try {
    const response = await handleChain(
      {
        id: "production-click-timeout",
        ownerId: "owner-a",
        timeout: 15,
        abortOnError: false,
        waitForSelector: false,
        steps: [
          { action: "click", selector: "#slow-mutation" },
          { action: "fill", selector: "#must-not-run", value: "late" },
        ],
      },
      {
        click: handleClick,
        fill: async () => {
          laterStepCalls += 1;
          return { success: true, data: {} };
        },
      },
    );

    assert.equal(response.success, false);
    assert.equal(response.outcomeUnknown, true);
    assert.match(
      response.outcomeUnknownReason,
      /did not confirm cancellation or completion/,
    );
    assert.equal(response.data.results[0].outcomeUnknown, true);
    assert.equal(laterStepCalls, 0);
    assert.equal(
      mutationCount,
      0,
      "the CDP mutation must still be in flight at receipt time",
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
      mutationCount,
      1,
      "the ignored CDP abort proves why the receipt is unknown",
    );
  } finally {
    chrome.debugger.sendCommand = originalSendCommand;
    await detachAllDebuggers();
  }
});
