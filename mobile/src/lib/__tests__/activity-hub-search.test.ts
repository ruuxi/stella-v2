import { describe, expect, test } from "bun:test";

import type { ChatArtifact, MobileTask } from "../../types";
import { filterHubArtifacts, filterHubTasks } from "../activity-hub-search";

const task = (overrides: Partial<MobileTask> = {}): MobileTask => ({
  id: "agent-1",
  title: "Research flights",
  status: "running",
  statusText: "Comparing fares",
  createdAt: 1_000,
  ...overrides,
});

const urlArtifact = (id: string, title: string): ChatArtifact => ({
  id,
  conversationId: "computer",
  payload: { kind: "url", url: "https://example.com", title, tabId: "t1" },
});

const markdownArtifact = (id: string, filePath: string): ChatArtifact => ({
  id,
  conversationId: "computer",
  payload: { kind: "markdown", filePath },
});

describe("filterHubTasks", () => {
  test("empty / whitespace query returns everything", () => {
    const tasks = [task(), task({ id: "agent-2", status: "completed" })];
    expect(filterHubTasks(tasks, "")).toHaveLength(2);
    expect(filterHubTasks(tasks, "   ")).toHaveLength(2);
  });

  test("matches title case-insensitively", () => {
    const tasks = [task(), task({ id: "agent-2", title: "Summarize PDF" })];
    expect(filterHubTasks(tasks, "FLIGHTS").map((t) => t.id)).toEqual([
      "agent-1",
    ]);
  });

  test("matches live status text and reasoning summaries", () => {
    const tasks = [
      task({ statusText: "Booking hotel" }),
      task({
        id: "agent-2",
        title: "Other work",
        statusText: undefined,
        reasoningSummaries: ["Checked the calendar", "Drafting the invite"],
      }),
    ];
    expect(filterHubTasks(tasks, "hotel").map((t) => t.id)).toEqual([
      "agent-1",
    ]);
    expect(filterHubTasks(tasks, "invite").map((t) => t.id)).toEqual([
      "agent-2",
    ]);
  });

  test("no match yields empty list", () => {
    expect(filterHubTasks([task()], "zebra")).toHaveLength(0);
  });
});

describe("filterHubArtifacts", () => {
  test("empty query returns everything", () => {
    const artifacts = [
      urlArtifact("a1", "Dashboard"),
      markdownArtifact("a2", "/tmp/notes.md"),
    ];
    expect(filterHubArtifacts(artifacts, "")).toHaveLength(2);
  });

  test("matches the visible card title (including derived file names)", () => {
    const artifacts = [
      urlArtifact("a1", "Quarterly Dashboard"),
      markdownArtifact("a2", "/tmp/meeting-notes.md"),
    ];
    expect(filterHubArtifacts(artifacts, "dashboard").map((a) => a.id)).toEqual(
      ["a1"],
    );
    expect(filterHubArtifacts(artifacts, "meeting").map((a) => a.id)).toEqual([
      "a2",
    ]);
  });

  test("matches the subtitle (artifact category / format)", () => {
    const artifacts = [
      urlArtifact("a1", "Dashboard"),
      markdownArtifact("a2", "/tmp/notes.md"),
    ];
    // "Live preview" is the url card's subtitle; "Markdown · MD" the file's.
    expect(filterHubArtifacts(artifacts, "live preview").map((a) => a.id)).toEqual(
      ["a1"],
    );
    expect(filterHubArtifacts(artifacts, "markdown").map((a) => a.id)).toEqual([
      "a2",
    ]);
  });
});
