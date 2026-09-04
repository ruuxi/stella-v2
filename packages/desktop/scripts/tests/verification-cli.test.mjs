import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { DOM_TOOLS_JS, compareObservations } from '../../../../.agents/skills/verify-stella/cli/dom.mjs';

function fixture(html) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  // jsdom has no layout engine. Provide visible geometry; CSS visibility remains real.
  dom.window.Element.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, width: 100, height: 30, left: 0, top: 0, right: 100, bottom: 30 };
  };
  return { dom, tools: dom.window.eval(DOM_TOOLS_JS) };
}
const plain = (value) => JSON.parse(JSON.stringify(value));

test('ambiguous targets list candidates; scoped selectors choose the intended control', () => {
  const { dom, tools } = fixture('<section id="left"><button id="a">Save</button></section><section id="right"><button id="b">Save</button></section>');
  try {
    for (const query of [{ role: 'button', name: 'Save' }, { selector: 'button' }]) {
      assert.throws(() => tools.find(query), (error) => {
        const details = JSON.parse(error.message.split('STELLA_TARGET:')[1]);
        assert.equal(details.code, 'AMBIGUOUS_TARGET');
        assert.deepEqual(details.candidates.map((item) => item.id), ['a', 'b']);
        return true;
      });
    }
    assert.equal(tools.find({ role: 'button', name: 'Save', within: '#right' }).id, 'b');
    assert.equal(tools.find({ selector: 'button', unique: false }).id, 'a');
  } finally { dom.window.close(); }
});

test('inspection and targeting agree on labels and exclude hidden ancestors', () => {
  const { dom, tools } = fixture('<span id="label">Audio</span><button id="audio" aria-labelledby="label">icon</button><label for="query">Search</label><input id="query" type="search"><div style="opacity:0"><button>Audio</button></div><div inert><button>Audio</button></div>');
  try {
    assert.equal(tools.find({ role: 'button', name: 'Audio' }).id, 'audio');
    assert.equal(tools.find({ role: 'searchbox', name: 'Search' }).id, 'query');
    assert.equal(tools.components().filter((item) => item.role === 'button').length, 1);
    assert.throws(() => tools.find({ name: 'Missing' }), /TARGET_NOT_FOUND/);
  } finally { dom.window.close(); }
});

test('chat evidence ignores page keywords, old matching messages, and other conversations', () => {
  const { dom, tools } = fixture(`<p>retry provider could not start</p>
    <div data-testid="chat-surface" data-conversation-id="active">
      <div class="event-row--user" data-chat-row-id="old"><div class="event-item user">hello</div></div>
      <textarea class="composer-input">hello</textarea>
    </div>
    <div data-testid="chat-surface" data-conversation-id="other"><div role="alert">Other failure</div></div>`);
  try {
    const before = tools.chat('hello', 'active');
    assert.deepEqual(plain(before.notices), []);
    assert.equal(before.composerCleared, false);
    const surface = dom.window.document.querySelector('[data-conversation-id="active"]');
    surface.insertAdjacentHTML('beforeend', '<div class="event-row--user" data-chat-row-id="new"><div class="event-item user">hello</div></div>');
    const after = tools.chat('hello', 'active');
    assert.deepEqual(plain(after.matchingMessageIds.filter((id) => !before.mountedMatchingMessageIds.includes(id))), ['new']);
    surface.insertAdjacentHTML('beforeend', '<div data-testid="composer-notice" role="status">Please connect a model</div>');
    assert.equal(tools.chat('hello', 'active').notices[0].text, 'Please connect a model');
    assert.equal(tools.chat('hello', 'missing').surfaceFound, false);
  } finally { dom.window.close(); }
});

test('observation changes preserve duplicate controls and report changed semantic fields', () => {
  const save = { role: 'button', name: 'Save' };
  const changes = compareObservations(
    { state: { settingsOpen: false }, components: [save, save] },
    { state: { settingsOpen: true }, components: [save, { role: 'button', name: 'Cancel' }] },
  );
  assert.deepEqual(changes.state, { settingsOpen: { before: false, after: true } });
  assert.deepEqual(changes.removedControls, [save]);
  assert.deepEqual(changes.addedControls, [{ role: 'button', name: 'Cancel' }]);
});
