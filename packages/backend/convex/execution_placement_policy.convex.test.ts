import { describe, expect, it } from "vitest";
import {
  decideExecutionPlacement,
  deriveExecutionSubject,
  ingressMayClaimComputerSubject,
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

  it("lets only device-backed ingress claim the computer", () => {
    expect(ingressMayClaimComputerSubject("desktop")).toBe(true);
    expect(ingressMayClaimComputerSubject("mobile")).toBe(true);
    expect(ingressMayClaimComputerSubject("browser")).toBe(false);
    expect(ingressMayClaimComputerSubject("cloud")).toBe(false);
    expect(ingressMayClaimComputerSubject("schedule")).toBe(false);
  });

  it("keeps the subject a device-backed caller named", () => {
    expect(deriveExecutionSubject({ ingress: "mobile" })).toBe("portable");
    expect(
      deriveExecutionSubject({ ingress: "mobile", subject: "computer" }),
    ).toBe("computer");
    expect(
      deriveExecutionSubject({ ingress: "desktop", subject: "cloud" }),
    ).toBe("cloud");
  });

  it("never lets a deviceless ingress claim a computer subject", () => {
    for (const ingress of ["browser", "cloud", "schedule"] as const) {
      for (const subject of [
        undefined,
        "portable",
        "computer",
        "cloud",
      ] as const) {
        expect(deriveExecutionSubject({ ingress, subject })).toBe("cloud");
      }
    }
  });

  it("forbids fallback after durable computer acceptance", () => {
    expect(mayFallbackToCloud("computer_claimed")).toBe(true);
    expect(mayFallbackToCloud("computer_accepted")).toBe(false);
    expect(mayFallbackToCloud("computer_running")).toBe(false);
    expect(mayFallbackToCloud("reconciliation_required")).toBe(false);
  });
});
