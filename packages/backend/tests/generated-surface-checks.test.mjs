import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "bun:test";

import {
  checkConvexApiEntryPoints,
  findConvexEntryPointModules,
} from "../scripts/check-convex-api-entrypoints.mjs";
import { writeOrCheckDesktopConvexApi } from "../scripts/generate-desktop-convex-api.mjs";
import { writeOrCheckStellaPromptDefaults } from "../scripts/sync-stella-prompt-defaults.ts";
import { writeOrCheckIpcPayloadContract } from "../../desktop/scripts/derive-ipc-payload-contract.mjs";
import { syncI18nCatalogs } from "../../mobile/scripts/sync-i18n-catalogs.mjs";

const temporaryDirectories = [];
const DETERMINISTIC_OLD_TIME = new Date("2001-02-03T04:05:06.000Z");

const temporaryDirectory = () => {
  const directory = mkdtempSync(path.join(tmpdir(), "stella-generated-check-"));
  temporaryDirectories.push(directory);
  return directory;
};

const logger = () => {
  const logs = [];
  const errors = [];
  return {
    logs,
    errors,
    value: {
      log: (message) => logs.push(message),
      error: (message) => errors.push(message),
    },
  };
};

const fileSnapshot = (filePath) => ({
  content: readFileSync(filePath, "utf8"),
  mtimeNs: statSync(filePath, { bigint: true }).mtimeNs.toString(),
});

const ageFile = (filePath) =>
  utimesSync(filePath, DETERMINISTIC_OLD_TIME, DETERMINISTIC_OLD_TIME);

const ageFileTree = (root) => {
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolutePath);
      else if (entry.isFile()) ageFile(absolutePath);
    }
  };
  walk(root);
};

const directorySnapshot = (root) => {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.isFile()) {
        files.push({
          path: path.relative(root, absolutePath).split(path.sep).join("/"),
          ...fileSnapshot(absolutePath),
        });
      }
    }
  };
  walk(root);
  return files;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("generated surface check modes", () => {
  it("checks prompt defaults without writing pass, drift, or absent cases", async () => {
    const root = temporaryDirectory();
    const targetPath = path.join(root, "stella_prompt_defaults.generated.ts");
    const expectedSource = "export const STELLA_PROMPT_DEFAULTS = {};\n";
    const messages = logger();
    const options = {
      expectedSource,
      targetPath,
      promptCount: 10,
      revision: "a".repeat(64),
      logger: messages.value,
      temporarySuffix: () => "test",
    };

    await expect(
      writeOrCheckStellaPromptDefaults({ ...options, check: false }),
    ).resolves.toBe(true);

    ageFile(targetPath);
    const passingSnapshot = fileSnapshot(targetPath);
    await expect(
      writeOrCheckStellaPromptDefaults({ ...options, check: true }),
    ).resolves.toBe(true);
    expect(fileSnapshot(targetPath)).toEqual(passingSnapshot);

    writeFileSync(targetPath, "stale\n");
    ageFile(targetPath);
    const driftSnapshot = fileSnapshot(targetPath);
    await expect(
      writeOrCheckStellaPromptDefaults({ ...options, check: true }),
    ).resolves.toBe(false);
    expect(fileSnapshot(targetPath)).toEqual(driftSnapshot);
    expect(messages.errors.at(-1)).toContain("prompts:sync-defaults");

    const absentOutputRoot = path.join(root, "absent-prompt-output");
    await expect(
      writeOrCheckStellaPromptDefaults({
        ...options,
        check: true,
        targetPath: path.join(
          absentOutputRoot,
          "stella_prompt_defaults.generated.ts",
        ),
      }),
    ).resolves.toBe(false);
    expect(existsSync(absentOutputRoot)).toBe(false);
  });

  it("checks the desktop Convex contract without writing pass or drift cases", () => {
    const root = temporaryDirectory();
    const targetPath = path.join(root, "convex-api.ts");
    const expectedSource = "export const api = {};\n";
    const messages = logger();

    expect(
      writeOrCheckDesktopConvexApi({
        check: false,
        expectedSource,
        targetPath,
        logger: messages.value,
      }),
    ).toBe(true);

    ageFile(targetPath);
    const passingSnapshot = fileSnapshot(targetPath);
    expect(
      writeOrCheckDesktopConvexApi({
        check: true,
        expectedSource,
        targetPath,
        logger: messages.value,
      }),
    ).toBe(true);
    expect(fileSnapshot(targetPath)).toEqual(passingSnapshot);

    writeFileSync(targetPath, "stale\n");
    ageFile(targetPath);
    const driftSnapshot = fileSnapshot(targetPath);
    expect(
      writeOrCheckDesktopConvexApi({
        check: true,
        expectedSource,
        targetPath,
        logger: messages.value,
      }),
    ).toBe(false);
    expect(fileSnapshot(targetPath)).toEqual(driftSnapshot);
    expect(messages.errors.at(-1)).toContain("generate:desktop-api");

    const absentOutputRoot = path.join(root, "absent-desktop-output");
    expect(
      writeOrCheckDesktopConvexApi({
        check: true,
        expectedSource,
        targetPath: path.join(absentOutputRoot, "convex-api.ts"),
        logger: messages.value,
      }),
    ).toBe(false);
    expect(existsSync(absentOutputRoot)).toBe(false);
  });

  it("checks the IPC payload contract without writing pass or drift cases", () => {
    const root = temporaryDirectory();
    const targetPath = path.join(root, "ipc-payload-contract.generated.js");
    const expectedSource = "export const IPC_PAYLOAD_CONTRACT = {};\n";
    const messages = logger();
    const options = {
      expectedSource,
      targetPath,
      channelCount: 1,
      logger: messages.value,
    };

    expect(writeOrCheckIpcPayloadContract({ ...options, check: false })).toBe(
      true,
    );

    ageFile(targetPath);
    const passingSnapshot = fileSnapshot(targetPath);
    expect(writeOrCheckIpcPayloadContract({ ...options, check: true })).toBe(
      true,
    );
    expect(fileSnapshot(targetPath)).toEqual(passingSnapshot);

    writeFileSync(targetPath, "stale\n");
    ageFile(targetPath);
    const driftSnapshot = fileSnapshot(targetPath);
    expect(writeOrCheckIpcPayloadContract({ ...options, check: true })).toBe(
      false,
    );
    expect(fileSnapshot(targetPath)).toEqual(driftSnapshot);
    expect(messages.errors.at(-1)).toContain("derive-ipc-payload-contract.mjs");

    const absentOutputRoot = path.join(root, "absent-ipc-output");
    expect(
      writeOrCheckIpcPayloadContract({
        ...options,
        check: true,
        targetPath: path.join(
          absentOutputRoot,
          "ipc-payload-contract.generated.js",
        ),
      }),
    ).toBe(false);
    expect(existsSync(absentOutputRoot)).toBe(false);
  });

  it("checks mobile locale mirrors without mutating pass or drift cases", () => {
    const root = temporaryDirectory();
    const desktopI18nRoot = path.join(root, "desktop-i18n");
    const catalogRoot = path.join(desktopI18nRoot, "locales");
    const outputRoot = path.join(root, "mobile-i18n");
    mkdirSync(catalogRoot, { recursive: true });
    writeFileSync(
      path.join(desktopI18nRoot, "locales.ts"),
      'export const DEFAULT_LOCALE = "en";\n',
    );
    writeFileSync(path.join(catalogRoot, "en.json"), '{"hello":"Hello"}\n');
    writeFileSync(path.join(catalogRoot, "fr.json"), '{"hello":"Bonjour"}\n');
    const messages = logger();

    expect(
      syncI18nCatalogs({
        check: false,
        desktopI18nRoot,
        outputRoot,
        logger: messages.value,
      }).ok,
    ).toBe(true);

    ageFileTree(outputRoot);
    const passingSnapshot = directorySnapshot(outputRoot);
    expect(
      syncI18nCatalogs({
        check: true,
        desktopI18nRoot,
        outputRoot,
        logger: messages.value,
      }),
    ).toMatchObject({ ok: true, drift: [] });
    expect(directorySnapshot(outputRoot)).toEqual(passingSnapshot);

    writeFileSync(path.join(outputRoot, "locales", "en.json"), "{}\n");
    writeFileSync(path.join(outputRoot, "locales", "stale.json"), "{}\n");
    ageFileTree(outputRoot);
    const driftSnapshot = directorySnapshot(outputRoot);
    const result = syncI18nCatalogs({
      check: true,
      desktopI18nRoot,
      outputRoot,
      logger: messages.value,
    });
    expect(result).toMatchObject({
      ok: false,
      drift: ["locales/en.json", "locales/stale.json (unexpected)"],
    });
    expect(directorySnapshot(outputRoot)).toEqual(driftSnapshot);
    expect(messages.errors.at(-1)).toContain("bun run i18n:sync");

    const absentOutputRoot = path.join(root, "absent-mobile-output");
    expect(
      syncI18nCatalogs({
        check: true,
        desktopI18nRoot,
        outputRoot: absentOutputRoot,
        logger: messages.value,
      }).ok,
    ).toBe(false);
    expect(existsSync(absentOutputRoot)).toBe(false);
  });

  it("checks Convex entry-point presence and ordering from local files only", () => {
    const root = temporaryDirectory();
    const functionsDir = path.join(root, "convex");
    const generatedDir = path.join(functionsDir, "_generated");
    const nestedDir = path.join(functionsDir, "sub");
    const componentDir = path.join(functionsDir, "component");
    const depsDir = path.join(functionsDir, "_deps");
    const depsComponentDir = path.join(depsDir, "component");
    mkdirSync(generatedDir, { recursive: true });
    mkdirSync(nestedDir, { recursive: true });
    mkdirSync(componentDir, { recursive: true });
    mkdirSync(depsComponentDir, { recursive: true });
    writeFileSync(
      path.join(functionsDir, "alpha.ts"),
      "export const alpha = 1;\n",
    );
    writeFileSync(path.join(nestedDir, "beta.js"), "export const beta = 1;\n");
    writeFileSync(
      path.join(functionsDir, "empty.ts"),
      "const privateValue = 1;\n",
    );
    writeFileSync(path.join(functionsDir, "schema.ts"), "export default {};\n");
    writeFileSync(path.join(functionsDir, "alpha.test.ts"), "export {};\n");
    writeFileSync(path.join(generatedDir, "ignored.ts"), "export {};\n");
    writeFileSync(path.join(componentDir, "convex.config.ts"), "export {};\n");
    writeFileSync(path.join(componentDir, "ignored.ts"), "export {};\n");
    writeFileSync(
      path.join(depsComponentDir, "convex.config.ts"),
      "export {};\n",
    );
    writeFileSync(path.join(depsComponentDir, "ignored.ts"), "export {};\n");

    expect(findConvexEntryPointModules(functionsDir)).toEqual([
      "alpha",
      "sub/beta",
    ]);

    const apiPath = path.join(generatedDir, "api.d.ts");
    writeFileSync(
      apiPath,
      'import type * as alpha from "../alpha.js";\n' +
        'import type * as sub_beta from "../sub/beta.js";\n' +
        "\n" +
        'import type { ApiFromModules } from "convex/server";\n' +
        "\n" +
        "declare const fullApi: ApiFromModules<{\n" +
        "  alpha: typeof alpha;\n" +
        '  "sub/beta": typeof sub_beta;\n' +
        "}>;\n",
    );
    ageFile(apiPath);
    const passingSnapshot = fileSnapshot(apiPath);
    expect(checkConvexApiEntryPoints({ apiPath, functionsDir })).toMatchObject({
      ok: true,
      expectedCount: 2,
      actualCount: 2,
      missing: [],
      extra: [],
      duplicates: [],
      orderMismatch: false,
      importBindingMismatches: [],
      mappingCount: 2,
      mappingMissing: [],
      mappingExtra: [],
      mappingDuplicates: [],
      mappingOrderMismatch: false,
      mappingBindingMismatches: [],
      parseErrors: [],
    });
    expect(fileSnapshot(apiPath)).toEqual(passingSnapshot);

    writeFileSync(
      apiPath,
      'import type * as stale from "../stale.js";\n' +
        'import type * as alpha from "../alpha.js";\n' +
        "\n" +
        'import type { ApiFromModules } from "convex/server";\n' +
        "\n" +
        "declare const fullApi: ApiFromModules<{\n" +
        "  stale: typeof stale;\n" +
        "  alpha: typeof alpha;\n" +
        "}>;\n",
    );
    ageFile(apiPath);
    const driftSnapshot = fileSnapshot(apiPath);
    expect(checkConvexApiEntryPoints({ apiPath, functionsDir })).toMatchObject({
      ok: false,
      missing: ["sub/beta"],
      extra: ["stale"],
    });
    expect(fileSnapshot(apiPath)).toEqual(driftSnapshot);

    writeFileSync(
      apiPath,
      'import type * as sub_beta from "../sub/beta.js";\n' +
        'import type * as alpha from "../alpha.js";\n' +
        "\n" +
        'import type { ApiFromModules } from "convex/server";\n' +
        "\n" +
        "declare const fullApi: ApiFromModules<{\n" +
        "  alpha: typeof alpha;\n" +
        '  "sub/beta": typeof sub_beta;\n' +
        "}>;\n",
    );
    expect(checkConvexApiEntryPoints({ apiPath, functionsDir })).toMatchObject({
      ok: false,
      missing: [],
      extra: [],
      orderMismatch: true,
    });

    writeFileSync(path.join(depsDir, "forbidden.ts"), "export {};\n");
    expect(() => findConvexEntryPointModules(functionsDir)).toThrow(
      'is within the "_deps" directory',
    );
  });

  it("fails closed on missing, reordered, or misbound fullApi mappings", () => {
    const root = temporaryDirectory();
    const functionsDir = path.join(root, "convex");
    const generatedDir = path.join(functionsDir, "_generated");
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(
      path.join(functionsDir, "alpha.ts"),
      "export const alpha = 1;\n",
    );
    writeFileSync(
      path.join(functionsDir, "beta.ts"),
      "export const beta = 1;\n",
    );
    const apiPath = path.join(generatedDir, "api.d.ts");
    const imports =
      'import type * as alpha from "../alpha.js";\n' +
      'import type * as beta from "../beta.js";\n' +
      "\n" +
      'import type { ApiFromModules } from "convex/server";\n' +
      "\n";

    writeFileSync(
      apiPath,
      imports +
        "declare const fullApi: ApiFromModules<{\n" +
        "  alpha: typeof alpha;\n" +
        "}>;\n",
    );
    expect(checkConvexApiEntryPoints({ apiPath, functionsDir })).toMatchObject({
      ok: false,
      missing: [],
      mappingMissing: ["beta"],
      mappingExtra: [],
      parseErrors: [],
    });

    writeFileSync(
      apiPath,
      imports +
        "declare const fullApi: ApiFromModules<{\n" +
        "  beta: typeof beta;\n" +
        "  alpha: typeof alpha;\n" +
        "}>;\n",
    );
    expect(checkConvexApiEntryPoints({ apiPath, functionsDir })).toMatchObject({
      ok: false,
      mappingMissing: [],
      mappingExtra: [],
      mappingOrderMismatch: true,
    });

    writeFileSync(
      apiPath,
      imports +
        "declare const fullApi: ApiFromModules<{\n" +
        "  alpha: typeof alpha;\n" +
        "  beta: typeof alpha;\n" +
        "}>;\n",
    );
    expect(checkConvexApiEntryPoints({ apiPath, functionsDir })).toMatchObject({
      ok: false,
      mappingMissing: [],
      mappingExtra: [],
      mappingBindingMismatches: [
        { modulePath: "beta", expected: "beta", actual: "alpha" },
      ],
      parseErrors: [],
    });

    writeFileSync(
      apiPath,
      imports +
        "declare const fullApi: ApiFromModules<{\n" +
        "  alpha: typeof alpha;\n" +
        "  beta: typeof beta\n" +
        "}>;\n",
    );
    expect(checkConvexApiEntryPoints({ apiPath, functionsDir })).toMatchObject({
      ok: false,
      mappingMissing: ["beta"],
    });
    expect(
      checkConvexApiEntryPoints({ apiPath, functionsDir }).parseErrors,
    ).toEqual(["malformed fullApi mapping on line 8"]);

    writeFileSync(apiPath, imports);
    expect(checkConvexApiEntryPoints({ apiPath, functionsDir })).toMatchObject({
      ok: false,
      mappingCount: 0,
      mappingMissing: ["alpha", "beta"],
      parseErrors: ["missing fullApi ApiFromModules mapping"],
    });
  });
});
