import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [target] : [];
  });

describe("agent-authored Activity updates", () => {
  it("has no generated progress-summary scheduler or publish request", () => {
    const sourceRoot = path.resolve(import.meta.dirname, "../../../src");
    const source = sourceFiles(sourceRoot)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    expect(source).not.toContain("progress_summary");
    expect(source).not.toContain("useAgentProgressSummaryEngine");
    expect(source).not.toContain("publishReasoningSummaries");
  });

  it("renders authored messages newest first on the Activity surface", () => {
    const component = readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../../src/shell/AgentAssistantUpdates.tsx",
      ),
      "utf8",
    );
    expect(component).toContain("[...messages].reverse()");
    expect(component).toContain("shell.agentProgress.recentAgentMessages");
  });
});
