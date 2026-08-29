/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import type { FunctionReference } from "convex/server";
import { describe, expect, it } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { hashSha256Hex } from "./lib/crypto_utils";

const modules = import.meta.glob("./**/*.ts");
const createTest = () => convexTest(schema, modules);
const OWNER_ID = "https://issuer.test|skill-owner";
const GENERATION = "skill-owner-generation-1";
const CLIENT_SCOPE = "account:skill-owner";

type SkillHead = {
  skillId: string;
  slug: string;
  revision: number;
  versionId?: string;
  treeSha256?: string;
};

type MirrorDeletion = {
  skillId: string;
  status: "deleted" | "conflict";
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
      deleteMyMirroredSkill: FunctionReference<
        "mutation",
        "public",
        { clientScope: string; slug: string; expectedRevision: number },
        MirrorDeletion
      >;
    };
  }
).cloud_skills;

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
          nextRevision: number;
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
        { status: string; nextRevision: number }
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
    subject: "skill-owner",
    tokenIdentifier: OWNER_ID,
  });

const openLifecycle = async (t: ReturnType<typeof createTest>) => {
  await t.run(async (ctx) => {
    await ctx.db.insert("cloud_owner_lifecycles", {
      ownerId: OWNER_ID,
      generation: GENERATION,
      state: "open",
      updatedAt: 1_000,
      createdAt: 1_000,
    });
  });
};

const uploadSkill = async (
  t: ReturnType<typeof createTest>,
  options: { slug?: string; fileByte?: string; now?: number } = {},
) => {
  const slug = options.slug ?? "calendar";
  const fileSha256 = (options.fileByte ?? "1").repeat(64);
  const now = options.now ?? 1_000;
  const treeSha256 = await hashSha256Hex(
    ["SKILL.md", fileSha256, "1", "text/markdown\n"].join("\0"),
  );
  const prepared = await t.mutation(skillsInternal.beginSkillWriteInternal, {
    ownerId: OWNER_ID,
    ownerGeneration: GENERATION,
    slug,
    name: `Skill ${slug}`,
    description: "Use the existing tools safely.",
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
    idempotencyKey: `desktop-skill-${slug}-${fileSha256.slice(0, 8)}`,
    now,
  });
  const committed = await t.mutation(
    skillsInternal.commitSkillWriteInternal,
    {
      ownerId: OWNER_ID,
      ownerGeneration: GENERATION,
      intentId: prepared.intentId,
      versionId: prepared.versionId,
      manifestR2Key: prepared.manifestR2Key,
      manifestSha256: prepared.manifestSha256,
      treeSha256: prepared.treeSha256,
      now: now + 1,
    },
  );
  return { ...prepared, committedRevision: committed.nextRevision };
};

const headRow = async (t: ReturnType<typeof createTest>, skillId: string) =>
  await t.run(async (ctx) =>
    ctx.db
      .query("cloud_skills")
      .withIndex("by_skillId", (q) => q.eq("skillId", skillId))
      .unique(),
  );

describe("Cloud skill mirror deletion", () => {
  it("tombstones the head and hides it from both mirror readers", async () => {
    const t = createTest();
    await openLifecycle(t);
    const uploaded = await uploadSkill(t);
    const owner = asOwner(t);

    await expect(
      owner.mutation(skills.deleteMyMirroredSkill, {
        clientScope: CLIENT_SCOPE,
        slug: "calendar",
        expectedRevision: 1,
      }),
    ).resolves.toEqual({
      skillId: uploaded.skillId,
      status: "deleted",
      revision: 1,
    });

    await expect(
      owner.query(skills.listMySkillHeads, { clientScope: CLIENT_SCOPE }),
    ).resolves.toEqual([]);
    await expect(
      t.query(skillsInternal.listMirroredSkillsInternal, {
        ownerId: OWNER_ID,
        ownerGeneration: GENERATION,
        agentType: "orchestrator",
      }),
    ).resolves.toEqual([]);
    const row = await headRow(t, uploaded.skillId);
    expect(row?.deletedAt).toEqual(expect.any(Number));
  });

  it("keeps a head that advanced past the revision the device observed", async () => {
    const t = createTest();
    await openLifecycle(t);
    const uploaded = await uploadSkill(t);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("cloud_skills")
        .withIndex("by_skillId", (q) => q.eq("skillId", uploaded.skillId))
        .unique();
      await ctx.db.patch(row!._id, { revision: 2, updatedAt: 3_000 });
    });
    const owner = asOwner(t);

    await expect(
      owner.mutation(skills.deleteMyMirroredSkill, {
        clientScope: CLIENT_SCOPE,
        slug: "calendar",
        expectedRevision: 1,
      }),
    ).resolves.toEqual({
      skillId: uploaded.skillId,
      status: "conflict",
      revision: 2,
    });
    const row = await headRow(t, uploaded.skillId);
    expect(row?.deletedAt).toBeUndefined();
    await expect(
      owner.query(skills.listMySkillHeads, { clientScope: CLIENT_SCOPE }),
    ).resolves.toMatchObject([{ slug: "calendar", revision: 2 }]);
  });

  it("reports the same result for a replayed prune and for a slug the mirror never held", async () => {
    const t = createTest();
    await openLifecycle(t);
    const uploaded = await uploadSkill(t);
    const owner = asOwner(t);
    const prune = () =>
      owner.mutation(skills.deleteMyMirroredSkill, {
        clientScope: CLIENT_SCOPE,
        slug: "calendar",
        expectedRevision: 1,
      });

    await prune();
    const tombstonedAt = (await headRow(t, uploaded.skillId))?.deletedAt;
    await expect(prune()).resolves.toMatchObject({ status: "deleted" });
    expect((await headRow(t, uploaded.skillId))?.deletedAt).toBe(tombstonedAt);
    await expect(
      owner.mutation(skills.deleteMyMirroredSkill, {
        clientScope: CLIENT_SCOPE,
        slug: "never-uploaded",
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ status: "deleted", revision: 0 });
  });

  it("re-mirrors a deleted skill when the identical package comes back to the device root", async () => {
    const t = createTest();
    await openLifecycle(t);
    const uploaded = await uploadSkill(t);
    const owner = asOwner(t);
    await owner.mutation(skills.deleteMyMirroredSkill, {
      clientScope: CLIENT_SCOPE,
      slug: "calendar",
      expectedRevision: 1,
    });

    // The device sees no head, so it re-uploads from revision 0 under the same
    // content-derived idempotency key the first upload used.
    const restored = await uploadSkill(t, { now: 5_000 });
    expect(restored.skillId).toBe(uploaded.skillId);
    await expect(
      owner.query(skills.listMySkillHeads, { clientScope: CLIENT_SCOPE }),
    ).resolves.toMatchObject([
      { slug: "calendar", revision: 1, versionId: restored.versionId },
    ]);
    await expect(
      t.query(skillsInternal.listMirroredSkillsInternal, {
        ownerId: OWNER_ID,
        ownerGeneration: GENERATION,
        agentType: "orchestrator",
      }),
    ).resolves.toMatchObject([{ skillId: uploaded.skillId }]);
  });

  it("re-mirrors a deleted skill whose package changed while it was gone", async () => {
    const t = createTest();
    await openLifecycle(t);
    const uploaded = await uploadSkill(t);
    const owner = asOwner(t);
    await owner.mutation(skills.deleteMyMirroredSkill, {
      clientScope: CLIENT_SCOPE,
      slug: "calendar",
      expectedRevision: 1,
    });

    const restored = await uploadSkill(t, { fileByte: "3", now: 6_000 });
    expect(restored.versionId).not.toBe(uploaded.versionId);
    await expect(
      owner.query(skills.listMySkillHeads, { clientScope: CLIENT_SCOPE }),
    ).resolves.toMatchObject([
      { slug: "calendar", revision: 1, versionId: restored.versionId },
    ]);
  });

  it("refuses an unauthenticated prune and leaves another account's mirror alone", async () => {
    const t = createTest();
    await openLifecycle(t);
    const uploaded = await uploadSkill(t);

    await expect(
      t.mutation(skills.deleteMyMirroredSkill, {
        clientScope: CLIENT_SCOPE,
        slug: "calendar",
        expectedRevision: 1,
      }),
    ).rejects.toThrow();

    const stranger = t.withIdentity({
      issuer: "https://issuer.test",
      subject: "other-owner",
      tokenIdentifier: "https://issuer.test|other-owner",
    });
    await expect(
      stranger.mutation(skills.deleteMyMirroredSkill, {
        clientScope: "account:other-owner",
        slug: "calendar",
        expectedRevision: 1,
      }),
    ).resolves.toMatchObject({ status: "deleted", revision: 0 });
    expect((await headRow(t, uploaded.skillId))?.deletedAt).toBeUndefined();
  });

  it("rejects a prune that names a revision no head could ever have published", async () => {
    const t = createTest();
    await openLifecycle(t);
    await uploadSkill(t);
    const owner = asOwner(t);
    await expect(
      owner.mutation(skills.deleteMyMirroredSkill, {
        clientScope: CLIENT_SCOPE,
        slug: "calendar",
        expectedRevision: 0,
      }),
    ).rejects.toThrow("published revision");
    await expect(
      owner.mutation(skills.deleteMyMirroredSkill, {
        clientScope: "   ",
        slug: "calendar",
        expectedRevision: 1,
      }),
    ).rejects.toThrow("client scope");
  });

  it("frees the installed-skill budget the moment a skill leaves the device root", async () => {
    const t = createTest();
    await openLifecycle(t);
    const uploaded = await uploadSkill(t);
    const owner = asOwner(t);
    await owner.mutation(skills.deleteMyMirroredSkill, {
      clientScope: CLIENT_SCOPE,
      slug: "calendar",
      expectedRevision: 1,
    });
    await uploadSkill(t, { slug: "notes", now: 7_000 });

    const live = await owner.query(skills.listMySkillHeads, {
      clientScope: CLIENT_SCOPE,
    });
    expect(live.map((head) => head.slug)).toEqual(["notes"]);
    expect((await headRow(t, uploaded.skillId))?.deletedAt).toEqual(
      expect.any(Number),
    );
  });
});
