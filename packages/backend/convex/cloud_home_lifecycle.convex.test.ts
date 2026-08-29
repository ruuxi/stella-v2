/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { hashSha256Hex } from "./lib/crypto_utils";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);
const OWNER_ID = "https://issuer.test|cloud-home-owner";
const GENERATION = "cloud-home-generation-1";

type SkillHead = {
  skillId: string;
  ownerGeneration: string;
  versionId?: string;
  revision: number;
};

const skills = (
  api as unknown as {
    cloud_skills: {
      listMySkillHeads: FunctionReference<
        "query",
        "public",
        { clientScope: string },
        SkillHead[]
      >;
    };
  }
).cloud_skills;

const memory = (
  api as unknown as {
    cloud_memory: {
      listMyMemoryDocuments: FunctionReference<
        "query",
        "public",
        { limit?: number },
        unknown[]
      >;
      getMyMemoryDocument: FunctionReference<
        "query",
        "public",
        { name: string; kind: "profile" },
        unknown
      >;
    };
  }
).cloud_memory;

const skillsInternal = (
  internal as unknown as {
    cloud_skills: {
      beginSkillWriteInternal: FunctionReference<
        "mutation",
        "internal",
        {
          ownerId: string;
          ownerGeneration: string;
          slug: string;
          name: string;
          description: string;
          source: "desktop_sync";
          availability: "both";
          expectedRevision: number;
          manifestSha256: string;
          treeSha256: string;
          files: Array<{
            path: string;
            sha256: string;
            sizeBytes: number;
            contentType: string;
          }>;
          idempotencyKey: string;
          now: number;
        },
        {
          intentId: string;
          skillId: string;
          versionId: string;
          manifestR2Key: string;
          manifestSha256: string;
          treeSha256: string;
        }
      >;
      commitSkillWriteInternal: FunctionReference<
        "mutation",
        "internal",
        {
          ownerId: string;
          ownerGeneration: string;
          intentId: string;
          versionId: string;
          manifestR2Key: string;
          manifestSha256: string;
          treeSha256: string;
          now: number;
        },
        unknown
      >;
      listMirroredSkillsInternal: FunctionReference<
        "query",
        "internal",
        {
          ownerId: string;
          ownerGeneration: string;
          agentType: "orchestrator" | "general";
          includeFiles?: boolean;
        },
        Array<{ skillId: string; versionId: string }>
      >;
    };
  }
).cloud_skills;

const asOwner = (t: ReturnType<typeof createTest>) =>
  t.withIdentity({
    issuer: "https://issuer.test",
    subject: "cloud-home-owner",
    tokenIdentifier: OWNER_ID,
  });

const setLifecycle = async (
  t: ReturnType<typeof createTest>,
  state: "open" | "resetting" | "deleting",
  generation = GENERATION,
) => {
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("cloud_owner_lifecycles")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", OWNER_ID))
      .unique();
    const values = {
      ownerId: OWNER_ID,
      generation,
      state,
      ...(state === "open" ? {} : { operationId: `operation-${state}` }),
      updatedAt: Date.now(),
    };
    if (row) await ctx.db.patch(row._id, values);
    else
      await ctx.db.insert("cloud_owner_lifecycles", {
        ...values,
        createdAt: Date.now(),
      });
  });
};

const uploadSkill = async (t: ReturnType<typeof createTest>) => {
  const fileSha256 = "1".repeat(64);
  const treeSha256 = await hashSha256Hex(
    ["SKILL.md", fileSha256, "1", "text/markdown\n"].join("\0"),
  );
  const prepared = await t.mutation(skillsInternal.beginSkillWriteInternal, {
    ownerId: OWNER_ID,
    ownerGeneration: GENERATION,
    slug: "calendar",
    name: "Calendar",
    description: "Use the existing calendar tools safely.",
    source: "desktop_sync",
    availability: "both",
    expectedRevision: 0,
    manifestSha256: "2".repeat(64),
    treeSha256,
    files: [
      {
        path: "SKILL.md",
        sha256: fileSha256,
        sizeBytes: 1,
        contentType: "text/markdown",
      },
    ],
    idempotencyKey: "cloud-home-lifecycle-upload",
    now: 1_000,
  });
  await t.mutation(skillsInternal.commitSkillWriteInternal, {
    ownerId: OWNER_ID,
    ownerGeneration: GENERATION,
    intentId: prepared.intentId,
    versionId: prepared.versionId,
    manifestR2Key: prepared.manifestR2Key,
    manifestSha256: prepared.manifestSha256,
    treeSha256: prepared.treeSha256,
    now: 1_001,
  });
  return prepared;
};

describe("Cloud Home lifecycle fences", () => {
  it("mirrors a published skill version straight through to the worker with no cloud-side authorization step", async () => {
    const t = createTest();
    await setLifecycle(t, "open");
    const prepared = await uploadSkill(t);
    const owner = asOwner(t);
    const [head] = await owner.query(skills.listMySkillHeads, {
      clientScope: "account:cloud-home-owner",
    });
    expect(head).toMatchObject({
      skillId: prepared.skillId,
      versionId: prepared.versionId,
      ownerGeneration: GENERATION,
      revision: 1,
    });

    // The device root is the only gate. Committing the mirror write is what
    // makes the skill loadable, so a cloud turn sees it immediately.
    await expect(
      t.query(skillsInternal.listMirroredSkillsInternal, {
        ownerId: OWNER_ID,
        ownerGeneration: GENERATION,
        agentType: "orchestrator",
      }),
    ).resolves.toMatchObject([
      { skillId: prepared.skillId, versionId: prepared.versionId },
    ]);
  });

  it.each(["resetting", "deleting"] as const)(
    "blocks every public read and control while owner data is %s",
    async (state) => {
      const t = createTest();
      await setLifecycle(t, "open");
      const prepared = await uploadSkill(t);
      await setLifecycle(t, state);
      const owner = asOwner(t);
      const calls = [
        () =>
          owner.query(skills.listMySkillHeads, {
            clientScope: "account:cloud-home-owner",
          }),
        () => owner.query(memory.listMyMemoryDocuments, {}),
        () =>
          owner.query(memory.getMyMemoryDocument, {
            name: "memories/profile.md",
            kind: "profile" as const,
          }),
        () =>
          t.query(skillsInternal.listMirroredSkillsInternal, {
            ownerId: OWNER_ID,
            ownerGeneration: GENERATION,
            agentType: "orchestrator" as const,
          }),
      ];
      for (const call of calls) await expect(call()).rejects.toThrow();
      // The fence blocks reads without destroying the mirror: the device root
      // still holds this skill, so the row has to survive to be re-mirrored.
      const skill = await t.run(async (ctx) =>
        ctx.db
          .query("cloud_skills")
          .withIndex("by_skillId", (q) => q.eq("skillId", prepared.skillId))
          .unique(),
      );
      expect(skill?.revision).toBe(1);
    },
  );

  it("rejects a stale-generation mirror read after reset reopens the home", async () => {
    const t = createTest();
    await setLifecycle(t, "open");
    await uploadSkill(t);
    await setLifecycle(t, "open", "cloud-home-generation-2");
    await expect(
      t.query(skillsInternal.listMirroredSkillsInternal, {
        ownerId: OWNER_ID,
        ownerGeneration: GENERATION,
        agentType: "orchestrator",
      }),
    ).rejects.toThrow("before the account data was reset");
  });

  it("fails closed for a migrated source owner on reads", async () => {
    const t = createTest();
    await setLifecycle(t, "open");
    await uploadSkill(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("auth_owner_migrations", {
        fromOwnerId: OWNER_ID,
        toOwnerId: "https://issuer.test|destination",
        status: "pending",
        createdAt: 2_000,
        updatedAt: 2_000,
      });
    });
    const owner = asOwner(t);
    await expect(
      owner.query(skills.listMySkillHeads, {
        clientScope: "account:cloud-home-owner",
      }),
    ).rejects.toThrow("linked to an account");
    await expect(owner.query(memory.listMyMemoryDocuments, {})).rejects.toThrow(
      "linked to an account",
    );
    await expect(
      t.query(skillsInternal.listMirroredSkillsInternal, {
        ownerId: OWNER_ID,
        ownerGeneration: GENERATION,
        agentType: "orchestrator",
      }),
    ).rejects.toThrow("linked to an account");
  });
});
