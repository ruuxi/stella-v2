import { describe, expect, it } from "bun:test";

import * as contract from "../../contracts/capabilities";
import {
  CAPABILITIES,
  CAPABILITY_DENIED_CODE,
  CAPABILITY_LABELS,
  CAPABILITY_MATRIX,
  CAPABILITY_PLAN_LABELS,
  buildCapabilityDenial,
  capabilityDenialMarker,
  capabilityForMediaCapabilityId,
  hasCapability,
  isCapability,
  minimumPlanForCapability,
  toCapabilityAudience,
  type Capability,
  type CapabilityAudience,
} from "../convex/capability_contract";
import { MEDIA_CAPABILITIES } from "../convex/media_catalog";

const AUDIENCES: CapabilityAudience[] = ["anonymous", "free", "go", "pro"];

describe("capability contract parity", () => {

  it("declares the same capability list as the shared contract", () => {
    expect([...CAPABILITIES]).toEqual([...contract.CAPABILITIES]);
  });

  it("declares the same matrix as the shared contract", () => {
    expect(CAPABILITY_MATRIX).toEqual(contract.CAPABILITY_MATRIX);
  });

  it("labels capabilities and plans identically to the shared contract", () => {
    expect(CAPABILITY_LABELS).toEqual(contract.CAPABILITY_LABELS);
    expect(CAPABILITY_PLAN_LABELS).toEqual(contract.CAPABILITY_PLAN_LABELS);
    expect(CAPABILITY_DENIED_CODE).toBe(contract.CAPABILITY_DENIED_CODE);
    expect(
      Object.fromEntries(
        CAPABILITIES.map((capability) => [
          capability,
          buildCapabilityDenial(capability, "free"),
        ]),
      ),
    ).toEqual(
      Object.fromEntries(
        contract.CAPABILITIES.map((capability) => [
          capability,
          contract.buildCapabilityDenial(capability, "free"),
        ]),
      ),
    );
  });

  it("resolves every audience the same way on both sides", () => {
    for (const capability of CAPABILITIES) {
      for (const audience of AUDIENCES) {
        expect(hasCapability(audience, capability)).toBe(
          contract.hasCapability(audience, capability),
        );
      }
      expect(minimumPlanForCapability(capability)).toBe(
        contract.minimumPlanForCapability(capability),
      );
    }
  });

  it("collapses fallback audiences the same way on both sides", () => {
    const managed = [
      "anonymous",
      "free",
      "go",
      "pro",
      "go_fallback",
      "pro_fallback",
      "nonsense",
      null,
      undefined,
    ] as const;
    for (const audience of managed) {
      expect(
        toCapabilityAudience(
          audience as Parameters<typeof toCapabilityAudience>[0],
        ),
      ).toBe(
        contract.toCapabilityAudience(
          audience as Parameters<typeof contract.toCapabilityAudience>[0],
        ),
      );
    }
  });
});

describe("capability matrix", () => {
  it("holds only the four enforced generative surfaces", () => {

    expect([...CAPABILITIES]).toEqual([
      "image_generation",
      "video_generation",
      "audio_generation",
      "three_d_generation",
    ]);
  });

  it("keeps every generative surface on Pro only", () => {
    for (const capability of CAPABILITIES) {
      expect(hasCapability("pro", capability)).toBe(true);
      expect(hasCapability("go", capability)).toBe(false);
      expect(hasCapability("free", capability)).toBe(false);
      expect(hasCapability("anonymous", capability)).toBe(false);
      expect(minimumPlanForCapability(capability)).toBe("pro");
    }
  });

  it("follows the table rather than a hardcoded plan", () => {

    const original = CAPABILITY_MATRIX.image_generation.go;
    try {
      CAPABILITY_MATRIX.image_generation.go = true;
      expect(hasCapability("go", "image_generation")).toBe(true);
      expect(minimumPlanForCapability("image_generation")).toBe("go");
      expect(
        buildCapabilityDenial("image_generation", "free").minimumPlan,
      ).toBe("go");
    } finally {
      CAPABILITY_MATRIX.image_generation.go = original;
    }
    expect(minimumPlanForCapability("image_generation")).toBe("pro");
  });

  it("reports no minimum plan when a capability is off everywhere", () => {
    const original = { ...CAPABILITY_MATRIX.three_d_generation };
    try {
      CAPABILITY_MATRIX.three_d_generation = {
        anonymous: false,
        free: false,
        go: false,
        pro: false,
      };
      expect(minimumPlanForCapability("three_d_generation")).toBeNull();
      const denial = buildCapabilityDenial("three_d_generation", "pro");
      expect(denial.minimumPlan).toBeNull();
      expect(denial.message).toContain("not available on any plan");
    } finally {
      CAPABILITY_MATRIX.three_d_generation = original;
    }
  });

  it("narrows unknown strings", () => {
    expect(isCapability("image_generation")).toBe(true);
    expect(isCapability("image-generation")).toBe(false);
    expect(isCapability(null)).toBe(false);
  });
});

describe("capability denial payload", () => {
  it("carries capability, audience, and minimum plan", () => {
    const denial = buildCapabilityDenial("video_generation", "go");
    expect(denial).toEqual({
      code: "CAPABILITY_REQUIRED",
      capability: "video_generation",
      audience: "go",
      minimumPlan: "pro",
      message:
        "Video generation requires the Pro plan. [capability/video_generation]",
    });
  });

  it("embeds a marker the flattened-string error path can still parse", () => {
    for (const capability of CAPABILITIES) {
      const denial = buildCapabilityDenial(capability, "free");
      expect(denial.message).toContain(capabilityDenialMarker(capability));

      const normalized = denial.message.toLowerCase();
      for (const foreignMatcher of [
        "sign in required",
        "free allowance",
        "lifetime allowance",
        "usage limit reached",
        "forbidden",
        "permission denied",
      ]) {
        expect(normalized).not.toContain(foreignMatcher);
      }
    }
  });
});

describe("media capability mapping", () => {
  it("gates every generative media catalog entry", () => {
    const ungated = MEDIA_CAPABILITIES.filter(
      (entry) => capabilityForMediaCapabilityId(entry.id) === null,
    ).map((entry) => entry.id);

    expect(ungated.sort()).toEqual(["audio_visual_separate", "speech_to_text"]);
  });

  it("maps each gated entry to the capability its category implies", () => {
    const expectedByCategory: Record<string, Capability> = {
      image: "image_generation",
      video: "video_generation",
      audio: "audio_generation",
      "3d": "three_d_generation",
    };
    for (const entry of MEDIA_CAPABILITIES) {
      const capability = capabilityForMediaCapabilityId(entry.id);
      if (!capability) continue;
      expect(capability).toBe(expectedByCategory[entry.category] as Capability);
    }
  });

  it("has no gate for an id the catalog does not define", () => {
    expect(capabilityForMediaCapabilityId("not_a_capability")).toBeNull();
  });
});
