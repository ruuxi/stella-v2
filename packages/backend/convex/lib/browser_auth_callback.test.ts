import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildBrowserAuthFragmentRedirect,
  normalizeBrowserAuthReturnTarget,
} from "./browser_auth_callback";

describe("browser auth callback targets", () => {
  test("accepts only an exact same-origin HTTPS app target without query or fragment", () => {
    assert.equal(
      normalizeBrowserAuthReturnTarget({
        rawReturnTo: "https://cloud.stella.sh/workspace",
        requestOrigin: "https://cloud.stella.sh",
      }),
      "https://cloud.stella.sh/workspace",
    );
    for (const rawReturnTo of [
      "https://attacker.example/workspace",
      "https://cloud.stella.sh.attacker.example/workspace",
      "https://user:pass@cloud.stella.sh/workspace",
      "https://cloud.stella.sh/workspace?next=https://attacker.example",
      "https://cloud.stella.sh/workspace#ott=ambient",
      "javascript:alert(1)",
    ]) {
      assert.equal(
        normalizeBrowserAuthReturnTarget({
          rawReturnTo,
          requestOrigin: "https://cloud.stella.sh",
        }),
        null,
      );
    }
  });

  test("allows HTTP only for local development callers", () => {
    assert.equal(
      normalizeBrowserAuthReturnTarget({
        rawReturnTo: "http://localhost:5173/cloud",
        requestOrigin: "http://localhost:5173",
      }),
      "http://localhost:5173/cloud",
    );
    assert.equal(
      normalizeBrowserAuthReturnTarget({
        rawReturnTo: "http://cloud.stella.test/cloud",
        requestOrigin: "http://cloud.stella.test",
      }),
      null,
    );
  });

  test("emits the credential only in a fragment", () => {
    const redirect = buildBrowserAuthFragmentRedirect({
      returnTo: "https://cloud.stella.sh/workspace",
      token: "valid_token-123",
    });
    assert.equal(
      redirect,
      "https://cloud.stella.sh/workspace#ott=valid_token-123",
    );
    assert.equal(new URL(redirect!).search, "");
    assert.equal(new URL(redirect!).hash, "#ott=valid_token-123");
  });

  test("rejects malformed credentials and contaminated targets", () => {
    assert.equal(
      buildBrowserAuthFragmentRedirect({
        returnTo: "https://cloud.stella.sh/workspace?ott=ambient",
        token: "valid_token-123",
      }),
      null,
    );
    assert.equal(
      buildBrowserAuthFragmentRedirect({
        returnTo: "https://cloud.stella.sh/workspace",
        token: "has/slash",
      }),
      null,
    );
  });
});
