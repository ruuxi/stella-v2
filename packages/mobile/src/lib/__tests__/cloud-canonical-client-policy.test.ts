import { describe, expect, test } from "bun:test";
import {
  canonicalAuthorityLeaseAllowsWork,
  cloudCanonicalClientPolicy,
} from "../cloud-canonical-client-policy";

describe("mobile canonical journal client policy", () => {
  test("keeps a restored outbox inert before exact DO authority", () => {
    expect(
      cloudCanonicalClientPolicy({
        canonicalJournal: true,
        authorityReady: false,
      }),
    ).toEqual({
      hydrateLocalTranscript: false,
      persistLocalTranscript: false,
      drainOperationalOutbox: false,
    });
  });

  test("allows only the operational outbox after authority catches up", () => {
    expect(
      cloudCanonicalClientPolicy({
        canonicalJournal: true,
        authorityReady: true,
      }),
    ).toEqual({
      hydrateLocalTranscript: false,
      persistLocalTranscript: false,
      drainOperationalOutbox: true,
    });
  });

  test("leaves guest and computer-local cache behavior unchanged", () => {
    expect(
      cloudCanonicalClientPolicy({
        canonicalJournal: false,
        authorityReady: false,
      }),
    ).toEqual({
      hydrateLocalTranscript: true,
      persistLocalTranscript: true,
      drainOperationalOutbox: true,
    });
  });

  test("retires account callbacks synchronously across an auth switch", () => {
    expect(
      canonicalAuthorityLeaseAllowsWork({
        canonicalJournal: true,
        capturedLease: 4,
        activeLease: 5,
      }),
    ).toBe(false);
    expect(
      canonicalAuthorityLeaseAllowsWork({
        canonicalJournal: true,
        capturedLease: 5,
        activeLease: 5,
      }),
    ).toBe(true);
  });
});
