import { afterEach, describe, expect, it } from "bun:test";

import {
  embeddedDisposableDomainCount,
  isDisposableEmail,
  normalizeEmailForSybil,
} from "../convex/lib/disposable_email_domains";

const previousBlocklist = process.env.STELLA_EMAIL_DOMAIN_BLOCKLIST;

afterEach(() => {
  if (previousBlocklist === undefined) {
    delete process.env.STELLA_EMAIL_DOMAIN_BLOCKLIST;
  } else {
    process.env.STELLA_EMAIL_DOMAIN_BLOCKLIST = previousBlocklist;
  }
});

describe("disposable email hygiene", () => {
  it("ships a broad embedded list and matches subdomains", () => {
    expect(embeddedDisposableDomainCount()).toBeGreaterThanOrEqual(200);
    for (const email of [
      "person@mailinator.com",
      "person@guerrillamail.com",
      "person@10minutemail.com",
      "person@temp-mail.org",
      "person@yopmail.com",
      "person@sharklasers.com",
      "person@dispostable.com",
      "person@trashmail.com",
      "person@getnada.com",
      "person@maildrop.cc",
      "person@mx.mailinator.com",
    ]) {
      expect(isDisposableEmail(email)).toBe(true);
    }
    expect(isDisposableEmail("person@example.com")).toBe(false);
  });

  it("adds configured domains with the same subdomain rule", () => {
    process.env.STELLA_EMAIL_DOMAIN_BLOCKLIST =
      "blocked.example, @another.example";
    expect(isDisposableEmail("x@blocked.example")).toBe(true);
    expect(isDisposableEmail("x@mail.blocked.example")).toBe(true);
    expect(isDisposableEmail("x@another.example")).toBe(true);
  });

  it("normalizes Gmail aliases without changing other providers", () => {
    expect(normalizeEmailForSybil(" First.Last+promo@Gmail.com ")).toBe(
      "firstlast@gmail.com",
    );
    expect(normalizeEmailForSybil("F.I.R.S.T+tag@googlemail.com")).toBe(
      "first@gmail.com",
    );
    expect(normalizeEmailForSybil("First.Last+promo@example.com")).toBe(
      "first.last+promo@example.com",
    );
  });
});
