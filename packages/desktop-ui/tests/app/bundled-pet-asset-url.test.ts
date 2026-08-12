import { describe, expect, it } from "vitest";

import { resolveBundledPetAssetUrl } from "@/shell/pet/bundled-pets";

describe("bundled pet asset URL", () => {
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
