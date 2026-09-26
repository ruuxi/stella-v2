import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";

import {
  buildComposedCssMatcherAllScript,
  buildComposedCssMatcherScript,
  buildRoleMatcherAllScript,
  buildRoleMatcherScript,
  buildTopLevelRectSource,
  clearOwnerRefMaps,
  encodeSemanticSelector,
  parseSemanticSelector,
  resolveSelector,
  setRefMap,
} from "./selector.js";

test("CSS matching follows composed order through open shadow roots and nested same-origin frames", () => {
  const dom = new JSDOM(
    `
    <main>
      <button class="target">top</button>
      <div id="shadow-host"></div>
      <iframe id="outer-frame"></iframe>
    </main>
  `,
    { runScripts: "outside-only", url: "https://example.com/" },
  );

  const shadow = dom.window.document
    .getElementById("shadow-host")
    .attachShadow({ mode: "open" });
  shadow.innerHTML = '<button class="target">shadow</button>';
  const outerFrame = dom.window.document.getElementById("outer-frame");
  outerFrame.contentDocument.body.innerHTML = `
    <button class="target">outer frame</button>
    <iframe id="inner-frame"></iframe>
  `;
  const innerFrame = outerFrame.contentDocument.getElementById("inner-frame");
  innerFrame.contentDocument.body.innerHTML =
    '<button class="target">inner frame</button>';

  const matches = dom.window.eval(buildComposedCssMatcherAllScript(".target"));
  assert.deepEqual(
    Array.from(matches, (el) => el.textContent),
    ["top", "shadow", "outer frame", "inner frame"],
  );
  assert.equal(
    dom.window.eval(buildComposedCssMatcherScript(".target")),
    matches[0],
  );
  assert.throws(
    () => dom.window.eval(buildComposedCssMatcherAllScript("[")),
    /not a valid selector|invalid selector/i,
  );
});

test("top-level geometry accumulates every ancestor frame offset and client border", () => {
  const dom = new JSDOM('<iframe id="outer"></iframe>', {
    runScripts: "outside-only",
    url: "https://example.com/",
  });
  const outer = dom.window.document.getElementById("outer");
  outer.contentDocument.body.innerHTML = '<iframe id="inner"></iframe>';
  const inner = outer.contentDocument.getElementById("inner");
  inner.contentDocument.body.innerHTML = '<button id="target">target</button>';
  const target = inner.contentDocument.getElementById("target");

  outer.getBoundingClientRect = () => ({
    left: 100,
    top: 50,
    width: 300,
    height: 200,
  });
  inner.getBoundingClientRect = () => ({
    left: 20,
    top: 30,
    width: 200,
    height: 100,
  });
  target.getBoundingClientRect = () => ({
    left: 5,
    top: 6,
    width: 40,
    height: 18,
  });
  Object.defineProperties(outer, {
    clientLeft: { configurable: true, value: 2 },
    clientTop: { configurable: true, value: 3 },
  });
  Object.defineProperties(inner, {
    clientLeft: { configurable: true, value: 1 },
    clientTop: { configurable: true, value: 1 },
  });

  const geometry = dom.window.eval(`(() => {
    const el = document.querySelector('#outer').contentDocument
      .querySelector('#inner').contentDocument.querySelector('#target');
    ${buildTopLevelRectSource("el")}
    return { x: topX, y: topY, width: localRect.width, height: localRect.height };
  })()`);

  assert.equal(geometry.x, 128);
  assert.equal(geometry.y, 90);
  assert.equal(geometry.width, 40);
  assert.equal(geometry.height, 18);
});

test("role matching ignores aria-hidden portal dialogs and keeps the visible dialog", () => {
  const dom = new JSDOM(
    `
    <main>
      <section aria-hidden="true"><div role="dialog" aria-label="Publish">stale</div></section>
      <div role="dialog" aria-label="Publish">current</div>
    </main>
  `,
    { runScripts: "outside-only" },
  );
  dom.window.Element.prototype.getClientRects = function getClientRects() {
    return [{ x: 0, y: 0, width: 100, height: 20 }];
  };

  const script = buildRoleMatcherAllScript("dialog", "Publish");
  const matches = dom.window.eval(script);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].textContent, "current");
});

test("semantic matching follows snapshot order through open shadow roots and same-origin frames", () => {
  const dom = new JSDOM(
    `
    <main>
      <div role="button">Save</div>
      <button>Save</button>
      <div id="shadow-host"></div>
      <iframe></iframe>
    </main>
  `,
    { runScripts: "outside-only", url: "https://example.com/" },
  );
  const visibleRect = function visibleRect() {
    return [{ x: 0, y: 0, width: 100, height: 20 }];
  };
  dom.window.Element.prototype.getClientRects = visibleRect;

  const host = dom.window.document.getElementById("shadow-host");
  const shadowButton = dom.window.document.createElement("button");
  shadowButton.textContent = "Save";
  host.attachShadow({ mode: "open" }).append(shadowButton);

  const frame = dom.window.document.querySelector("iframe");
  frame.contentDocument.body.innerHTML = "<button>Save</button>";
  frame.contentWindow.Element.prototype.getClientRects = visibleRect;

  const matches = dom.window.eval(buildRoleMatcherAllScript("button", "Save"));
  assert.equal(matches.length, 4);
  assert.equal(
    matches[0],
    dom.window.document.querySelector('[role="button"]'),
  );
  assert.equal(matches[1], dom.window.document.querySelector("button"));
  assert.equal(matches[2], shadowButton);
  assert.equal(matches[3], frame.contentDocument.querySelector("button"));
  assert.equal(
    dom.window.eval(buildRoleMatcherScript("button", "Save", 2)),
    shadowButton,
  );
  assert.equal(
    dom.window.eval(buildRoleMatcherScript("button", "Save", 3)),
    frame.contentDocument.querySelector("button"),
  );
});

test("semantic label, placeholder, and testid matching traverse composed roots", () => {
  const dom = new JSDOM(
    `
    <div id="shadow-host"></div>
    <iframe></iframe>
  `,
    { runScripts: "outside-only", url: "https://example.com/" },
  );
  const visibleRect = function visibleRect() {
    return [{ x: 0, y: 0, width: 100, height: 20 }];
  };
  dom.window.Element.prototype.getClientRects = visibleRect;

  const shadow = dom.window.document
    .getElementById("shadow-host")
    .attachShadow({ mode: "open" });
  shadow.innerHTML =
    '<label for="email">Email address</label><input id="email" placeholder="name@example.com">';
  const frame = dom.window.document.querySelector("iframe");
  frame.contentDocument.body.innerHTML =
    '<button data-testid="submit-button">Submit</button>';
  frame.contentWindow.Element.prototype.getClientRects = visibleRect;

  const labelMatches = dom.window.eval(
    buildRoleMatcherAllScript({
      kind: "label",
      value: "Email address",
      exact: true,
    }),
  );
  const placeholderMatches = dom.window.eval(
    buildRoleMatcherAllScript({
      kind: "placeholder",
      value: "name@example.com",
      exact: true,
    }),
  );
  const testIdMatches = dom.window.eval(
    buildRoleMatcherAllScript({
      kind: "testid",
      value: "submit-button",
      exact: true,
    }),
  );

  assert.equal(labelMatches.length, 1);
  assert.equal(labelMatches[0], shadow.getElementById("email"));
  assert.equal(placeholderMatches.length, 1);
  assert.equal(placeholderMatches[0], shadow.getElementById("email"));
  assert.equal(testIdMatches.length, 1);
  assert.equal(testIdMatches[0], frame.contentDocument.querySelector("button"));
});

test("single role matching fails closed when multiple visible dialogs remain", () => {
  const dom = new JSDOM(
    `
    <div role="dialog" aria-label="Publish">one</div>
    <div role="dialog" aria-label="Publish">two</div>
  `,
    { runScripts: "outside-only" },
  );
  dom.window.Element.prototype.getClientRects = function getClientRects() {
    return [{ x: 0, y: 0, width: 100, height: 20 }];
  };

  assert.throws(
    () => dom.window.eval(buildRoleMatcherScript("dialog", "Publish")),
    /Strict mode violation.*matched 2 visible elements/,
  );
});

test("semantic selector parsing rejects malformed and unsafe payloads", () => {
  assert.throws(() => parseSemanticSelector("aria="), /payload is empty/);
  assert.throws(
    () => parseSemanticSelector("aria=%E0%A4%A"),
    /percent-encoding/,
  );
  assert.throws(() => parseSemanticSelector("aria=not-json"), /valid JSON/);
  assert.throws(
    () =>
      encodeSemanticSelector({ kind: "role", role: 'button"]', name: "Save" }),
    /invalid format/,
  );
  assert.throws(
    () => encodeSemanticSelector({ kind: "text", value: "x", nth: -1 }),
    /field 'nth'/,
  );
  assert.throws(
    () =>
      encodeSemanticSelector({ kind: "label", value: "Email", extra: true }),
    /Unknown semantic selector field/,
  );
  assert.throws(
    () =>
      encodeSemanticSelector({ kind: "placeholder", value: "", exact: true }),
    /non-empty string/,
  );
  assert.throws(
    () =>
      encodeSemanticSelector({ kind: "testid", value: "submit", exact: "yes" }),
    /must be a boolean/,
  );
});

test("normal CSS and owner/tab-scoped refs retain existing behavior", () => {
  clearOwnerRefMaps();
  assert.deepEqual(resolveSelector("#submit", "owner-a", 1), {
    css: "#submit",
    isRef: false,
  });

  setRefMap("owner-a", 1, {
    e1: { role: "button", name: "Owner A", nth: 0 },
  });
  setRefMap("owner-b", 1, {
    e1: { role: "button", name: "Owner B", nth: 0 },
  });

  assert.equal(resolveSelector("@e1", "owner-a", 1).name, "Owner A");
  assert.equal(resolveSelector("@e1", "owner-b", 1).name, "Owner B");
  assert.throws(() => resolveSelector("@e1", "owner-a", 2), /Unknown ref/);
  clearOwnerRefMaps();
});
