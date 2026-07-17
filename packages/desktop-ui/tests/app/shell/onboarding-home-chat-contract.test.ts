import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_DEFAULT_SIDEBAR } from "@/global/onboarding/demo/DemoShell";

const ONBOARDING_DIR = join(
  import.meta.dirname,
  "../../../src/global/onboarding",
);

describe("Home + Chat onboarding contract", () => {
  it("shows only Home and Chat in the shipped demo navigation", () => {
    expect(
      DEMO_DEFAULT_SIDEBAR.map(({ id, label }) => ({ id, label })),
    ).toEqual([
      { id: "home", label: "Home" },
      { id: "chat", label: "Chat" },
    ]);
  });

  it("does not promise retired Store or Social client surfaces", () => {
    const shippedCopy = [
      "OnboardingShapeshiftPhase.tsx",
      "WelcomeDialog.tsx",
    ]
      .map((file) => readFileSync(join(ONBOARDING_DIR, file), "utf8"))
      .join("\n");

    expect(shippedCopy).not.toMatch(/\bStore\b/);
    expect(shippedCopy).not.toMatch(/\bsocial features\b/i);
    expect(shippedCopy).toContain("Start from Home, then use Chat");
  });
});
