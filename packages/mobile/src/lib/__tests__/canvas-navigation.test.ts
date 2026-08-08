import { describe, expect, test } from "bun:test";
import { classifyCanvasNavigation } from "../canvas-navigation";

describe("canvas navigation policy", () => {
  test("keeps fragments inside the document", () => {
    expect(classifyCanvasNavigation("#details")).toEqual({
      kind: "anchor",
      fragment: "details",
    });
  });

  for (const href of ["https://example.com/path", "http://example.com/"]) {
    test(`opens absolute web URL externally: ${href}`, () =>
      expect(classifyCanvasNavigation(href)).toMatchObject({
        kind: "external",
      }));
  }

  for (const href of [
    "next.html",
    "/docs/page",
    "mailto:user@example.com",
    "javascript:void(0)",
  ]) {
    test(`blocks unsupported canvas navigation: ${href}`, () => {
      expect(classifyCanvasNavigation(href)).toEqual({ kind: "blocked" });
    });
  }
});
