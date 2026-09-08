import { describe, expect, it } from "vitest";
import { deriveLinkedFiles } from "../../../src/features/chat/hooks/use-event-rows";
import type { AgentCompletionSection } from "../../../src/features/chat/lib/agent-completion";

describe("deriveLinkedFiles", () => {
  it("turns a reply's linked files into pill entries, local and cloud alike", () => {
    const files = deriveLinkedFiles(
      "See [report](/Users/me/report.pdf) and [notes](/workspace/world/drive/notes.md).",
      10,
      [],
    );
    expect(files.map((entry) => [entry.path, Boolean(entry.cloudDriveFile)])).toEqual([
      ["/Users/me/report.pdf", false],
      ["notes.md", true],
    ]);
  });

  it("skips files a completion section on the row already shows and developer source files", () => {
    const section = {
      agentId: "a",
      title: "t",
      completedAtMs: 1,
      files: [{ path: "notes.md", timestamp: 1, payload: { kind: "markdown", filePath: "/notes.md", title: "notes.md", createdAt: 1 } }],
    } as unknown as AgentCompletionSection;
    const files = deriveLinkedFiles(
      "[notes](/workspace/world/drive/notes.md) [code](/repo/app.ts) [pdf](/out/a.pdf)",
      10,
      [section],
    );
    expect(files.map((entry) => entry.path)).toEqual(["/out/a.pdf"]);
  });

  it("returns nothing for a reply without links", () => {
    expect(deriveLinkedFiles("all done", 1, [])).toEqual([]);
  });
});
