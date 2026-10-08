import { describe, expect, it } from "vitest";
import type {
  CloudHomeImportOwnership,
  CloudSkillHead,
  CloudSkillMirrorDeletion,
  LocalCloudHomeScan,
} from "@stella/contracts/cloud-home-sync";
import {
  cloudHomeCursorKey,
  cloudHomeStatusForAccount,
  runCloudHomeSync,
} from "@/features/cloud/cloud-home-sync";

const expectedSubject = "https://api.example.test|user";
const skill = {
  slug: "custom-research",
  name: "Custom research",
  description: "Use the local research process.",
  source: "desktop_sync" as const,
  availability: "both" as const,
  treeSha256: "b".repeat(64),
  fileCount: 1,
  totalSizeBytes: 80,
  files: [
    {
      path: "SKILL.md",
      contentType: "text/markdown; charset=utf-8",
      base64: "LS0tCm5hbWU6IFJlc2VhcmNoCi0tLQo=",
      sha256: "c".repeat(64),
      sizeBytes: 26,
    },
  ],
};

const otherSkill = {
  ...skill,
  slug: "custom-writing",
  name: "Custom writing",
  treeSha256: "f".repeat(64),
};

const scan: LocalCloudHomeScan = {
  schemaVersion: 1,
  skills: [skill],
  warnings: [],
};

const skillHead = (
  overrides: Partial<CloudSkillHead> = {},
): CloudSkillHead => ({
  skillId: "skill-custom-research",
  ownerGeneration: "generation-1",
  slug: skill.slug,
  name: skill.name,
  description: skill.description,
  source: "desktop_sync",
  availability: "both",
  revision: 1,
  versionId: "skillver-1",
  manifestSha256: "d".repeat(64),
  treeSha256: skill.treeSha256,
  fileCount: 1,
  totalSizeBytes: skill.totalSizeBytes,
  updatedAt: 1,
  ...overrides,
});

const prunes = (status: CloudSkillMirrorDeletion["status"] = "deleted") => {
  const requested: Array<{ slug: string; expectedRevision: number }> = [];
  return {
    requested,
    deleteSkillMirror: async (args: {
      slug: string;
      expectedRevision: number;
    }): Promise<CloudSkillMirrorDeletion> => {
      requested.push(args);
      return { status };
    },
  };
};

const cursorStore = () => {
  const values = new Map<string, string>();
  let importOwner: string | null = null;
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    readImportOwnership: async (
      accountScope: string,
    ): Promise<CloudHomeImportOwnership> =>
      !accountScope.startsWith("account:")
        ? "anonymous"
        : importOwner === null
          ? "unclaimed"
          : importOwner === accountScope
            ? "owned"
            : "other_owner",
    confirmImportOwnership: async (accountScope: string): Promise<boolean> => {
      if (!accountScope.startsWith("account:")) return false;
      if (importOwner === accountScope) return true;
      if (importOwner !== null) return false;
      importOwner = accountScope;
      return true;
    },
  };
};

describe("Cloud Home desktop reconciliation", () => {
  it("never exposes a previous account's item labels during a scope switch", () => {
    const prior = {
      accountScope: "account:previous",
      phase: "attention" as const,
      skillsUploaded: 0,
      skillsCloudWins: 1,
      skipped: 0,
      warnings: [
        {
          code: "read_failed" as const,
          path: "~/.stella/imports/private/client.md",
          message: "Private client note could not be read.",
        },
      ],
      issues: [
        {
          code: "cloud_conflict" as const,
          item: "private-client-skill",
          message: "Cloud copy kept.",
        },
      ],
    };
    const visible = cloudHomeStatusForAccount(prior, "account:next");
    expect(visible.accountScope).toBe("account:next");
    expect(visible.phase).toBe("idle");
    expect(visible.warnings).toEqual([]);
    expect(visible.issues).toEqual([]);
    expect(JSON.stringify(visible)).not.toContain("private");
  });

  it("binds one local corpus by explicit confirmation and fails closed for a different account", async () => {
    const cursor = cursorStore();
    let fetches = 0;
    let scans = 0;
    const base = {
      builderOrigin: "https://builder.example.test",
      token: "jwt",
      expectedSubject,
      scanLocal: async () => {
        scans += 1;
        return { ...scan, skills: [] };
      },
      readSkillHeads: async () => {
        fetches += 1;
        return [];
      },
      deleteSkillMirror: async () => ({ status: "deleted" as const }),
      cursorStore: cursor,
    };

    const first = await runCloudHomeSync({
      ...base,
      accountScope: "account:first-owner",
    });
    expect(first.phase).toBe("attention");
    expect(first.issues[0]?.code).toBe("import_confirmation_required");
    expect(fetches).toBe(0);
    expect(scans).toBe(0);

    expect(await cursor.confirmImportOwnership("account:first-owner")).toBe(
      true,
    );
    expect(await cursor.readImportOwnership("account:first-owner")).toBe(
      "owned",
    );
    const confirmed = await runCloudHomeSync({
      ...base,
      accountScope: "account:first-owner",
    });
    expect(confirmed.phase).toBe("complete");
    expect(fetches).toBe(1);
    expect(scans).toBe(1);

    // Restart and sign-out/sign-in retain the same stable user scope binding.
    const restarted = await runCloudHomeSync({
      ...base,
      accountScope: "account:first-owner",
    });
    expect(restarted.phase).toBe("complete");
    expect(fetches).toBe(2);
    expect(scans).toBe(2);

    const different = await runCloudHomeSync({
      ...base,
      accountScope: "account:second-owner",
    });
    expect(different.phase).toBe("unavailable");
    expect(different.issues[0]?.code).toBe("local_owner_mismatch");
    expect(fetches).toBe(2);
    expect(scans).toBe(2);
    expect(await cursor.confirmImportOwnership("account:second-owner")).toBe(
      false,
    );
  });

  it("fails closed with a distinct safe status for a corrupt owner marker", async () => {
    let fetches = 0;
    let scans = 0;
    const cursor = cursorStore();
    const status = await runCloudHomeSync({
      accountScope: "account:first-owner",
      builderOrigin: "https://builder.example.test",
      token: "jwt",
      expectedSubject,
      cursorStore: cursor,
      readImportOwnership: async () => "corrupt",
      readSkillHeads: async () => {
        fetches += 1;
        return [];
      },
      deleteSkillMirror: async () => ({ status: "deleted" as const }),
      scanLocal: async () => {
        scans += 1;
        return scan;
      },
    });
    expect(status.phase).toBe("unavailable");
    expect(status.issues[0]?.code).toBe("local_owner_record_invalid");
    expect(fetches).toBe(0);
    expect(scans).toBe(0);
  });

  it("uploads only missing local state, re-reads after response loss, and persists a content-free cursor", async () => {
    const cursor = cursorStore();
    const accountScope = "account:user-one";
    await cursor.confirmImportOwnership(accountScope);
    let cloudSkills: CloudSkillHead[] = [];
    const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      expect(init?.headers).toMatchObject({
        authorization: "Bearer jwt-one",
        "x-stella-expected-subject": expectedSubject,
      });
      expect(init?.redirect).toBe("error");
      if (url.pathname === "/cloud-home/skills/upload") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        writes.push({ path: url.pathname, body });
        cloudSkills = [skillHead()];
        // Simulate a transport loss after the server committed.
        throw new Error("socket closed");
      }
      return Response.json({ error: "unexpected" }, { status: 404 });
    };

    const status = await runCloudHomeSync({
      accountScope,
      builderOrigin: "https://builder.example.test",
      token: "jwt-one",
      expectedSubject,
      scanLocal: async () => scan,
      readSkillHeads: async () => cloudSkills,
      deleteSkillMirror: async () => ({ status: "deleted" as const }),
      cursorStore: cursor,
      fetch: fetchImpl,
      now: () => 1234,
    });

    expect(status).toMatchObject({
      phase: "complete",
      skillsUploaded: 1,
      skillsCloudWins: 0,
      lastCompletedAt: 1234,
    });
    expect(writes.map((write) => write.path)).toEqual([
      "/cloud-home/skills/upload",
    ]);
    expect(writes[0]?.body).toMatchObject({
      expectedRevision: 0,
      idempotencyKey: expect.stringMatching(/^desktop-skill-[0-9a-f]{48}$/),
    });
    const key = await cloudHomeCursorKey(accountScope);
    const persisted = cursor.values.get(key) ?? "";
    expect(persisted).toContain(skill.treeSha256);
    expect(persisted).not.toContain(accountScope);
    expect(persisted).not.toContain(skill.files[0]!.base64);
  });

  it("keeps divergent cloud heads authoritative and never sends a blind overwrite", async () => {
    const cursor = cursorStore();
    const accountScope = "account:user-two";
    await cursor.confirmImportOwnership(accountScope);
    const posted: string[] = [];
    const cloudSkills = [
      skillHead({
        revision: 4,
        versionId: "skillver-cloud",
        treeSha256: "8".repeat(64),
      }),
    ];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === "POST") posted.push(url.pathname);
      return Response.json({ status: "committed" });
    };

    const prune = prunes();
    const status = await runCloudHomeSync({
      accountScope,
      builderOrigin: "https://builder.example.test",
      token: "jwt-two",
      expectedSubject,
      scanLocal: async () => scan,
      readSkillHeads: async () => cloudSkills,
      deleteSkillMirror: prune.deleteSkillMirror,
      cursorStore: cursor,
      fetch: fetchImpl,
    });

    expect(posted).toEqual([]);
    expect(status).toMatchObject({
      phase: "attention",
      skillsCloudWins: 1,
    });
    expect(
      status.issues.every((issue) => issue.code === "cloud_conflict"),
    ).toBe(true);
    // The slug lost the race and lives only on this Mac, so the mirror keeps
    // the cloud copy instead of reading the loss as a device-root deletion.
    expect(prune.requested).toEqual([]);
  });

  it("removes a cloud skill this Mac no longer holds and forgets its cursor row", async () => {
    const cursor = cursorStore();
    const accountScope = "account:user-prune";
    await cursor.confirmImportOwnership(accountScope);
    const key = await cloudHomeCursorKey(accountScope);
    cursor.values.set(
      key,
      JSON.stringify({
        schemaVersion: 1,
        skills: {
          "removed-locally": {
            localTreeSha256: "e".repeat(64),
            cloudVersionId: "skillver-removed",
            cloudRevision: 3,
          },
        },
      }),
    );
    const prune = prunes();
    const status = await runCloudHomeSync({
      accountScope,
      builderOrigin: "https://builder.example.test",
      token: "jwt-prune",
      expectedSubject,
      scanLocal: async () => scan,
      readSkillHeads: async () => [
        skillHead(),
        skillHead({
          skillId: "skill-removed-locally",
          slug: "removed-locally",
          revision: 3,
          versionId: "skillver-removed",
          treeSha256: "e".repeat(64),
        }),
      ],
      deleteSkillMirror: prune.deleteSkillMirror,
      cursorStore: cursor,
    });

    expect(prune.requested).toEqual([
      { slug: "removed-locally", expectedRevision: 3 },
    ]);
    expect(status.phase).toBe("complete");
    expect(status.skillsCloudWins).toBe(0);
    expect(cursor.values.get(key) ?? "").not.toContain("removed-locally");
  });

  it("skips the prune entirely when a scan warning could hide a local skill", async () => {
    const cursor = cursorStore();
    const accountScope = "account:user-partial-scan";
    await cursor.confirmImportOwnership(accountScope);
    const prune = prunes();
    const status = await runCloudHomeSync({
      accountScope,
      builderOrigin: "https://builder.example.test",
      token: "jwt-partial-scan",
      expectedSubject,
      scanLocal: async () => ({
        ...scan,
        skills: [],
        warnings: [
          {
            code: "read_failed",
            path: "~/.stella/skills/custom-research",
            message: "The skill package could not be read.",
          },
        ],
      }),
      readSkillHeads: async () => [skillHead()],
      deleteSkillMirror: prune.deleteSkillMirror,
      cursorStore: cursor,
    });

    expect(prune.requested).toEqual([]);
    expect(status.phase).toBe("attention");
  });

  it("leaves a cloud skill that moved past the revision this pass observed", async () => {
    const cursor = cursorStore();
    const accountScope = "account:user-prune-race";
    await cursor.confirmImportOwnership(accountScope);
    const prune = prunes("conflict");
    const status = await runCloudHomeSync({
      accountScope,
      builderOrigin: "https://builder.example.test",
      token: "jwt-prune-race",
      expectedSubject,
      scanLocal: async () => ({ ...scan, skills: [] }),
      readSkillHeads: async () => [skillHead({ revision: 2 })],
      deleteSkillMirror: prune.deleteSkillMirror,
      cursorStore: cursor,
    });

    expect(prune.requested).toEqual([
      { slug: skill.slug, expectedRevision: 2 },
    ]);
    expect(status).toMatchObject({ phase: "attention", skillsCloudWins: 1 });
    expect(status.issues).toContainEqual(
      expect.objectContaining({ code: "cloud_conflict", item: skill.slug }),
    );
  });

  it("reports a prune that never reached the cloud instead of claiming success", async () => {
    const cursor = cursorStore();
    const accountScope = "account:user-prune-offline";
    await cursor.confirmImportOwnership(accountScope);
    const status = await runCloudHomeSync({
      accountScope,
      builderOrigin: "https://builder.example.test",
      token: "jwt-prune-offline",
      expectedSubject,
      scanLocal: async () => ({ ...scan, skills: [] }),
      readSkillHeads: async () => [skillHead()],
      deleteSkillMirror: async () => {
        throw new Error("offline");
      },
      cursorStore: cursor,
    });

    expect(status.phase).toBe("attention");
    expect(status.issues).toContainEqual(
      expect.objectContaining({
        code: "verification_failed",
        item: skill.slug,
      }),
    );
  });

  it("resumes after partial failure without re-uploading a confirmed package", async () => {
    const cursor = cursorStore();
    const accountScope = "account:user-three";
    await cursor.confirmImportOwnership(accountScope);
    let cloudSkills: CloudSkillHead[] = [];
    const posts = new Map<string, number>();
    let allowSkillCommit = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/cloud-home/skills/upload") {
        const body = JSON.parse(String(init?.body)) as { slug: string };
        posts.set(body.slug, (posts.get(body.slug) ?? 0) + 1);
        const commits = body.slug === otherSkill.slug || allowSkillCommit;
        if (commits) {
          cloudSkills = [
            ...cloudSkills.filter((head) => head.slug !== body.slug),
            body.slug === otherSkill.slug
              ? skillHead({
                  skillId: "skill-custom-writing",
                  slug: otherSkill.slug,
                  treeSha256: otherSkill.treeSha256,
                })
              : skillHead(),
          ];
        }
        return Response.json(
          { status: commits ? "committed" : "conflict" },
          { status: commits ? 200 : 409 },
        );
      }
      return Response.json({ error: "unexpected" }, { status: 404 });
    };
    const options = {
      accountScope,
      builderOrigin: "https://builder.example.test",
      token: "jwt-three",
      expectedSubject,
      scanLocal: async () => ({ ...scan, skills: [otherSkill, skill] }),
      readSkillHeads: async () => cloudSkills,
      deleteSkillMirror: async () => ({ status: "deleted" as const }),
      cursorStore: cursor,
      fetch: fetchImpl,
    };

    const first = await runCloudHomeSync(options);
    expect(first.phase).toBe("attention");
    expect(first.skillsUploaded).toBe(1);
    expect(posts.get(otherSkill.slug)).toBe(1);
    expect(posts.get(skill.slug)).toBe(1);

    allowSkillCommit = true;
    const second = await runCloudHomeSync(options);
    expect(second.phase).toBe("complete");
    expect(posts.get(otherSkill.slug)).toBe(1);
    expect(posts.get(skill.slug)).toBe(2);
    expect(second.skillsUploaded).toBe(1);
  });

  it("does not mark an account-switched partial pass complete", async () => {
    const cursor = cursorStore();
    const accountScope = "account:user-four";
    await cursor.confirmImportOwnership(accountScope);
    const controller = new AbortController();
    const status = await runCloudHomeSync({
      accountScope,
      builderOrigin: "https://builder.example.test",
      token: "jwt-four",
      expectedSubject,
      scanLocal: async () => ({ ...scan, skills: [skill, otherSkill] }),
      readSkillHeads: async () => [
        skillHead(),
        skillHead({
          skillId: "skill-custom-writing",
          slug: otherSkill.slug,
          treeSha256: otherSkill.treeSha256,
        }),
      ],
      deleteSkillMirror: async () => ({ status: "deleted" as const }),
      cursorStore: cursor,
      signal: controller.signal,
      onStatus: (next) => {
        if (next.skipped === 1) controller.abort();
      },
      now: () => 9999,
    });

    expect(status.phase).toBe("idle");
    expect(status.lastCompletedAt).toBeUndefined();
    const persisted = [...cursor.values.values()].join("\n");
    expect(persisted).not.toContain("9999");
  });

  it("sanitizes corrupted cursor rows into bounded clean records", async () => {
    const cursor = cursorStore();
    const accountScope = "account:user-five";
    await cursor.confirmImportOwnership(accountScope);
    const key = await cloudHomeCursorKey(accountScope);
    cursor.values.set(
      key,
      JSON.stringify({
        schemaVersion: 1,
        ownerGeneration: "generation-1",
        memories: {
          bad: { localSha256: { nested: true }, cloudRevision: -10 },
          "../escape.md": {
            localSha256: "1".repeat(64),
            cloudRevision: 1,
          },
        },
        skills: {
          BAD: { localTreeSha256: "2".repeat(64), cloudRevision: 1 },
        },
      }),
    );

    const status = await runCloudHomeSync({
      accountScope,
      builderOrigin: "https://builder.example.test",
      token: "jwt-five",
      expectedSubject,
      scanLocal: async () => scan,
      readSkillHeads: async () => [skillHead()],
      deleteSkillMirror: async () => ({ status: "deleted" as const }),
      cursorStore: cursor,
    });

    expect(status.phase).toBe("complete");
    const persisted = cursor.values.get(key) ?? "";
    expect(persisted).not.toContain("nested");
    expect(persisted).not.toContain("../escape.md");
    expect(persisted).not.toContain('"BAD"');
    expect(persisted).toContain(skill.slug);
  });

  it("keeps account cancellation active while a response body is still streaming", async () => {
    const controller = new AbortController();
    const cursor = cursorStore();
    const accountScope = "account:user-six";
    await cursor.confirmImportOwnership(accountScope);
    const fetchImpl: typeof fetch = async () => {
      setTimeout(() => controller.abort(), 0);
      return new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{"status":'));
          },
        }),
      );
    };
    const status = await runCloudHomeSync({
      accountScope,
      builderOrigin: "https://builder.example.test",
      token: "jwt-six",
      expectedSubject,
      scanLocal: async () => scan,
      readSkillHeads: async () => [],
      deleteSkillMirror: async () => ({ status: "deleted" as const }),
      cursorStore: cursor,
      fetch: fetchImpl,
      signal: controller.signal,
    });
    expect(status.lastCompletedAt).toBeUndefined();
    expect(status.phase).toBe("idle");
  });
});
