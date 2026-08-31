import { describe, expect, it } from "vitest";
import type {
  CloudHomeImportOwnership,
  CloudMemoryDocument,
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
const memoryEpoch = "memory-epoch-1";
const memoryLifecycle = {
  memoryEpoch,
  importDisposition: "automatic_allowed" as const,
};

const memory = {
  name: "memories/profile.md",
  displayPath: "~/.stella/memories/profile.md",
  kind: "profile" as const,
  source: "legacy_local" as const,
  content: "# User Profile\n\n- Name: Ada\n",
  sha256: "a".repeat(64),
  sizeBytes: 29,
};

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

const scan: LocalCloudHomeScan = {
  schemaVersion: 1,
  memories: [memory],
  skills: [skill],
  warnings: [],
};

const memoryHead = (
  overrides: Partial<CloudMemoryDocument> = {},
): CloudMemoryDocument => ({
  documentId: "memdoc-profile",
  name: memory.name,
  displayPath: memory.displayPath,
  kind: memory.kind,
  source: "legacy_local",
  revision: 1,
  versionId: "memver-1",
  sha256: memory.sha256,
  sizeBytes: memory.sizeBytes,
  updatedAt: 1,
  content: memory.content,
  ...overrides,
});

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
      memoryUploaded: 0,
      memoryCloudWins: 1,
      skillsUploaded: 0,
      skillsCloudWins: 0,
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
    const fetchImpl: typeof fetch = async () => {
      fetches += 1;
      return Response.json({
        subject: expectedSubject,
        ownerGeneration: "generation-1",
        ...memoryLifecycle,
        documents: [],
      });
    };
    const base = {
      builderOrigin: "https://builder.example.test",
      token: "jwt",
      expectedSubject,
      scanLocal: async () => {
        scans += 1;
        return { ...scan, memories: [], skills: [] };
      },
      readSkillHeads: async () => [],
      deleteSkillMirror: async () => ({ status: "deleted" as const }),
      cursorStore: cursor,
      fetch: fetchImpl,
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
      readSkillHeads: async () => [],
      deleteSkillMirror: async () => ({ status: "deleted" as const }),
      scanLocal: async () => {
        scans += 1;
        return scan;
      },
      fetch: async () => {
        fetches += 1;
        return Response.json({
          subject: expectedSubject,
          ownerGeneration: "generation-1",
          ...memoryLifecycle,
          documents: [],
        });
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
    let cloudMemory: CloudMemoryDocument[] = [];
    let cloudSkills: CloudSkillHead[] = [];
    const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      expect(init?.headers).toMatchObject({
        authorization: "Bearer jwt-one",
        "x-stella-expected-subject": expectedSubject,
      });
      expect(init?.redirect).toBe("error");
      if (url.pathname === "/cloud-home/memory") {
        return Response.json({
          subject: expectedSubject,
          ownerGeneration: "generation-1",
          ...memoryLifecycle,
          documents: cloudMemory,
        });
      }
      if (url.pathname === "/cloud-home/memory/write") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        writes.push({ path: url.pathname, body });
        cloudMemory = [memoryHead()];
        // Simulate a transport loss after the server committed.
        throw new Error("socket closed");
      }
      if (url.pathname === "/cloud-home/skills/upload") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        writes.push({ path: url.pathname, body });
        cloudSkills = [skillHead()];
        return Response.json({ status: "committed" });
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
      memoryUploaded: 1,
      skillsUploaded: 1,
      memoryCloudWins: 0,
      skillsCloudWins: 0,
      lastCompletedAt: 1234,
    });
    expect(writes.map((write) => write.path)).toEqual([
      "/cloud-home/memory/write",
      "/cloud-home/skills/upload",
    ]);
    expect(writes[0]?.body).toMatchObject({
      expectedOwnerGeneration: "generation-1",
      expectedMemoryEpoch: memoryEpoch,
      expectedRevision: 0,
      writer: "desktop_sync",
      idempotencyKey: expect.stringMatching(/^desktop-memory-[0-9a-f]{48}$/),
    });
    expect(writes[1]?.body).toMatchObject({
      expectedRevision: 0,
      idempotencyKey: expect.stringMatching(/^desktop-skill-[0-9a-f]{48}$/),
    });
    const key = await cloudHomeCursorKey(accountScope);
    const persisted = cursor.values.get(key) ?? "";
    expect(persisted).toContain("generation-1");
    expect(persisted).not.toContain(accountScope);
    expect(persisted).not.toContain(memory.content);
    expect(persisted).not.toContain(skill.files[0]!.base64);
  });

  it("blocks automatic Memory reimport after a wipe while continuing skill sync", async () => {
    const cursor = cursorStore();
    const accountScope = "account:post-wipe";
    await cursor.confirmImportOwnership(accountScope);
    let cloudSkills: CloudSkillHead[] = [];
    let memoryWrites = 0;
    let skillWrites = 0;
    const status = await runCloudHomeSync({
      accountScope,
      builderOrigin: "https://builder.example.test",
      token: "jwt-post-wipe",
      expectedSubject,
      scanLocal: async () => scan,
      readSkillHeads: async () => cloudSkills,
      deleteSkillMirror: async () => ({ status: "deleted" as const }),
      cursorStore: cursor,
      fetch: async (input) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname === "/cloud-home/memory") {
          return Response.json({
            subject: expectedSubject,
            ownerGeneration: "generation-1",
            memoryEpoch: "memory-epoch-2",
            importDisposition: "explicit_required",
            lastWipedEpoch: memoryEpoch,
            documents: [],
          });
        }
        if (pathname === "/cloud-home/memory/write") {
          memoryWrites += 1;
        }
        if (pathname === "/cloud-home/skills/upload") {
          skillWrites += 1;
          cloudSkills = [skillHead()];
          return Response.json({ status: "committed" });
        }
        return Response.json({ error: "unexpected" }, { status: 404 });
      },
    });

    expect(memoryWrites).toBe(0);
    expect(skillWrites).toBe(1);
    expect(status.skillsUploaded).toBe(1);
    expect(status.issues).toContainEqual(
      expect.objectContaining({
        code: "memory_reimport_confirmation_required",
      }),
    );
    expect(status.phase).toBe("attention");
  });

  it("stops the pass when the authoritative Memory epoch changes during verification", async () => {
    const cursor = cursorStore();
    const accountScope = "account:epoch-race";
    await cursor.confirmImportOwnership(accountScope);
    let afterWrite = false;
    let skillWrites = 0;
    const status = await runCloudHomeSync({
      accountScope,
      builderOrigin: "https://builder.example.test",
      token: "jwt-epoch-race",
      expectedSubject,
      scanLocal: async () => scan,
      readSkillHeads: async () => [],
      deleteSkillMirror: async () => ({ status: "deleted" as const }),
      cursorStore: cursor,
      fetch: async (input) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname === "/cloud-home/memory") {
          return Response.json({
            subject: expectedSubject,
            ownerGeneration: "generation-1",
            memoryEpoch: afterWrite ? "memory-epoch-2" : memoryEpoch,
            importDisposition: afterWrite
              ? "explicit_required"
              : "automatic_allowed",
            documents: [],
          });
        }
        if (pathname === "/cloud-home/memory/write") {
          afterWrite = true;
          return Response.json({ status: "committed" });
        }
        if (pathname === "/cloud-home/skills/upload") skillWrites += 1;
        return Response.json({ status: "committed" });
      },
    });

    expect(status.phase).toBe("unavailable");
    expect(status.issues).toContainEqual(
      expect.objectContaining({ code: "verification_failed" }),
    );
    expect(skillWrites).toBe(0);
  });

  it("keeps divergent cloud heads authoritative and never sends a blind overwrite", async () => {
    const cursor = cursorStore();
    const accountScope = "account:user-two";
    await cursor.confirmImportOwnership(accountScope);
    const posted: string[] = [];
    const cloudMemory = [
      memoryHead({
        revision: 7,
        versionId: "memver-cloud",
        sha256: "9".repeat(64),
        content: "cloud authority",
      }),
    ];
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
      return Response.json({
        subject: expectedSubject,
        ownerGeneration: "generation-1",
        ...memoryLifecycle,
        documents: cloudMemory,
      });
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
      memoryCloudWins: 1,
      skillsCloudWins: 1,
    });
    expect(
      status.issues.every((issue) => issue.code === "cloud_conflict"),
    ).toBe(true);
    expect(JSON.stringify(status)).not.toContain("cloud authority");
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
        ownerGeneration: "generation-1",
        memories: {},
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
      scanLocal: async () => ({ ...scan, memories: [] }),
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
      fetch: async () =>
        Response.json({
          subject: expectedSubject,
          ownerGeneration: "generation-1",
          ...memoryLifecycle,
          documents: [],
        }),
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
        memories: [],
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
      fetch: async () =>
        Response.json({
          subject: expectedSubject,
          ownerGeneration: "generation-1",
          ...memoryLifecycle,
          documents: [],
        }),
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
      scanLocal: async () => ({ ...scan, memories: [], skills: [] }),
      readSkillHeads: async () => [skillHead({ revision: 2 })],
      deleteSkillMirror: prune.deleteSkillMirror,
      cursorStore: cursor,
      fetch: async () =>
        Response.json({
          subject: expectedSubject,
          ownerGeneration: "generation-1",
          ...memoryLifecycle,
          documents: [],
        }),
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
      scanLocal: async () => ({ ...scan, memories: [], skills: [] }),
      readSkillHeads: async () => [skillHead()],
      deleteSkillMirror: async () => {
        throw new Error("offline");
      },
      cursorStore: cursor,
      fetch: async () =>
        Response.json({
          subject: expectedSubject,
          ownerGeneration: "generation-1",
          ...memoryLifecycle,
          documents: [],
        }),
    });

    expect(status.phase).toBe("attention");
    expect(status.issues).toContainEqual(
      expect.objectContaining({
        code: "verification_failed",
        item: skill.slug,
      }),
    );
  });

  it("resumes after partial failure without re-uploading a confirmed document", async () => {
    const cursor = cursorStore();
    const accountScope = "account:user-three";
    await cursor.confirmImportOwnership(accountScope);
    let cloudMemory: CloudMemoryDocument[] = [];
    let cloudSkills: CloudSkillHead[] = [];
    let memoryPosts = 0;
    let skillPosts = 0;
    let allowSkillCommit = false;
    const fetchImpl: typeof fetch = async (input, _init) => {
      const url = new URL(String(input));
      if (url.pathname === "/cloud-home/memory") {
        return Response.json({
          subject: expectedSubject,
          ownerGeneration: "generation-1",
          ...memoryLifecycle,
          documents: cloudMemory,
        });
      }
      if (url.pathname === "/cloud-home/memory/write") {
        memoryPosts += 1;
        cloudMemory = [memoryHead()];
        return Response.json({ status: "committed" });
      }
      if (url.pathname === "/cloud-home/skills/upload") {
        skillPosts += 1;
        if (allowSkillCommit) cloudSkills = [skillHead()];
        return Response.json(
          { status: allowSkillCommit ? "committed" : "conflict" },
          {
            status: allowSkillCommit ? 200 : 409,
          },
        );
      }
      return Response.json({ error: "unexpected" }, { status: 404 });
    };
    const options = {
      accountScope,
      builderOrigin: "https://builder.example.test",
      token: "jwt-three",
      expectedSubject,
      scanLocal: async () => scan,
      readSkillHeads: async () => cloudSkills,
      deleteSkillMirror: async () => ({ status: "deleted" as const }),
      cursorStore: cursor,
      fetch: fetchImpl,
    };

    const first = await runCloudHomeSync(options);
    expect(first.phase).toBe("attention");
    expect(memoryPosts).toBe(1);
    expect(skillPosts).toBe(1);

    allowSkillCommit = true;
    const second = await runCloudHomeSync(options);
    expect(second.phase).toBe("complete");
    expect(second.memoryUploaded).toBe(0);
    expect(memoryPosts).toBe(1);
    expect(skillPosts).toBe(2);
    expect(second.skillsUploaded).toBe(1);
  });

  it("does not mark an account-switched partial pass complete", async () => {
    const cursor = cursorStore();
    const accountScope = "account:user-four";
    await cursor.confirmImportOwnership(accountScope);
    const controller = new AbortController();
    const matchingMemory = memoryHead();
    const status = await runCloudHomeSync({
      accountScope,
      builderOrigin: "https://builder.example.test",
      token: "jwt-four",
      expectedSubject,
      scanLocal: async () => ({
        ...scan,
        memories: [memory, { ...memory, name: "MEMORY.md", kind: "memory" }],
        skills: [],
      }),
      readSkillHeads: async () => [],
      deleteSkillMirror: async () => ({ status: "deleted" as const }),
      cursorStore: cursor,
      signal: controller.signal,
      onStatus: (next) => {
        if (next.skipped === 1) controller.abort();
      },
      fetch: async () =>
        Response.json({
          subject: expectedSubject,
          ownerGeneration: "generation-1",
          ...memoryLifecycle,
          documents: [matchingMemory],
        }),
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
      scanLocal: async () => ({ ...scan, skills: [] }),
      readSkillHeads: async () => [],
      deleteSkillMirror: async () => ({ status: "deleted" as const }),
      cursorStore: cursor,
      fetch: async () =>
        Response.json({
          subject: expectedSubject,
          ownerGeneration: "generation-1",
          ...memoryLifecycle,
          documents: [memoryHead()],
        }),
    });

    expect(status.phase).toBe("complete");
    const persisted = cursor.values.get(key) ?? "";
    expect(persisted).not.toContain("nested");
    expect(persisted).not.toContain("../escape.md");
    expect(persisted).not.toContain('"BAD"');
    expect(persisted).toContain("memories/profile.md");
  });

  it("keeps account cancellation active while a response body is still streaming", async () => {
    const controller = new AbortController();
    const cursor = cursorStore();
    const accountScope = "account:user-six";
    await cursor.confirmImportOwnership(accountScope);
    const fetchImpl: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(
              new TextEncoder().encode(
                '{"ownerGeneration":"generation-1","documents":',
              ),
            );
          },
        }),
      );
    const pending = runCloudHomeSync({
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
    await Promise.resolve();
    controller.abort();
    const status = await pending;
    expect(status.lastCompletedAt).toBeUndefined();
    expect(status.phase).toBe("unavailable");
  });
});
