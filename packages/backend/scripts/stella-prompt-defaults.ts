import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  STELLA_PROMPT_IDS,
  STELLA_PROMPT_MAX_CONTENT_BYTES,
  STELLA_PROMPT_MAX_TOTAL_CONTENT_BYTES,
} from "../convex/stella_prompt_contract";

export type StellaPromptSourceEntry = {
  id: (typeof STELLA_PROMPT_IDS)[number];
  runtimeSource: {
    kind: "agent-metadata" | "prompt";
    relativePath: string;
  };
};

export const STELLA_PROMPT_SOURCE_ENTRIES = [
  {
    id: "agents/orchestrator.md",
    runtimeSource: {
      kind: "agent-metadata",
      relativePath:
        "packages/runtime/extensions/stella-runtime/agent-metadata/orchestrator.md",
    },
  },
  {
    id: "agents/general.md",
    runtimeSource: {
      kind: "agent-metadata",
      relativePath:
        "packages/runtime/extensions/stella-runtime/agent-metadata/general.md",
    },
  },
  {
    id: "agents/fashion.md",
    runtimeSource: {
      kind: "agent-metadata",
      relativePath:
        "packages/runtime/extensions/stella-runtime/agent-metadata/fashion.md",
    },
  },
  {
    id: "agents/explore.md",
    runtimeSource: {
      kind: "agent-metadata",
      relativePath:
        "packages/runtime/extensions/stella-runtime/agent-metadata/explore.md",
    },
  },
  {
    id: "prompts/thread-compaction.md",
    runtimeSource: {
      kind: "prompt",
      relativePath:
        "packages/runtime/extensions/stella-runtime/prompts/thread-compaction.md",
    },
  },
  {
    id: "prompts/fallback-orchestrator.md",
    runtimeSource: {
      kind: "prompt",
      relativePath:
        "packages/runtime/extensions/stella-runtime/prompts/fallback-orchestrator.md",
    },
  },
  {
    id: "prompts/fallback-subagent.md",
    runtimeSource: {
      kind: "prompt",
      relativePath:
        "packages/runtime/extensions/stella-runtime/prompts/fallback-subagent.md",
    },
  },
  {
    id: "prompts/personality.md",
    runtimeSource: {
      kind: "prompt",
      relativePath:
        "packages/runtime/extensions/stella-runtime/prompts/personality.md",
    },
  },
] as const satisfies readonly StellaPromptSourceEntry[];

export const backendRoot = path.resolve(import.meta.dirname, "..");
export const repositoryRoot = path.resolve(backendRoot, "../..");
export const runtimePromptSourceRoot = path.join(
  repositoryRoot,
  "packages",
  "runtime",
  "extensions",
  "stella-runtime",
);
export const backendCloudPromptSourceRoot = path.join(
  backendRoot,
  "prompts",
  "stella-runtime",
);
export const generatedPromptDefaultsPath = path.join(
  backendRoot,
  "convex",
  "stella_prompt_defaults.generated.ts",
);

const compareIds = (left: { id: string }, right: { id: string }): number =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf-8");

const normalizedPromptBody = (value: string): string => `${value.trim()}\n`;

const expectedRuntimeRelativePath = (
  entry: StellaPromptSourceEntry,
): string => {
  const [scope, fileName, ...extra] = entry.id.split("/");
  const expectedScope =
    entry.runtimeSource.kind === "agent-metadata" ? "agents" : "prompts";
  if (scope !== expectedScope || !fileName || extra.length > 0) {
    throw new Error(
      `Canonical prompt ${entry.id} is incompatible with source kind ${entry.runtimeSource.kind}.`,
    );
  }
  const sourceDirectory =
    entry.runtimeSource.kind === "agent-metadata"
      ? "agent-metadata"
      : "prompts";
  return path.posix.join(
    "packages/runtime/extensions/stella-runtime",
    sourceDirectory,
    fileName,
  );
};

export const runtimePromptBody = (
  raw: string,
  kind: StellaPromptSourceEntry["runtimeSource"]["kind"],
  id: string,
): string => {
  let body = raw;
  if (kind === "agent-metadata") {
    const match = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n\r?\n/);
    if (!match) {
      throw new Error(
        `Runtime metadata for ${id} must have leading frontmatter followed by one blank separator line.`,
      );
    }
    body = raw.slice(match[0].length);
  }
  if (body !== normalizedPromptBody(body)) {
    throw new Error(
      `Runtime prompt source for ${id} must have no surrounding blank lines and one trailing newline.`,
    );
  }
  return body;
};

const assertSourceRoster = async (): Promise<void> => {
  const sourceIds = [...STELLA_PROMPT_SOURCE_ENTRIES]
    .map(({ id }) => id)
    .sort();
  const contractIds = [...STELLA_PROMPT_IDS].sort();
  if (sourceIds.join("\n") !== contractIds.join("\n")) {
    throw new Error(
      "Canonical prompt sources do not match the backend contract.",
    );
  }
  if (new Set(sourceIds).size !== sourceIds.length) {
    throw new Error("Canonical prompt sources contain duplicate ids.");
  }

  for (const entry of STELLA_PROMPT_SOURCE_ENTRIES) {
    const expectedPath = expectedRuntimeRelativePath(entry);
    if (entry.runtimeSource.relativePath !== expectedPath) {
      throw new Error(
        `Canonical prompt ${entry.id} must map to ${expectedPath}, not ${entry.runtimeSource.relativePath}.`,
      );
    }
  }

  const runtimeIds = [
    ...(await fs.readdir(path.join(runtimePromptSourceRoot, "agent-metadata")))
      .filter((name) => name.endsWith(".md") && name !== "README.md")
      .map((name) => `agents/${name}`),
    ...(await fs.readdir(path.join(runtimePromptSourceRoot, "prompts")))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `prompts/${name}`),
  ].sort();
  if (runtimeIds.join("\n") !== contractIds.join("\n")) {
    throw new Error(
      "Runtime prompt files do not match the backend prompt contract.",
    );
  }
};

export type GeneratedStellaPrompt = {
  id: string;
  sha256: string;
  content: string;
  sourceRevision: "backend-default";
  updatedAt: 0;
};

export type GeneratedStellaPromptDefaults = {
  revision: string;
  publishedAt: 0;
  prompts: GeneratedStellaPrompt[];
};

const renderProperty = (
  indent: string,
  key: string,
  value: string,
): string[] => {
  const line = `${indent}${key}: ${value},`;
  return line.length <= 80
    ? [line]
    : [`${indent}${key}:`, `${indent}  ${value},`];
};

const stringLiteral = (value: string): string => {
  const doubleQuotes = value.match(/"/g)?.length ?? 0;
  const singleQuotes = value.match(/'/g)?.length ?? 0;
  const json = JSON.stringify(value);
  if (doubleQuotes <= singleQuotes) return json;
  return `'${json.slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`;
};

const renderGeneratedSource = (
  snapshot: GeneratedStellaPromptDefaults,
): string => {
  const lines = [
    "/* Generated by scripts/sync-stella-prompt-defaults.ts. Do not edit. */",
    "export const STELLA_PROMPT_DEFAULTS = {",
    ...renderProperty("  ", "revision", stringLiteral(snapshot.revision)),
    "  publishedAt: 0,",
    "  prompts: [",
  ];
  for (const prompt of snapshot.prompts) {
    lines.push(
      "    {",
      ...renderProperty("      ", "id", stringLiteral(prompt.id)),
      ...renderProperty("      ", "sha256", stringLiteral(prompt.sha256)),
      ...renderProperty("      ", "content", stringLiteral(prompt.content)),
      '      sourceRevision: "backend-default",',
      "      updatedAt: 0,",
      "    },",
    );
  }
  lines.push("  ],", "} as const;", "");
  return lines.join("\n");
};

export const loadCanonicalStellaPrompts = async (): Promise<
  GeneratedStellaPrompt[]
> => {
  await assertSourceRoster();
  const prompts = await Promise.all(
    STELLA_PROMPT_SOURCE_ENTRIES.map(async (entry) => {
      const duplicateBackendPath = path.join(
        backendCloudPromptSourceRoot,
        entry.id,
      );
      const duplicateBackendSource = await fs
        .stat(duplicateBackendPath)
        .then((stat) => stat.isFile())
        .catch((error) => {
          if (error?.code === "ENOENT") return false;
          throw error;
        });
      if (duplicateBackendSource) {
        throw new Error(
          `Active runtime prompt ${entry.id} must not have a duplicate backend-owned source.`,
        );
      }

      const sourcePath = path.join(
        repositoryRoot,
        entry.runtimeSource.relativePath,
      );
      const content = runtimePromptBody(
        await fs.readFile(sourcePath, "utf-8"),
        entry.runtimeSource.kind,
        entry.id,
      );
      const contentBytes = utf8Bytes(content);
      if (contentBytes > STELLA_PROMPT_MAX_CONTENT_BYTES) {
        throw new Error(`Canonical prompt ${entry.id} exceeds the size limit.`);
      }

      return {
        id: entry.id,
        sha256: sha256(content),
        content,
        sourceRevision: "backend-default" as const,
        updatedAt: 0 as const,
      };
    }),
  );
  const totalBytes = prompts.reduce(
    (total, prompt) => total + utf8Bytes(prompt.content),
    0,
  );
  if (totalBytes > STELLA_PROMPT_MAX_TOTAL_CONTENT_BYTES) {
    throw new Error("Canonical prompt content exceeds the total size limit.");
  }
  return prompts.sort(compareIds);
};

export const buildStellaPromptDefaults = async (): Promise<{
  snapshot: GeneratedStellaPromptDefaults;
  source: string;
}> => {
  const prompts = await loadCanonicalStellaPrompts();
  const revision = sha256(
    prompts.map((prompt) => `${prompt.id}:${prompt.sha256}`).join("\n"),
  );
  const snapshot: GeneratedStellaPromptDefaults = {
    revision,
    publishedAt: 0,
    prompts,
  };
  return {
    snapshot,
    source: renderGeneratedSource(snapshot),
  };
};
