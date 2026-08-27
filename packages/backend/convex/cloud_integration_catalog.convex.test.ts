/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);

type Summary = {
  name: string;
  integrationId: string;
  action: string;
  revision: string;
};

type Claim =
  | {
      status: "dispatch";
      integrationId: string;
      action: string;
      sessionId: string;
    }
  | { status: "replay"; resultJson: string }
  | { status: "failed"; errorCode: string }
  | { status: "in_progress" };

const catalog = (
  internal as unknown as {
    cloud_integration_catalog: {
      listCodeIntegrationToolsInternal: FunctionReference<
        "query",
        "internal",
        {
          ownerId: string;
          ownerGeneration: string;
          query?: string;
          limit: number;
        },
        Summary[]
      >;
      getCodeIntegrationActionInternal: FunctionReference<
        "query",
        "internal",
        { ownerId: string; ownerGeneration: string; name: string },
        null | (Summary & { inputSchemaJson: string })
      >;
      claimCodeIntegrationCallInternal: FunctionReference<
        "mutation",
        "internal",
        {
          ownerId: string;
          ownerGeneration: string;
          requestId: string;
          fingerprint: string;
          name: string;
          revision: string;
          leaseId: string;
          now: number;
        },
        Claim
      >;
      completeCodeIntegrationCallInternal: FunctionReference<
        "mutation",
        "internal",
        {
          ownerId: string;
          ownerGeneration: string;
          requestId: string;
          fingerprint: string;
          leaseId: string;
          outcome: "succeeded" | "failed" | "unknown";
          resultJson?: string;
          errorCode?: string;
          now: number;
        },
        null
      >;
    };
  }
).cloud_integration_catalog;

const OWNER = "owner-code-tools";
const GENERATION = "generation-code-tools";
const TOOL = "native__gmail__GMAIL_GET_PROFILE";
const POLICY_VERSION = "2026-08-26.gmail-get-profile.v1";
const TOOLKIT_VERSION = "20260817_00";
const REVIEWED_SCHEMA_JSON = JSON.stringify({
  type: "object",
  properties: { user_id: { type: "string", minLength: 1, maxLength: 320 } },
  additionalProperties: false,
});

const seed = async (t: ReturnType<typeof createTest>) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId: OWNER,
      generation: GENERATION,
      state: "open",
      createdAt: 1,
      updatedAt: 1,
    });
    await ctx.db.insert("integrations_public", {
      id: "gmail",
      provider: "composio",
      actionCount: 4,
      connector: {
        type: "composio",
        toolkit: "gmail",
        provider: "composio",
      },
      enabled: true,
      usagePolicy: "ready",
      updatedAt: 10,
    });
    await ctx.db.insert("user_integrations", {
      ownerId: OWNER,
      provider: "gmail",
      mode: "composio",
      externalId: "trs_owner_session",
      config: {},
      createdAt: 10,
      updatedAt: 10,
    });
    await ctx.db.insert("integration_actions", {
      integrationId: "gmail",
      name: "GMAIL_GET_PROFILE",
      title: "Get profile",
      description: "Read the connected Gmail profile.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        source: "composio_tool_tags",
      },
      codeModePolicy: {
        effect: "read",
        requiresApproval: false,
        policyVersion: POLICY_VERSION,
        toolkitVersion: TOOLKIT_VERSION,
        reviewedInputSchemaJson: REVIEWED_SCHEMA_JSON,
        source: "stella_admin",
      },
      codeModeEligible: true,
      searchText: "GMAIL_GET_PROFILE Get profile Read Gmail profile",
      inputSchemaJson: JSON.stringify({
        type: "object",
        properties: { user_id: { type: "string" } },
        additionalProperties: false,
      }),
      updatedAt: 11,
    });
    // Provider hints alone are evidence, never Stella admission authority.
    await ctx.db.insert("integration_actions", {
      integrationId: "gmail",
      name: "GMAIL_PROVIDER_ONLY_READ",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        source: "composio_tool_tags",
      },
      searchText: "GMAIL_PROVIDER_ONLY_READ",
      inputSchemaJson: '{"type":"object"}',
      updatedAt: 11,
    });
    await ctx.db.insert("integration_actions", {
      integrationId: "gmail",
      name: "GMAIL_SEND_EMAIL",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        source: "composio_tool_tags",
      },
      searchText: "GMAIL_SEND_EMAIL",
      inputSchemaJson: '{"type":"object"}',
      updatedAt: 11,
    });
    await ctx.db.insert("integration_actions", {
      integrationId: "gmail",
      name: "GMAIL_MYSTERY_ACTION",
      searchText: "GMAIL_MYSTERY_ACTION",
      inputSchemaJson: '{"type":"object"}',
      updatedAt: 11,
    });
  });
};

const list = (t: ReturnType<typeof createTest>) =>
  t.query(catalog.listCodeIntegrationToolsInternal, {
    ownerId: OWNER,
    ownerGeneration: GENERATION,
    limit: 20,
  });

describe("cloud connected-tool Code catalog", () => {
  it("discovers only explicitly read-only, non-destructive connected actions", async () => {
    const t = createTest();
    await seed(t);

    await expect(list(t)).resolves.toEqual([
      expect.objectContaining({
        name: TOOL,
        integrationId: "gmail",
        action: "GMAIL_GET_PROFILE",
        revision: expect.stringMatching(/^v2:[a-f0-9]{64}$/u),
      }),
    ]);
    await expect(
      t.query(catalog.getCodeIntegrationActionInternal, {
        ownerId: OWNER,
        ownerGeneration: GENERATION,
        name: "native__gmail__GMAIL_SEND_EMAIL",
      }),
    ).resolves.toBeNull();
    await expect(
      t.query(catalog.getCodeIntegrationActionInternal, {
        ownerId: OWNER,
        ownerGeneration: GENERATION,
        name: "native__gmail__GMAIL_PROVIDER_ONLY_READ",
      }),
    ).resolves.toBeNull();
    await expect(
      t.query(catalog.getCodeIntegrationActionInternal, {
        ownerId: OWNER,
        ownerGeneration: GENERATION,
        name: "native__gmail__GMAIL_MYSTERY_ACTION",
      }),
    ).resolves.toBeNull();
  });

  it("indexes eligibility before truncation so preceding ineligible rows cannot hide review", async () => {
    const t = createTest();
    await seed(t);
    await t.run(async (ctx) => {
      for (let index = 0; index < 24; index += 1) {
        const suffix = String(index).padStart(2, "0");
        await ctx.db.insert("integration_actions", {
          integrationId: "gmail",
          name: `GMAIL_AAA_${suffix}`,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            source: "composio_tool_tags",
          },
          searchText: `GMAIL_AAA_${suffix} profile decoy`,
          inputSchemaJson: '{"type":"object"}',
          updatedAt: 11,
        });
      }
    });
    await expect(list(t)).resolves.toEqual([
      expect.objectContaining({ name: TOOL }),
    ]);
    await expect(
      t.query(catalog.listCodeIntegrationToolsInternal, {
        ownerId: OWNER,
        ownerGeneration: GENERATION,
        query: "profile",
        limit: 20,
      }),
    ).resolves.toEqual([expect.objectContaining({ name: TOOL })]);
  });

  it("claims once, blocks concurrent duplicate dispatch, and exactly replays", async () => {
    const t = createTest();
    await seed(t);
    const [discovered] = await list(t);
    const base = {
      ownerId: OWNER,
      ownerGeneration: GENERATION,
      requestId: "request-00000001",
      fingerprint: "fingerprint-a",
      name: TOOL,
      revision: discovered!.revision,
      now: 1_000,
    };
    await expect(
      t.mutation(catalog.claimCodeIntegrationCallInternal, {
        ...base,
        leaseId: "lease-a",
      }),
    ).resolves.toMatchObject({
      status: "dispatch",
      sessionId: "trs_owner_session",
    });
    await expect(
      t.mutation(catalog.claimCodeIntegrationCallInternal, {
        ...base,
        leaseId: "lease-b",
        now: 1_001,
      }),
    ).resolves.toEqual({ status: "in_progress" });
    await t.mutation(catalog.completeCodeIntegrationCallInternal, {
      ownerId: OWNER,
      ownerGeneration: GENERATION,
      requestId: base.requestId,
      fingerprint: base.fingerprint,
      leaseId: "lease-a",
      outcome: "succeeded",
      resultJson: '{"ok":true}',
      now: 1_002,
    });
    await expect(
      t.mutation(catalog.claimCodeIntegrationCallInternal, {
        ...base,
        leaseId: "lease-c",
        now: 2_000,
      }),
    ).resolves.toEqual({
      status: "replay",
      resultJson: '{"ok":true}',
    });
    await expect(
      t.mutation(catalog.claimCodeIntegrationCallInternal, {
        ...base,
        fingerprint: "fingerprint-b",
        leaseId: "lease-d",
        now: 2_001,
      }),
    ).rejects.toThrow(/different input/i);
  });

  it("revalidates policy and owner generation at dispatch", async () => {
    const t = createTest();
    await seed(t);
    const staleRevision = (await list(t))[0]!.revision;
    const actionId = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("integration_actions")
        .withIndex("by_integrationId_and_name", (q) =>
          q.eq("integrationId", "gmail").eq("name", "GMAIL_GET_PROFILE"),
        )
        .unique();
      return row!._id;
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(actionId, {
        codeModePolicy: {
          effect: "read",
          requiresApproval: false,
          policyVersion: "2026-08-26.gmail-get-profile.v2",
          toolkitVersion: TOOLKIT_VERSION,
          reviewedInputSchemaJson: REVIEWED_SCHEMA_JSON,
          source: "stella_admin",
        },
      });
    });
    await expect(
      t.mutation(catalog.claimCodeIntegrationCallInternal, {
        ownerId: OWNER,
        ownerGeneration: GENERATION,
        requestId: "request-00000002",
        fingerprint: "fingerprint-a",
        name: TOOL,
        revision: staleRevision,
        leaseId: "lease-a",
        now: 1_000,
      }),
    ).rejects.toThrow(/policy changed/i);
    await expect(
      t.query(catalog.listCodeIntegrationToolsInternal, {
        ownerId: OWNER,
        ownerGeneration: "stale-generation",
        limit: 20,
      }),
    ).rejects.toThrow(/before the account data was reset/i);
  });

  it("invalidates a stale revision when schema bytes change at the same timestamp", async () => {
    const t = createTest();
    await seed(t);
    const staleRevision = (await list(t))[0]!.revision;
    await t.run(async (ctx) => {
      const action = await ctx.db
        .query("integration_actions")
        .withIndex("by_integrationId_and_name", (q) =>
          q.eq("integrationId", "gmail").eq("name", "GMAIL_GET_PROFILE"),
        )
        .unique();
      if (!action) throw new Error("missing action");
      await ctx.db.patch(action._id, {
        inputSchemaJson:
          '{"type":"object","properties":{"user_id":{"type":"string","maxLength":10}},"additionalProperties":false}',
        updatedAt: action.updatedAt,
      });
    });
    await expect(
      t.mutation(catalog.claimCodeIntegrationCallInternal, {
        ownerId: OWNER,
        ownerGeneration: GENERATION,
        requestId: "request-stale-schema",
        fingerprint: "fingerprint-stale-schema",
        name: TOOL,
        revision: staleRevision,
        leaseId: "lease-stale-schema",
        now: 2_000,
      }),
    ).rejects.toThrow(/policy changed/i);
  });

  it("fails closed for both migration source and destination owners", async () => {
    const sourceTest = createTest();
    await seed(sourceTest);
    await sourceTest.run(async (ctx) => {
      await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId: OWNER,
        toOwnerId: "destination-owner",
        status: "running",
        createdAt: 20,
        updatedAt: 20,
      });
    });
    await expect(list(sourceTest)).rejects.toThrow(/no longer active/i);

    const destinationTest = createTest();
    await seed(destinationTest);
    await destinationTest.run(async (ctx) => {
      await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId: "source-owner",
        toOwnerId: OWNER,
        status: "pending",
        createdAt: 20,
        updatedAt: 20,
      });
    });
    await expect(list(destinationTest)).rejects.toThrow(/data is moving/i);
  });

  it("does not expose another owner's connection", async () => {
    const t = createTest();
    await seed(t);
    await t.run(async (ctx) => {
      const connection = await ctx.db
        .query("user_integrations")
        .withIndex("by_ownerId_and_provider", (q) =>
          q.eq("ownerId", OWNER).eq("provider", "gmail"),
        )
        .unique();
      await ctx.db.patch(connection!._id, { ownerId: "another-owner" });
    });
    await expect(list(t)).resolves.toEqual([]);
  });
});
