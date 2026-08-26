import { describe, expect, it, vi } from "vitest";

vi.mock("../../../src/shell/display/tab-content", () => ({
  UrlTabContent: () => null,
  MarkdownTabContent: () => null,
  SourceDiffTabContent: () => null,
  ImageTabContent: () => null,
  PdfTabContent: () => null,
  OfficeTabContent: () => null,
  OfficeFileTabContent: () => null,
  DelimitedTableTabContent: () => null,
  VideoTabContent: () => null,
  AudioTabContent: () => null,
  Model3dTabContent: () => null,
  DownloadTabContent: () => null,
  TextTabContent: () => null,
  TrashTabContent: () => null,
  MediaTabContent: () => null,
}));
vi.mock("../../../src/shell/display/tab-content.tsx", () => ({
  UrlTabContent: () => null,
  MarkdownTabContent: () => null,
  SourceDiffTabContent: () => null,
  ImageTabContent: () => null,
  PdfTabContent: () => null,
  OfficeTabContent: () => null,
  OfficeFileTabContent: () => null,
  DelimitedTableTabContent: () => null,
  VideoTabContent: () => null,
  AudioTabContent: () => null,
  Model3dTabContent: () => null,
  DownloadTabContent: () => null,
  TextTabContent: () => null,
  TrashTabContent: () => null,
  MediaTabContent: () => null,
}));

const { payloadToTabSpec } = await import(
  "../../../src/shell/display/payload-to-tab-spec"
);
describe("payloadToTabSpec", () => {
  it("keeps docx office previews as office-document tabs", () => {
    const payload: DisplayPayload = {
      kind: "office",
      previewRef: {
        sessionId: "s1",
        title: "report.docx",
        sourcePath: "/tmp/report.docx",
      },
    };
    expect(payloadToTabSpec(payload).kind).toBe("office-document");
  });

  it("maps xlsx office previews to office-spreadsheet tabs", () => {
    const payload: DisplayPayload = {
      kind: "office",
      previewRef: {
        sessionId: "s2",
        title: "budget.xlsx",
        sourcePath: "/tmp/budget.xlsx",
      },
    };
    expect(payloadToTabSpec(payload).kind).toBe("office-spreadsheet");
  });

  it("maps pptx office previews to office-slides tabs", () => {
    const payload: DisplayPayload = {
      kind: "office",
      previewRef: {
        sessionId: "s3",
        title: "deck.pptx",
        sourcePath: "/tmp/deck.pptx",
      },
    };
    expect(payloadToTabSpec(payload).kind).toBe("office-slides");
  });

  it("maps file-backed xlsx artifacts to spreadsheet tabs", () => {
    const payload: DisplayPayload = {
      kind: "file-artifact",
      filePath: "/tmp/budget.xlsx",
      artifactKind: "office-spreadsheet",
      title: "budget.xlsx",
      createdAt: 42,
    };
    const spec = payloadToTabSpec(payload);
    expect(spec.id).toBe("file-artifact:/tmp/budget.xlsx");
    expect(spec.kind).toBe("office-spreadsheet");
  });

  it("maps csv artifacts to spreadsheet tabs", () => {
    const payload: DisplayPayload = {
      kind: "file-artifact",
      filePath: "/tmp/data.csv",
      artifactKind: "delimited-table",
      title: "data.csv",
    };
    expect(payloadToTabSpec(payload).kind).toBe("office-spreadsheet");
  });

  it("maps markdown files to markdown tabs", () => {
    const payload: DisplayPayload = {
      kind: "markdown",
      filePath: "/tmp/notes.md",
      title: "notes.md",
    };
    const spec = payloadToTabSpec(payload);
    expect(spec.id).toBe("markdown:/tmp/notes.md");
    expect(spec.kind).toBe("markdown");
  });

  it("maps url payloads to url tabs and preserves the stable tab id", () => {
    const payload: DisplayPayload = {
      kind: "url",
      url: "http://127.0.0.1:53121/",
      title: "Demo",
      tabId: "userApp:abc123",
      tooltip: "http://127.0.0.1:53121/",
    };
    const spec = payloadToTabSpec(payload);
    expect(spec.id).toBe("userApp:abc123");
    expect(spec.kind).toBe("url");
    expect(spec.title).toBe("Demo");
    expect(spec.tooltip).toBe("http://127.0.0.1:53121/");
  });

  it("maps every developer file change to the singleton source-diff tab", () => {
    const first = payloadToTabSpec({
      kind: "source-diff",
      filePath: "/tmp/app.ts",
      title: "app.ts",
      patch: "*** Begin Patch\n*** End Patch",
      createdAt: 7,
    });
    const second = payloadToTabSpec({
      kind: "source-diff",
      filePath: "/tmp/other.ts",
      title: "other.ts",
      createdAt: 9,
    });
    expect(first.id).toBe("source-diff");
    expect(first.kind).toBe("source-diff");
    expect(first.title).toBe("Code changes");
    expect(second.id).toBe("source-diff");
  });

  // Generated media and canvases get one tab per file; the shared item
  // stores are what merge a multi-image job, not a singleton gallery tab.
  it("gives each generated image its own tab id from the shared store", () => {
    const first = payloadToTabSpec({
      kind: "media",
      asset: { kind: "image", filePaths: ["/out/a.png"] },
      createdAt: 1,
    });
    const second = payloadToTabSpec({
      kind: "media",
      asset: { kind: "image", filePaths: ["/out/b.png", "/out/a.png"] },
      createdAt: 2,
    });

    expect(first.id).toBe("image:/out/a.png");
    expect(second.id).toBe("image:/out/b.png");
    expect(second.kind).toBe(first.kind);
  });

  it("gives each canvas its own tab id keyed by file path", () => {
    const spec = payloadToTabSpec({
      kind: "canvas-html",
      filePath: "/tmp/flow.html",
      title: "Flow",
      createdAt: 3,
    });

    expect(spec.id).toBe("canvas:/tmp/flow.html");
    expect(spec.kind).toBe("canvas");
    expect(spec.title).toBe("Flow");
  });
});
