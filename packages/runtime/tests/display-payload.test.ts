import { describe, expect, it } from "vitest";
import {
  normalizeDisplayPayload,
  type DisplayPayload,
} from "@stella/contracts/desktop/display-payload";

describe("normalizeDisplayPayload", () => {
  it("rejects string payloads", () => {
    expect(normalizeDisplayPayload("<p>hi</p>")).toBeNull();
    expect(normalizeDisplayPayload("")).toBeNull();
    expect(normalizeDisplayPayload("   \n\t")).toBeNull();
  });

  it("passes through canvas-html payloads", () => {
    const payload: DisplayPayload = {
      kind: "canvas-html",
      filePath: "/.stella/outputs/html/plan.html",
      title: "Onboarding plan",
      slug: "plan",
      createdAt: 1,
    };
    expect(normalizeDisplayPayload(payload)).toBe(payload);
  });

  it("passes through valid office payloads", () => {
    const payload: DisplayPayload = {
      kind: "office",
      previewRef: {
        sessionId: "session-1",
        title: "deck.pptx",
        sourcePath: "/tmp/deck.pptx",
      },
    };
    expect(normalizeDisplayPayload(payload)).toBe(payload);
  });

  it("passes through valid pdf payloads", () => {
    const payload: DisplayPayload = {
      kind: "pdf",
      filePath: "/tmp/invoice.pdf",
    };
    expect(normalizeDisplayPayload(payload)).toBe(payload);
  });

  it("passes through valid file artifact payloads", () => {
    const payload: DisplayPayload = {
      kind: "file-artifact",
      filePath: "/tmp/report.docx",
      artifactKind: "office-document",
      title: "report.docx",
      createdAt: 1,
    };
    expect(normalizeDisplayPayload(payload)).toBe(payload);
  });

  it("passes through markdown and source diff payloads", () => {
    const markdown: DisplayPayload = {
      kind: "markdown",
      filePath: "/tmp/notes.md",
      title: "notes.md",
    };
    const sourceDiff: DisplayPayload = {
      kind: "source-diff",
      filePath: "/tmp/app.ts",
      patch: "*** Begin Patch\n*** End Patch",
      createdAt: 1,
    };
    expect(normalizeDisplayPayload(markdown)).toBe(markdown);
    expect(normalizeDisplayPayload(sourceDiff)).toBe(sourceDiff);
  });

  it("passes through http and https URL payloads", () => {
    const local: DisplayPayload = {
      kind: "url",
      url: "http://localhost:5173/social/session-1",
      title: "Social",
      tabId: "social:session-1",
    };
    const secure: DisplayPayload = {
      kind: "url",
      url: "https://example.com/preview",
      title: "Preview",
      tabId: "preview",
    };

    expect(normalizeDisplayPayload(local)).toBe(local);
    expect(normalizeDisplayPayload(secure)).toBe(secure);
  });

  it("rejects URL payloads with non-web protocols", () => {
    const base = {
      kind: "url",
      title: "Preview",
      tabId: "preview",
    };

    expect(
      normalizeDisplayPayload({ ...base, url: "file:///Users/me/.ssh/id_rsa" }),
    ).toBeNull();
    expect(
      normalizeDisplayPayload({ ...base, url: "javascript:alert(1)" }),
    ).toBeNull();
    expect(normalizeDisplayPayload({ ...base, url: "/relative" })).toBeNull();
  });


  it("passes through valid media payloads", () => {
    const image: DisplayPayload = {
      kind: "media",
      asset: {
        kind: "image",
        filePaths: ["/.stella/media/outputs/job_0.png"],
      },
      jobId: "job-1",
      capability: "text_to_image",
      prompt: "a cat",
      createdAt: 123,
    };
    expect(normalizeDisplayPayload(image)).toBe(image);

    const video: DisplayPayload = {
      kind: "media",
      asset: { kind: "video", filePath: "/.stella/media/outputs/job_0.mp4" },
      jobId: "job-2",
      createdAt: 456,
    };
    expect(normalizeDisplayPayload(video)).toBe(video);
  });

  it("rejects malformed payloads", () => {
    expect(normalizeDisplayPayload(null)).toBeNull();
    expect(normalizeDisplayPayload(undefined)).toBeNull();
    expect(normalizeDisplayPayload(42)).toBeNull();
    expect(normalizeDisplayPayload({ kind: "canvas-html" })).toBeNull();
    expect(
      normalizeDisplayPayload({
        kind: "canvas-html",
        filePath: "/x.html",
      }),
    ).toBeNull();
    expect(
      normalizeDisplayPayload({ kind: "office", previewRef: {} }),
    ).toBeNull();
    expect(
      normalizeDisplayPayload({
        kind: "file-artifact",
        filePath: "/tmp/a.docx",
      }),
    ).toBeNull();
    expect(normalizeDisplayPayload({ kind: "pdf" })).toBeNull();
    expect(
      normalizeDisplayPayload({
        kind: "media",
        asset: { kind: "image" }, // missing filePaths
        createdAt: 1,
      }),
    ).toBeNull();
    expect(
      normalizeDisplayPayload({
        kind: "media",
        asset: { kind: "image", filePaths: [] }, // ok shape, but no createdAt
      }),
    ).toBeNull();
    expect(normalizeDisplayPayload({ kind: "unknown" })).toBeNull();
  });

});
