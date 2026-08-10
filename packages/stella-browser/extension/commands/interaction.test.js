import assert from 'node:assert/strict';
import test from 'node:test';

const noopEvent = { addListener() {} };
const tab = { id: 17, windowId: 1, groupId: -1, url: 'https://example.com' };
let evaluationOutcome = {
  ok: true,
  reason: null,
  tag: 'input',
  inputType: 'text',
  actualLength: 6,
};
let evaluatedExpression = '';
let storage = {
  agentWindowId: 1,
  stellaGroupId: null,
  ownerTabState: {
    'owner-a': {
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
        return Object.fromEntries(keys.map(key => [key, storage[key]]));
      },
      async set(value) {
        storage = { ...storage, ...value };
      },
    },
  },
  windows: {
    onRemoved: noopEvent,
    async get() {
      return { id: 1, type: 'normal' };
    },
    async getLastFocused() {
      return { id: 1, type: 'normal' };
    },
    async getAll() {
      return [{ id: 1, type: 'normal' }];
    },
  },
  tabGroups: {
    async query() {
      return [];
    },
    async get() {
      throw new Error('group not found');
    },
  },
  tabs: {
    onCreated: noopEvent,
    onRemoved: noopEvent,
    async get(tabId) {
      if (tabId !== tab.id) throw new Error('tab not found');
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
      assert.equal(method, 'Runtime.evaluate');
      evaluatedExpression = params.expression;
      return { result: { value: evaluationOutcome } };
    },
  },
};

const { handleFill } = await import('./interaction.js');
const { detachAllDebuggers } = await import('../lib/debugger.js');

test('fill replaces through native setters, emits input lifecycle events, and verifies', async () => {
  evaluationOutcome = {
    ok: true,
    reason: null,
    tag: 'input',
    inputType: 'text',
    actualLength: 6,
  };
  const response = await handleFill({
    id: 'fill-a',
    ownerId: 'owner-a',
    selector: '#version',
    value: '1.0.27',
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

test('fill mismatch reports lengths without exposing the observed value', async () => {
  evaluationOutcome = {
    ok: false,
    reason: 'value-mismatch',
    tag: 'input',
    inputType: 'password',
    actualLength: 17,
  };

  await assert.rejects(
    handleFill({
      id: 'fill-secret',
      ownerId: 'owner-a',
      selector: '#password',
      value: 'replacement',
    }),
    error => {
      assert.match(error.message, /input_type=password/);
      assert.match(error.message, /expected_chars=11/);
      assert.match(error.message, /actual_chars=17/);
      assert.doesNotMatch(error.message, /existing-secret/);
      return true;
    },
  );
  await detachAllDebuggers();
});
