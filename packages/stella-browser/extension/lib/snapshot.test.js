import assert from "node:assert/strict";
import test from "node:test";

import { executeSnapshot } from "./snapshot.js";

globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
globalThis.CSS = { escape: (value) => String(value) };
globalThis.getComputedStyle = () => ({
  display: "block",
  visibility: "visible",
  position: "static",
  cursor: "default",
});

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.nodeType = Node.ELEMENT_NODE;
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.childNodes = [];
    this.parentElement = null;
    this.offsetParent = {};
    this.classList = [];
    this.textContent = "";
    this.shadowRoot = null;
    this.contentDocument = undefined;
    this.attributes = new Map();
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    this.childNodes.push(child);
    return child;
  }

  appendText(text) {
    this.childNodes.push({ nodeType: Node.TEXT_NODE, textContent: text });
    this.textContent += text;
    return this;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name) {
    return this.attributes.has(name);
  }
  querySelectorAll() {
    return [];
  }
  getBoundingClientRect() {
    return { width: 20, height: 20 };
  }
}

function makeDocument() {
  const doc = {
    body: null,
    getElementById() {
      return null;
    },
    querySelector() {
      return null;
    },
  };
  doc.body = new FakeElement("BODY", doc);
  doc.body.offsetParent = null;
  return doc;
}

test("semantic snapshots are bounded and report truncation metadata", () => {
  const doc = makeDocument();
  globalThis.document = doc;
  for (let index = 0; index < 250; index += 1) {
    doc.body.append(new FakeElement("BUTTON", doc));
  }

  const result = executeSnapshot({});

  assert.equal(result.truncated, true);
  assert.equal(result.stats.maxElements, 200);
  assert.equal(result.stats.maxChars, 20_000);
  assert.equal(result.stats.emittedElements, 200);
  assert.equal(Object.keys(result.refs).length, 200);
  assert.match(result.tree, /snapshot metadata: truncated=true/);
});

test("semantic snapshots traverse open shadow roots but not frame documents", () => {
  const doc = makeDocument();
  globalThis.document = doc;

  const host = doc.body.append(new FakeElement("DIV", doc));
  const shadowButton = new FakeElement("BUTTON", doc).appendText("Save");
  host.shadowRoot = { children: [shadowButton] };

  // Frames are captured per frame over CDP; the in-page walk stops here.
  const frame = doc.body.append(new FakeElement("IFRAME", doc));
  const frameDoc = makeDocument();
  frameDoc.body.append(new FakeElement("BUTTON", frameDoc).appendText("Save"));
  frame.contentDocument = frameDoc;

  const result = executeSnapshot({});

  assert.equal(result.truncated, false);
  assert.equal((result.tree.match(/- button/g) || []).length, 1);
  assert.equal(result.refs.e1.name, "Save");
  assert.equal(result.refs.e2, undefined);
});
