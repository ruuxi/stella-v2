import { describe, expect, test } from "bun:test";
import { sessionIdentityMatchesExpectedSubject } from "../../../convex/lib/session_identity";

describe("cloud session identity barrier", () => {
  test("accepts only the exact nonempty Better Auth subject", () => {
    expect(sessionIdentityMatchesExpectedSubject("user-a", "user-a")).toBe(
      true,
    );
    expect(sessionIdentityMatchesExpectedSubject("user-b", "user-a")).toBe(
      false,
    );
    expect(sessionIdentityMatchesExpectedSubject("user-a", "   ")).toBe(false);
  });
});
