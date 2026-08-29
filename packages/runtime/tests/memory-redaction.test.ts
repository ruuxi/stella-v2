import { describe, expect, it } from "vitest";

import { redactMemoryText } from "../kernel/memory/redaction.js";

describe("cloud memory credential redaction", () => {
  it("masks provider keys, bearer headers, and JWTs without dropping prose", () => {
    const redacted = redactMemoryText(
      [
        "The deploy key is sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2 for staging.",
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvd25lciJ9.c2lnbmF0dXJlLXZhbHVl",
        "Slack posts through xoxb-000111222333-abcdefghijkl.",
      ].join("\n"),
    );

    expect(redacted).toContain("The deploy key is");
    expect(redacted).toContain("for staging.");
    expect(redacted).not.toContain("A1b2C3d4E5f6G7h8I9j0K1l2");
    expect(redacted).not.toContain("c2lnbmF0dXJlLXZhbHVl");
    expect(redacted).not.toContain("abcdefghijkl");
    expect(redacted).toMatch(/Authorization: Bearer \S+\.\.\.\S+/u);
  });

  it("masks private keys, connection strings, env assignments, and URL secrets", () => {
    const redacted = redactMemoryText(
      [
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
        "postgres://stella:hunter2correct@db.internal:5432/app",
        'OPENAI_API_KEY="super-secret-value-1234"',
        '{"refresh_token":"rt-9f8e7d6c5b4a3210"}',
        "https://api.example.test/v1/items?key=abcdef1234567890&page=2",
        "https://stella:letmein@files.example.test/report.pdf",
      ].join("\n"),
    );

    expect(redacted).toContain("[REDACTED PRIVATE KEY]");
    expect(redacted).not.toContain("MIIEowIBAAKCAQEA");
    expect(redacted).toContain("postgres://stella:***@db.internal:5432/app");
    expect(redacted).not.toContain("super-secret-value-1234");
    expect(redacted).not.toContain("rt-9f8e7d6c5b4a3210");
    expect(redacted).not.toContain("abcdef1234567890");
    expect(redacted).toContain("key=***&page=2");
    expect(redacted).toContain("https://stella:***@files.example.test");
  });

  it("leaves ordinary memory prose byte-identical", () => {
    const prose =
      "Owner prefers Bun over npm, ships from packages/runtime, and reviews PRs on Fridays.";
    expect(redactMemoryText(prose)).toBe(prose);
  });
});
