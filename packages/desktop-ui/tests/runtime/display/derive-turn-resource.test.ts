import { describe, expect, it } from "vitest";
import {
  buildPayloadFromBarePath,
  collectTurnSourceDiffPayloads,
  deriveTurnInlineImagePayloads,
  deriveTurnResource,
  extractMarkdownLinkPaths,
} from "../../../src/features/chat/lib/derive-turn-resource";
import type { EventRecord } from "../../../src/features/chat/lib/event-transforms";

const event = (
  type: EventRecord["type"],
  payload: EventRecord["payload"],
  timestamp = 1,
): EventRecord => ({ _id: `${type}-${timestamp}`, type, timestamp, payload });

describe("deriveTurnResource", () => {
  it("returns null when a response does not link a local file", () => {
    expect(deriveTurnResource([], "Saved /tmp/report.pdf")).toBeNull();
  });

  it("derives the primary preview from an absolute Markdown link", () => {
    expect(
      deriveTurnResource([], "Created [report](/out/report.pdf)"),
    ).toEqual({ kind: "pdf", filePath: "/out/report.pdf" });
  });

  it("supports angle brackets for paths containing spaces", () => {
    expect(
      deriveTurnResource([], "Created [notes](</out/My Notes.md>)"),
    ).toMatchObject({ kind: "markdown", filePath: "/out/My Notes.md" });
  });

  it("ignores tool file metadata, including large intermediate sets", () => {
    const result = deriveTurnResource([
      event("tool_result", {
        toolName: "exec_command",
        fileChanges: [{ path: "/out/report.pdf", kind: { type: "add" } }],
        producedFiles: Array.from({ length: 1_000 }, (_, index) => ({
          path: `/tmp/frame-${index}.png`,
          kind: { type: "add" },
        })),
      }),
    ]);
    expect(result).toBeNull();
  });

  it("keeps the dedicated orchestrator html artifact path", () => {
    const result = deriveTurnResource([
      event("tool_result", {
        toolName: "html",
        agentType: "orchestrator",
        result: {
          filePath: "/out/page.html",
          title: "Page",
          slug: "page",
        },
      }),
    ]);
    expect(result).toMatchObject({
      kind: "canvas-html",
      filePath: "/out/page.html",
      title: "Page",
    });
  });

  it("keeps dedicated image_gen output without requiring a response link", () => {
    const result = deriveTurnResource([
      event("tool_result", {
        toolName: "image_gen",
        result: {
          jobId: "job-1",
          prompt: "two options",
          filePaths: ["/out/a.png", "/out/b.png"],
        },
      }),
    ]);
    expect(result).toMatchObject({
      kind: "media",
      jobId: "job-1",
      asset: { kind: "image", filePaths: ["/out/a.png", "/out/b.png"] },
    });
  });

  it("keeps explicit office preview sessions", () => {
    const result = deriveTurnResource([
      event("tool_result", {
        toolName: "stella_office",
        officePreviewRef: {
          sessionId: "office-1",
          title: "Report",
          sourcePath: "/out/report.docx",
        },
      }),
    ]);
    expect(result).toMatchObject({
      kind: "office",
      previewRef: { sourcePath: "/out/report.docx" },
    });
  });
});

describe("developer response links", () => {
  it("requires developer previews and emits only linked developer files", () => {
    const assistantText =
      "[app](/repo/app.ts) [report](/repo/report.pdf) [again](/repo/app.ts)";
    expect(
      collectTurnSourceDiffPayloads([], { assistantText }),
    ).toEqual([]);
    expect(
      collectTurnSourceDiffPayloads([], {
        assistantText,
        developerResourcesEnabled: true,
      }).map((payload) => payload.kind === "source-diff" && payload.filePath),
    ).toEqual(["/repo/app.ts"]);
  });

  it("uses linked developer files as the turn preview when enabled", () => {
    expect(
      deriveTurnResource([], "[source](/repo/app.ts)", undefined, {
        developerResourcesEnabled: true,
      }),
    ).toMatchObject({ kind: "source-diff", filePath: "/repo/app.ts" });
  });
});

describe("local Markdown link extraction", () => {
  it("extracts Unix and Windows absolute paths and decodes URL escapes", () => {
    expect(
      extractMarkdownLinkPaths(
        "[one](/out/a.pdf) [two](C:/Users/sam/b.pdf) [three](/out/My%20File.pdf)",
      ),
    ).toEqual([
      "/out/a.pdf",
      "C:/Users/sam/b.pdf",
      "/out/My File.pdf",
    ]);
  });

  it("supports angle-bracket destinations with spaces", () => {
    expect(extractMarkdownLinkPaths("[report](</out/My Report.pdf>)")).toEqual([
      "/out/My Report.pdf",
    ]);
  });

  it("rejects relative, remote, mail, and protocol-relative destinations", () => {
    expect(
      extractMarkdownLinkPaths(
        "[rel](./a.pdf) [web](https://example.com/a) [mail](mailto:a@b.com) [network](//example.com/a)",
      ),
    ).toEqual([]);
  });

  it("ignores link examples inside inline and fenced code", () => {
    expect(
      extractMarkdownLinkPaths(
        "`[inline](/tmp/a.pdf)`\n```md\n[fenced](/tmp/b.pdf)\n```\n[real](/tmp/c.pdf)",
      ),
    ).toEqual(["/tmp/c.pdf"]);
  });
});

describe("buildPayloadFromBarePath", () => {
  it("maps linked Office files directly to file artifacts", () => {
    expect(buildPayloadFromBarePath("/out/report.docx", 4)).toMatchObject({
      kind: "file-artifact",
      artifactKind: "office-document",
      filePath: "/out/report.docx",
    });
  });

  it("only maps developer files when enabled", () => {
    expect(buildPayloadFromBarePath("/repo/app.ts", 4)).toBeNull();
    expect(
      buildPayloadFromBarePath("/repo/app.ts", 4, {
        developerResourcesEnabled: true,
      }),
    ).toMatchObject({ kind: "source-diff", filePath: "/repo/app.ts" });
  });
});

describe("deriveTurnInlineImagePayloads", () => {
  it("keeps orchestrator image jobs as inline image payloads", () => {
    const payloads = deriveTurnInlineImagePayloads([
      event("tool_result", {
        toolName: "image_gen",
        agentType: "orchestrator",
        details: {
          jobId: "job-1",
          prompt: "a mockup",
          numImages: 2,
          status: "submitted",
        },
      }),
    ]);
    expect(payloads).toEqual([
      {
        kind: "media",
        asset: { kind: "image", filePaths: [] },
        jobId: "job-1",
        prompt: "a mockup",
        numImages: 2,
        presentation: "inline-image",
        createdAt: 1,
      },
    ]);
  });
});
