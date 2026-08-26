import { describe, expect, it } from "vitest";

import {
  BUILT_IN_PET,
  resolveBundledPetAssetUrl,
} from "@/shell/pet/built-in-pet";

describe("built-in pet asset URL", () => {
  it("uses the relative production base for packaged renderer assets", () => {
    expect(resolveBundledPetAssetUrl("pets/stella.webp", "./")).toBe(
      "./pets/stella.webp",
    );
  });

  it("uses the root development base served by Vite", () => {
    expect(resolveBundledPetAssetUrl("/pets/stella.webp", "/")).toBe(
      "/pets/stella.webp",
    );
  });
});

describe("built-in pet descriptor", () => {
  it("points at the single bundled Stella sprite sheet", () => {
    expect(BUILT_IN_PET.id).toBe("stella");
    expect(BUILT_IN_PET.displayName).toBe("Stella");
    expect(BUILT_IN_PET.spritesheetUrl).toContain("pets/stella.webp");
  });
});
