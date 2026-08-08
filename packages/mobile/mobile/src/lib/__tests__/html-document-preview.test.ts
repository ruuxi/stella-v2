import { describe, expect, test } from "bun:test";

import {
  DOCUMENT_PAGE_BACKGROUND,
  prepareDocumentHtml,
} from "../html-document-preview";

const BASE_MARKER = 'data-stella-doc-base="true"';

describe("prepareDocumentHtml", () => {
  test("injects a white paper baseline into <head> before author styles", () => {
    const html =
      "<!doctype html><html><head><style>body { color: #111; }</style></head><body>Hi</body></html>";
    const out = prepareDocumentHtml(html);
    expect(out).toContain(BASE_MARKER);
    expect(out).toContain(`background-color: ${DOCUMENT_PAGE_BACKGROUND}`);
    expect(out).toContain("color-scheme: light");
    // Baseline precedes the author stylesheet so author rules win.
    expect(out.indexOf(BASE_MARKER)).toBeLessThan(
      out.indexOf("body { color: #111; }"),
    );
  });

  test("handles <head> with attributes, case-insensitively", () => {
    const html = '<HTML><HEAD lang="en"><title>t</title></HEAD><BODY></BODY></HTML>';
    const out = prepareDocumentHtml(html);
    const at = out.indexOf(BASE_MARKER);
    expect(at).toBeGreaterThan(out.indexOf('<HEAD lang="en">'));
    expect(at).toBeLessThan(out.indexOf("<title>"));
  });

  test("falls back to after <html> when there is no <head>", () => {
    const html = "<html><body><p>x</p></body></html>";
    const out = prepareDocumentHtml(html);
    expect(out.indexOf(BASE_MARKER)).toBeLessThan(out.indexOf("<body>"));
    expect(out.indexOf(BASE_MARKER)).toBeGreaterThan(out.indexOf("<html>"));
  });

  test("prepends for fragment HTML without <html> or <head>", () => {
    const html = "<p>hello</p>";
    const out = prepareDocumentHtml(html);
    expect(out.startsWith("<style")).toBe(true);
    expect(out.endsWith("<p>hello</p>")).toBe(true);
  });

  test("leaves author-declared dark backgrounds able to override (baseline comes first)", () => {
    const html =
      "<html><head><style>html { background: #0b0b0b; color: #eee; }</style></head><body></body></html>";
    const out = prepareDocumentHtml(html);
    // Author rule still present and later in the cascade than the baseline.
    expect(out.indexOf(BASE_MARKER)).toBeLessThan(
      out.indexOf("background: #0b0b0b"),
    );
  });

  test("is idempotent", () => {
    const once = prepareDocumentHtml("<html><head></head><body></body></html>");
    expect(prepareDocumentHtml(once)).toBe(once);
  });

  test("does not treat <header> as <head>", () => {
    const html = "<html><body><header>h</header></body></html>";
    const out = prepareDocumentHtml(html);
    // Injected after <html>, not inside <header>.
    expect(out.indexOf(BASE_MARKER)).toBeLessThan(out.indexOf("<body>"));
  });
});
