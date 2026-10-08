/**
 * Bundle Stella's system prompts into cloud-builder.
 *
 * Reads the runtime-owned prompt sources, strips agent frontmatter, validates
 * condition fences (`renderStellaPrompt` in @stella/contracts/stella-prompts)
 * and writes `src/prompts/defaults.generated.ts`, which cloud turns import
 * directly and `GET /api/stella/prompts` serves to desktop. Sources are
 * bundled raw; each consumer renders them for its environment and tools.
 * Publishing a prompt change is deploying cloud-builder. `--check` fails when
 * the generated file drifts.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  hasStellaPromptFences,
  STELLA_PROMPT_IDS,
  STELLA_PROMPT_MAX_CONTENT_BYTES,
  STELLA_PROMPT_MAX_TOTAL_CONTENT_BYTES,
  validateStellaPromptFences,
} from "@stella/contracts/stella-prompts";

type PromptSourceKind = "agent-metadata" | "prompt";

const SOURCE_KIND: Record<string, PromptSourceKind> = {
  agents: "agent-metadata",
  prompts: "prompt",
};

const workerRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(workerRoot, "../..");
const runtimePromptSourceRoot = path.join(
  repositoryRoot,
  "packages",
  "runtime",
  "extensions",
  "stella-runtime",
);
const generatedPath = path.join(
  workerRoot,
  "src",
  "prompts",
  "defaults.generated.ts",
);

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf-8");

const sourcePathFor = (id: string): { kind: PromptSourceKind; path: string } => {
  const [scope, fileName, ...extra] = id.split("/");
  const kind = scope ? SOURCE_KIND[scope] : undefined;
  if (!kind || !fileName || extra.length > 0) {
    throw new Error(`Canonical prompt id ${id} has no runtime source.`);
  }
  return {
    kind,
    path: path.join(
      runtimePromptSourceRoot,
      kind === "agent-metadata" ? "agent-metadata" : "prompts",
      fileName,
    ),
  };
};

const promptBody = (raw: string, kind: PromptSourceKind, id: string): string => {
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
  if (body !== `${body.trim()}\n`) {
    throw new Error(
      `Runtime prompt source for ${id} must have no surrounding blank lines and one trailing newline.`,
    );
  }
  // Every consumer renders agent prompts through `renderStellaPrompt`, so a
  // fence there must be well formed; nothing renders the auxiliary prompts,
  // so a fence there would reach a model verbatim.
  if (kind === "agent-metadata") {
    const errors = validateStellaPromptFences(body);
    if (errors.length > 0) {
      throw new Error(
        `Condition fences in ${id} are invalid:\n${errors.map((error) => `  ${error}`).join("\n")}`,
      );
    }
  } else if (hasStellaPromptFences(body)) {
    throw new Error(
      `${id} has condition fences; only agents/*.md prompts are rendered.`,
    );
  }
  return body;
};

const assertSourceRoster = async (): Promise<void> => {
  const runtimeIds = [
    ...(await fs.readdir(path.join(runtimePromptSourceRoot, "agent-metadata")))
      .filter((name) => name.endsWith(".md") && name !== "README.md")
      .map((name) => `agents/${name}`),
    ...(await fs.readdir(path.join(runtimePromptSourceRoot, "prompts")))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `prompts/${name}`),
  ].sort();
  if (runtimeIds.join("\n") !== [...STELLA_PROMPT_IDS].sort().join("\n")) {
    throw new Error(
      "Runtime prompt files do not match STELLA_PROMPT_IDS in @stella/contracts/stella-prompts.",
    );
  }
};

type GeneratedPrompt = { id: string; sha256: string; content: string };

const loadPrompts = async (): Promise<GeneratedPrompt[]> => {
  await assertSourceRoster();
  const prompts = await Promise.all(
    STELLA_PROMPT_IDS.map(async (id) => {
      const source = sourcePathFor(id);
      const content = promptBody(
        await fs.readFile(source.path, "utf-8"),
        source.kind,
        id,
      );
      if (utf8Bytes(content) > STELLA_PROMPT_MAX_CONTENT_BYTES) {
        throw new Error(`Canonical prompt ${id} exceeds the size limit.`);
      }
      return { id, sha256: sha256(content), content };
    }),
  );
  const totalBytes = prompts.reduce(
    (total, prompt) => total + utf8Bytes(prompt.content),
    0,
  );
  if (totalBytes > STELLA_PROMPT_MAX_TOTAL_CONTENT_BYTES) {
    throw new Error("Canonical prompt content exceeds the total size limit.");
  }
  return prompts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
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

const renderSource = (revision: string, prompts: GeneratedPrompt[]): string => {
  const lines = [
    "/* Generated by scripts/sync-stella-prompt-defaults.ts. Do not edit. */",
    "export const STELLA_PROMPT_DEFAULTS = {",
    ...renderProperty("  ", "revision", stringLiteral(revision)),
    "  publishedAt: 0,",
    "  prompts: [",
  ];
  for (const prompt of prompts) {
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

const args = process.argv.slice(2);
const check = args.length === 1 && args[0] === "--check";
if (args.length > 0 && !check) {
  throw new Error("Usage: sync-stella-prompt-defaults.ts [--check]");
}

const prompts = await loadPrompts();
const revision = sha256(
  prompts.map((prompt) => `${prompt.id}:${prompt.sha256}`).join("\n"),
);
const source = renderSource(revision, prompts);

if (check) {
  const current = await fs.readFile(generatedPath, "utf-8").catch(() => null);
  if (current !== source) {
    console.error(
      "Stella prompt defaults are stale. Run `bun run prompts:sync-defaults`.",
    );
    process.exitCode = 1;
  } else {
    console.log(`Verified ${prompts.length} prompts at revision ${revision}.`);
  }
} else {
  await fs.mkdir(path.dirname(generatedPath), { recursive: true });
  const tempPath = `${generatedPath}.tmp-${process.pid}`;
  await fs.writeFile(tempPath, source, "utf-8");
  await fs.rename(tempPath, generatedPath);
  console.log(`Synced ${prompts.length} prompts at revision ${revision}.`);
}
