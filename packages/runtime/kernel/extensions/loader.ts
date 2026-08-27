import { promises as fs } from "fs";
import path from "path";
import type {
  ToolDefinition,
  HookDefinition,
  ProviderDefinition,
  PromptTemplate,
  LoadedExtensions,
  ExtensionFactory,
  ExtensionRegistrationApi,
} from "./types.js";
import type { ExtensionServices } from "./services.js";
import { extractFrontmatter } from "../frontmatter.js";

const log = (...args: unknown[]) => console.error("[stella:extensions]", ...args);
const logError = (...args: unknown[]) => console.error("[stella:extensions]", ...args);

const cacheBuster = async (
  filePath: string,
  loadToken: string,
): Promise<string> => {
  let mtime = 0;
  try {
    const stat = await fs.stat(filePath);
    mtime = stat.mtimeMs;
  } catch {

  }
  return `?v=${mtime}-${loadToken}`;
};

async function importModules<T>(
  dir: string,
  suffix: string,
  loadToken: string,
): Promise<T[]> {
  const results: T[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.endsWith(suffix)) continue;
    const filePath = path.join(dir, entry);
    try {

      const resolvedPath = path.resolve(filePath);
      const fileUrl =
        `file:///${resolvedPath.replace(/\\/g, "/")}` +
        (await cacheBuster(filePath, loadToken));
      const mod = await import( fileUrl);
      const definition = mod.default ?? mod;
      if (definition && typeof definition === "object") {
        results.push(definition as T);
        log(`Loaded ${suffix}: ${entry}`);
      }
    } catch (error) {
      logError(`Failed to load ${filePath}:`, (error as Error).message);
    }
  }

  return results;
}

async function loadExtensionFactories(
  baseDir: string,
  loadToken: string,
  services: ExtensionServices,
): Promise<LoadedExtensions> {
  const collected: LoadedExtensions = {
    tools: [],
    hooks: [],
    providers: [],
    prompts: [],
    agents: [],
  };

  let entries: string[];
  try {
    entries = await fs.readdir(baseDir);
  } catch {
    return collected;
  }

  for (const entry of entries) {
    if (entry.startsWith(".")) {
      continue;
    }
    const extensionDir = path.join(baseDir, entry);
    let stat;
    try {
      stat = await fs.stat(extensionDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }

    const entryCandidates = ["index.js", "index.ts"].map((fileName) =>
      path.join(extensionDir, fileName),
    );
    let filePath: string | undefined;
    for (const candidate of entryCandidates) {
      try {
        await fs.access(candidate);
        filePath = candidate;
        break;
      } catch {

      }
    }
    if (!filePath) {
      continue;
    }

    try {
      const resolvedPath = path.resolve(filePath);
      const fileUrl =
        `file:///${resolvedPath.replace(/\\/g, "/")}` +
        (await cacheBuster(filePath, loadToken));
      const mod = await import( fileUrl);
      const factory = (mod.default ?? mod) as ExtensionFactory;
      if (typeof factory !== "function") {
        continue;
      }

      const api: ExtensionRegistrationApi = {
        on(event, handler, filter) {
          collected.hooks.push({
            event,
            filter,
            handler,
          });
        },
        registerTool(tool) {
          collected.tools.push(tool);
        },
        registerProvider(provider) {
          collected.providers.push(provider);
        },
        registerPrompt(prompt) {
          collected.prompts.push(prompt);
        },
        registerAgent(agent) {
          collected.agents.push(agent);
        },
      };

      await factory(api, services);
      log(`Loaded extension: ${entry}`);
    } catch (error) {
      logError(`Failed to load extension ${filePath}:`, (error as Error).message);
    }
  }

  return collected;
}

async function loadPrompts(dir: string): Promise<PromptTemplate[]> {
  const results: PromptTemplate[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".prompt.md")) continue;
    const filePath = path.join(dir, entry);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const { metadata, body } = extractFrontmatter(raw);
      const baseName = entry.replace(/\.prompt\.md$/, "");
      results.push({
        name: typeof metadata.name === "string" ? metadata.name : baseName,
        description:
          typeof metadata.description === "string" ? metadata.description : "",
        template: body.trim() || raw,
        filePath,
      });
      log(`Loaded prompt: ${entry}`);
    } catch (error) {
      logError(`Failed to load prompt ${filePath}:`, (error as Error).message);
    }
  }

  return results;
}

let loadExtensionsCallCount = 0;
const LOADER_RELOAD_WARN_THRESHOLD = 50;

export async function loadExtensions(
  baseDir: string,
  services: ExtensionServices,
): Promise<LoadedExtensions> {
  loadExtensionsCallCount += 1;
  if (loadExtensionsCallCount === LOADER_RELOAD_WARN_THRESHOLD) {

    log(
      `Extensions have been (re)loaded ${loadExtensionsCallCount} times this session. ` +
        "Each reload leaks the previous version's module records into the Node ESM loader cache. " +
        "If you're seeing memory pressure, restart Stella to clear the cache.",
    );
  }
  log(`Loading extensions from ${baseDir}`);

  const loadToken = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const [tools, hooks, providers, prompts, registered] = await Promise.all([
    importModules<ToolDefinition>(
      path.join(baseDir, "tools"),
      ".tool.ts",
      loadToken,
    ),
    importModules<HookDefinition>(
      path.join(baseDir, "hooks"),
      ".hook.ts",
      loadToken,
    ),
    importModules<ProviderDefinition>(
      path.join(baseDir, "providers"),
      ".provider.ts",
      loadToken,
    ),
    loadPrompts(path.join(baseDir, "prompts")),
    loadExtensionFactories(baseDir, loadToken, services),
  ]);

  const loaded: LoadedExtensions = {
    tools: [...tools, ...registered.tools],
    hooks: [...hooks, ...registered.hooks],
    providers: [...providers, ...registered.providers],
    prompts: [...prompts, ...registered.prompts],
    agents: [...registered.agents],
  };

  log(
    `Loaded ${loaded.tools.length} tools, ${loaded.hooks.length} hooks, ${loaded.providers.length} providers, ${loaded.prompts.length} prompts, ${loaded.agents.length} agents`,
  );

  return loaded;
}
