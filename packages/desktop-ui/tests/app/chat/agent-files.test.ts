import { describe, expect, it } from "vitest";
import type { EventRecord } from "@/features/chat/lib/event-transforms";
import {
  agentFilesSignature,
  deriveAgentFilesMap,
  mergeAgentFileEvents,
} from "@/features/workspace-display/agent-files";

const event = (
  id: string,
  type: EventRecord["type"],
  payload: EventRecord["payload"],
  timestamp: number,
): EventRecord => ({ _id: id, type, payload, timestamp });

const completion = (
  id: string,
  agentId: string,
  result: string,
  timestamp: number,
) => event(id, "agent-completed", { agentId, result }, timestamp);

describe("agent response file derivation", () => {
  it("keys the cache signature from completion result links", () => {
    const before = [completion("c1", "a1", "[a](/a.md)", 1)];
    const after = [...before, completion("c2", "a1", "[b](/b.md)", 2)];
    expect(agentFilesSignature(after)).not.toBe(agentFilesSignature(before));
  });

  it("ignores streaming and tool-result file metadata", () => {
    const base = [completion("c1", "a1", "[a](/a.md)", 1)];
    const noisy = [
      ...base,
      event(
        "p1",
        "agent-progress",
        { agentId: "a1", statusText: "Working" },
        2,
      ),
      event(
        "t1",
        "tool_result",
        {
          agentId: "a1",
          producedFiles: [
            { path: "/tmp/frame.png", kind: { type: "add" } },
          ],
        },
        3,
      ),
    ];
    expect(agentFilesSignature(noisy)).toBe(agentFilesSignature(base));
    expect(mergeAgentFileEvents(base, noisy)).toBe(base);
  });

  it("groups and deduplicates linked files by agent", () => {
    const files = deriveAgentFilesMap([
      completion("c1", "a1", "[report](/out/report.pdf)", 1),
      completion("c2", "a1", "Again [report](/out/report.pdf)", 2),
      completion("c3", "a2", "[notes](</out/My Notes.md>)", 3),
    ]);
    expect(files.get("a1")?.map((entry) => entry.path)).toEqual([
      "/out/report.pdf",
    ]);
    expect(files.get("a2")?.map((entry) => entry.path)).toEqual([
      "/out/My Notes.md",
    ]);
  });
});
