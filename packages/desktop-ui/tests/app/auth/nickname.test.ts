// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  getStoredNickname,
  setStoredNickname,
} from "@/global/auth/hooks/use-nickname";
import { uiState } from "@/platform/ui-state";

describe("renderer account nickname", () => {
  beforeEach(() => {
    uiState.clear();
  });

  it("uses Account when no nickname has been saved", () => {
    expect(getStoredNickname("person@example.com")).toBe("Account");
    expect(getStoredNickname(undefined)).toBe("Account");
  });

  it("preserves an explicitly saved nickname", () => {
    setStoredNickname("person@example.com", "Stella User");

    expect(getStoredNickname("person@example.com")).toBe("Stella User");
  });
});
