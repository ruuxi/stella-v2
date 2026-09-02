import { describe, expect, it } from "vitest";

import { getPhoneAccessCharacterState } from "@/global/settings/phone-access-character-state";

/**
 * The phone-access hero is the character rig rather than a bespoke drawing,
 * so the only thing to pin is which pose each card state asks for.
 */
describe("phone access character state", () => {
  it("idles while signed out, whatever else is going on", () => {
    expect(
      getPhoneAccessCharacterState({
        hasConnectedAccount: false,
        hasActivePairing: true,
        pairedCount: 2,
      }),
    ).toBe("idle");
  });

  it("listens while a pairing code is waiting on the phone", () => {
    expect(
      getPhoneAccessCharacterState({
        hasConnectedAccount: true,
        hasActivePairing: true,
        pairedCount: 1,
      }),
    ).toBe("listening");
  });

  it("is happy once a phone is paired and nothing is pending", () => {
    expect(
      getPhoneAccessCharacterState({
        hasConnectedAccount: true,
        hasActivePairing: false,
        pairedCount: 1,
      }),
    ).toBe("happy");
  });

  it("idles on a fresh signed-in card", () => {
    expect(
      getPhoneAccessCharacterState({
        hasConnectedAccount: true,
        hasActivePairing: false,
        pairedCount: 0,
      }),
    ).toBe("idle");
  });
});
