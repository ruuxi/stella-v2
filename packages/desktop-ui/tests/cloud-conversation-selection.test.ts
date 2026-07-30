import { describe, expect, test } from "bun:test";
import type { CloudConversation } from "../src/features/cloud/cloud-api";
import {
  markCloudConversationCreated,
  resolveCloudConversationForShell,
  resolveCloudConversationRoute,
} from "../src/features/cloud/cloud-conversation-selection";

const conversation = (
  conversationId: string,
  updatedAt: number,
): CloudConversation => ({
  conversationId,
  ownerId: "owner",
  title: conversationId,
  createdAt: updatedAt,
  updatedAt,
});

describe("resolveCloudConversationRoute", () => {
  const conversations = [conversation("newest", 2), conversation("older", 1)];

  test("keeps an exact owned route even when the list order changes", () => {
    expect(
      resolveCloudConversationRoute({
        conversations,
        routeConversationId: "older",
        cachedConversationId: "newest",
        accountScope: "account:a",
      }),
    ).toBe("older");
  });

  test("rejects stale route and cache ids before choosing newest", () => {
    expect(
      resolveCloudConversationRoute({
        conversations,
        routeConversationId: "desktop-only",
        cachedConversationId: "also-stale",
        accountScope: "account:a",
      }),
    ).toBe("newest");
  });

  test("restores an exact-owned cached conversation outside the recent list", () => {
    const exactOwned = conversation("older-than-recent-page", 0);
    expect(
      resolveCloudConversationRoute({
        // Full and mini query the cached id exactly when it falls outside the
        // recent 25, then add the owner-validated row to the candidate set.
        conversations: [exactOwned, ...conversations],
        routeConversationId: null,
        cachedConversationId: exactOwned.conversationId,
        accountScope: "account:a",
      }),
    ).toBe(exactOwned.conversationId);
  });

  test("allows a just-created route until the live query catches up", () => {
    markCloudConversationCreated("created-now", "account:a");
    expect(
      resolveCloudConversationRoute({
        conversations,
        routeConversationId: "created-now",
        cachedConversationId: null,
        accountScope: "account:a",
      }),
    ).toBe("created-now");
  });

  test("allows a just-created cached conversation until the live query catches up", () => {
    markCloudConversationCreated("cached-created-now", "account:a");
    expect(
      resolveCloudConversationRoute({
        conversations,
        routeConversationId: null,
        cachedConversationId: "cached-created-now",
        accountScope: "account:a",
      }),
    ).toBe("cached-created-now");
  });

  test("does not carry a pending route across accounts", () => {
    markCloudConversationCreated("account-a-only", "account:a");
    expect(
      resolveCloudConversationRoute({
        conversations,
        routeConversationId: "account-a-only",
        cachedConversationId: null,
        accountScope: "account:b",
      }),
    ).toBe("newest");
  });

  test("does not carry a pending route across anonymous sessions", () => {
    markCloudConversationCreated("anonymous-a-only", "anonymous:session-a");
    expect(
      resolveCloudConversationRoute({
        conversations,
        routeConversationId: "anonymous-a-only",
        cachedConversationId: null,
        accountScope: "anonymous:session-b",
      }),
    ).toBe("newest");
  });
});

describe("resolveCloudConversationForShell", () => {
  const conversations = [conversation("newest", 2), conversation("older", 1)];

  test("keeps the validated cached conversation on non-chat routes", () => {
    expect(
      resolveCloudConversationForShell({
        isOnChatRoute: false,
        conversations,
        routeConversationId: null,
        cachedConversationId: "older",
        accountScope: "account:a",
      }),
    ).toBe("older");
  });

  test("does not let an off-route URL override account-scoped selection", () => {
    expect(
      resolveCloudConversationForShell({
        isOnChatRoute: false,
        conversations,
        routeConversationId: "foreign-route",
        cachedConversationId: "older",
        accountScope: "account:a",
      }),
    ).toBe("older");
  });

  test("requires an owned route while chat is visible", () => {
    expect(
      resolveCloudConversationForShell({
        isOnChatRoute: true,
        conversations,
        routeConversationId: "foreign-route",
        cachedConversationId: "older",
        accountScope: "account:a",
      }),
    ).toBeNull();
  });
});
