import { describe, expect, it } from "vitest";
import {
  decideExecutionPlacement,
  deriveExecutionSubject,
  executionSubjectForWorkspace,
  mayFallbackToCloud,
  type ExecutionIngress,
  type ExecutionSubject,
} from "../../contracts/execution-placement";

describe("automatic execution placement policy", () => {
  const decide = (ingress: ExecutionIngress, subject: ExecutionSubject) =>
    decideExecutionPlacement({ ingress, subject, requestKind: "chat" });

  it("keeps desktop root execution on the computer", () => {
    expect(decide("desktop", "portable")).toMatchObject({
      kind: "commit",
      placement: "computer",
    });
    expect(decide("desktop", "computer")).toMatchObject({
      kind: "commit",
      placement: "computer",
    });
  });

  it("offers mobile portable work to a paired computer with cloud fallback", () => {
    expect(decide("mobile", "portable")).toEqual({
      kind: "offer-computer",
      onNoEligibleComputer: "cloud",
      reason: "paired-computer-preferred",
    });
  });

  it("offers mobile computer work to a paired computer with cloud fallback", () => {
    expect(decide("mobile", "computer")).toEqual({
      kind: "offer-computer",
      onNoEligibleComputer: "cloud",
      reason: "paired-computer-preferred-for-computer-work",
    });
  });

  it("commits browser, cloud, and scheduled portable work to cloud", () => {
    for (const ingress of ["browser", "cloud", "schedule"] as const) {
      expect(decide(ingress, "portable")).toMatchObject({
        kind: "commit",
        placement: "cloud",
      });
    }
  });

  it("never sends a hosted subject to a local executor", () => {
    for (const ingress of [
      "desktop",
      "mobile",
      "browser",
      "cloud",
      "schedule",
    ] as const) {
      expect(decide(ingress, "cloud")).toMatchObject({
        kind: "commit",
        placement: "cloud",
      });
    }
  });

  it("treats workspace as subject, not placement", () => {
    expect(executionSubjectForWorkspace(undefined)).toBe("portable");
    expect(executionSubjectForWorkspace("computer")).toBe("computer");
    expect(executionSubjectForWorkspace("cloud")).toBe("cloud");
    expect(executionSubjectForWorkspace("project:stella")).toBe("cloud");
    expect(executionSubjectForWorkspace("app:calendar")).toBe("cloud");
  });

  it("derives subject from trusted ingress and an authorized workspace", () => {
    expect(deriveExecutionSubject({ ingress: "mobile" })).toBe("portable");
    expect(
      deriveExecutionSubject({ ingress: "mobile", workspace: "computer" }),
    ).toBe("computer");
    expect(
      deriveExecutionSubject({
        ingress: "desktop",
        workspace: "project:stella",
      }),
    ).toBe("cloud");
    expect(
      deriveExecutionSubject({ ingress: "browser", workspace: undefined }),
    ).toBe("cloud");
    expect(
      deriveExecutionSubject({ ingress: "schedule", workspace: "drive" }),
    ).toBe("cloud");
  });

  it("forbids fallback after durable computer acceptance", () => {
    expect(mayFallbackToCloud("computer_claimed")).toBe(true);
    expect(mayFallbackToCloud("computer_accepted")).toBe(false);
    expect(mayFallbackToCloud("computer_running")).toBe(false);
    expect(mayFallbackToCloud("reconciliation_required")).toBe(false);
  });
});
