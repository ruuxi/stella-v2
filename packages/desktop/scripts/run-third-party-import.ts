import {
  detectThirdPartyMigrationSources,
  previewThirdPartyMigration,
  runThirdPartyMigration,
  type ThirdPartyMigrationSelection,
  type ThirdPartyMigrationSource,
} from "@stella/runtime/kernel/migration/third-party-importers";
import { resolveStellaHomeDir } from "../electron/data-paths.js";

type RequestPayload = {
  action?: "detect" | "preview" | "run";
  source?: ThirdPartyMigrationSource;
  sourceRoot?: string;
  stellaDataDir?: string;
  selection?: ThirdPartyMigrationSelection;
};

const payload = JSON.parse(process.argv[2] ?? "{}") as RequestPayload;

const stellaDataDir =
  payload.stellaDataDir ??
  resolveStellaHomeDir({
    isPackaged: false,
    devHomeOverride: process.env.STELLA_V2_DEV_DATA_DIR,
  });

const main = async () => {
  if (payload.action === "detect") {
    return await detectThirdPartyMigrationSources();
  }
  if (payload.action === "preview") {
    if (!payload.source) throw new Error("Missing import source.");
    return await previewThirdPartyMigration({
      source: payload.source,
      sourceRoot: payload.sourceRoot,
    });
  }
  if (payload.action === "run") {
    if (!payload.source) throw new Error("Missing import source.");
    return await runThirdPartyMigration({
      source: payload.source,
      sourceRoot: payload.sourceRoot,
      stellaDataDir,
      selection: payload.selection,
    });
  }
  throw new Error("Unsupported import action.");
};

try {
  const result = await main();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
