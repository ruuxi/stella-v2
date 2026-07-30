import { describe, expect, test } from "bun:test";
import {
  getMiniCloudConversationCreateId,
  rotateMiniCloudConversationCreateId,
} from "../src/features/cloud/cloud-conversation-cache";

describe("mini cloud conversation create ids", () => {
  test("reuses a lost-response create id, then rotates after success", () => {
    const scope = `account:test:${crypto.randomUUID()}`;
    const first = getMiniCloudConversationCreateId(scope);

    expect(getMiniCloudConversationCreateId(scope)).toBe(first);
    rotateMiniCloudConversationCreateId(scope);
    expect(getMiniCloudConversationCreateId(scope)).not.toBe(first);
  });

  test("does not share bootstrap idempotency keys across accounts", () => {
    const suffix = crypto.randomUUID();
    expect(getMiniCloudConversationCreateId(`account:a:${suffix}`)).not.toBe(
      getMiniCloudConversationCreateId(`account:b:${suffix}`),
    );
  });
});
