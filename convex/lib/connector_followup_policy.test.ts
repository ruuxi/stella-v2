import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { connectorFollowupDisposition } from "./connector_followup_policy";

describe("connector follow-up ordering policy", () => {
  test("waits for initial delivery, delivers only after fulfillment", () => {
    assert.equal(connectorFollowupDisposition("pending"), "wait");
    assert.equal(connectorFollowupDisposition("claimed"), "wait");
    assert.equal(connectorFollowupDisposition("fulfilled"), "deliver");
  });

  test("suppresses canceled or missing requests", () => {
    assert.equal(connectorFollowupDisposition("cancelled"), "suppress");
    assert.equal(connectorFollowupDisposition(null), "suppress");
  });
});
