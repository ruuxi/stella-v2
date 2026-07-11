import { promises as fs } from "node:fs";
import path from "node:path";

export type PromptDefaultsTransactionSpec = {
  destinationRoot: string;
  generatedPath: string;
};

export type PromptDefaultsTransactionPhase =
  | "prepared"
  | "destination-backed-up"
  | "both-backed-up"
  | "destination-installed"
  | "committed";

export type PromptDefaultsTransactionMarker = {
  version: 1;
  nonce: string;
  phase: PromptDefaultsTransactionPhase;
  hadDestination: boolean;
  hadGenerated: boolean;
};

const NONCE_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export const promptDefaultsTransactionMarkerPath = (
  spec: PromptDefaultsTransactionSpec,
): string =>
  path.join(
    path.dirname(spec.destinationRoot),
    ".stella-prompt-defaults-transaction.json",
  );

export const promptDefaultsTransactionPaths = (
  spec: PromptDefaultsTransactionSpec,
  nonce: string,
) => ({
  stagingRoot: `${spec.destinationRoot}.tmp-${nonce}`,
  destinationBackup: `${spec.destinationRoot}.backup-${nonce}`,
  generatedTemp: `${spec.generatedPath}.tmp-${nonce}`,
  generatedBackup: `${spec.generatedPath}.backup-${nonce}`,
});

const exists = async (target: string): Promise<boolean> => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

const validateMarker = (value: unknown): PromptDefaultsTransactionMarker => {
  if (!value || typeof value !== "object") {
    throw new Error("Prompt-default transaction marker is invalid.");
  }
  const marker = value as Partial<PromptDefaultsTransactionMarker>;
  const phases: PromptDefaultsTransactionPhase[] = [
    "prepared",
    "destination-backed-up",
    "both-backed-up",
    "destination-installed",
    "committed",
  ];
  if (
    marker.version !== 1 ||
    typeof marker.nonce !== "string" ||
    !NONCE_PATTERN.test(marker.nonce) ||
    !phases.includes(marker.phase as PromptDefaultsTransactionPhase) ||
    typeof marker.hadDestination !== "boolean" ||
    typeof marker.hadGenerated !== "boolean"
  ) {
    throw new Error("Prompt-default transaction marker is invalid.");
  }
  return marker as PromptDefaultsTransactionMarker;
};

const writeMarker = async (
  spec: PromptDefaultsTransactionSpec,
  marker: PromptDefaultsTransactionMarker,
): Promise<void> => {
  const markerPath = promptDefaultsTransactionMarkerPath(spec);
  await fs.mkdir(path.dirname(markerPath), { recursive: true });
  const temp = `${markerPath}.tmp-${process.pid}`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(marker, null, 2)}\n`, "utf-8");
    await fs.rename(temp, markerPath);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
};

const collectFailure = async (
  failures: unknown[],
  operation: () => Promise<void>,
): Promise<void> => {
  try {
    await operation();
  } catch (error) {
    failures.push(error);
  }
};

const rollbackTransaction = async (
  spec: PromptDefaultsTransactionSpec,
  marker: PromptDefaultsTransactionMarker,
): Promise<void> => {
  const markerPath = promptDefaultsTransactionMarkerPath(spec);
  const paths = promptDefaultsTransactionPaths(spec, marker.nonce);
  const failures: unknown[] = [];

  if (await exists(paths.destinationBackup)) {
    await collectFailure(failures, async () => {
      await fs.rm(spec.destinationRoot, { recursive: true, force: true });
      await fs.rename(paths.destinationBackup, spec.destinationRoot);
    });
  } else if (!marker.hadDestination) {
    await collectFailure(failures, async () => {
      await fs.rm(spec.destinationRoot, { recursive: true, force: true });
    });
  } else if (!(await exists(spec.destinationRoot))) {
    failures.push(new Error("Prompt-default destination backup is missing."));
  }

  if (await exists(paths.generatedBackup)) {
    await collectFailure(failures, async () => {
      await fs.rm(spec.generatedPath, { force: true });
      await fs.rename(paths.generatedBackup, spec.generatedPath);
    });
  } else if (!marker.hadGenerated) {
    await collectFailure(failures, async () => {
      await fs.rm(spec.generatedPath, { force: true });
    });
  } else if (!(await exists(spec.generatedPath))) {
    failures.push(new Error("Generated prompt-default backup is missing."));
  }

  await collectFailure(failures, async () => {
    await fs.rm(paths.stagingRoot, { recursive: true, force: true });
  });
  await collectFailure(failures, async () => {
    await fs.rm(paths.generatedTemp, { force: true });
  });

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Prompt-default transaction rollback was incomplete.",
    );
  }
  await fs.rm(markerPath, { force: true });
};

const finishCommittedTransaction = async (
  spec: PromptDefaultsTransactionSpec,
  marker: PromptDefaultsTransactionMarker,
): Promise<void> => {
  const paths = promptDefaultsTransactionPaths(spec, marker.nonce);
  const failures: unknown[] = [];
  for (const operation of [
    () => fs.rm(paths.destinationBackup, { recursive: true, force: true }),
    () => fs.rm(paths.generatedBackup, { force: true }),
    () => fs.rm(paths.stagingRoot, { recursive: true, force: true }),
    () => fs.rm(paths.generatedTemp, { force: true }),
  ]) {
    await collectFailure(failures, operation);
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "Committed prompt-default transaction cleanup was incomplete.",
    );
  }
  await fs.rm(promptDefaultsTransactionMarkerPath(spec), { force: true });
};

export const recoverPromptDefaultsTransaction = async (
  spec: PromptDefaultsTransactionSpec,
): Promise<"none" | "rolled-back" | "completed"> => {
  const markerPath = promptDefaultsTransactionMarkerPath(spec);
  let marker: PromptDefaultsTransactionMarker;
  try {
    marker = validateMarker(JSON.parse(await fs.readFile(markerPath, "utf-8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none";
    throw error;
  }

  if (
    marker.phase === "committed" &&
    (await exists(spec.destinationRoot)) &&
    (await exists(spec.generatedPath))
  ) {
    await finishCommittedTransaction(spec, marker);
    return "completed";
  }
  await rollbackTransaction(spec, marker);
  return "rolled-back";
};

export const commitPromptDefaultsTransaction = async (
  spec: PromptDefaultsTransactionSpec,
  nonce: string,
): Promise<void> => {
  if (!NONCE_PATTERN.test(nonce)) throw new Error("Invalid transaction nonce.");
  const paths = promptDefaultsTransactionPaths(spec, nonce);
  const marker: PromptDefaultsTransactionMarker = {
    version: 1,
    nonce,
    phase: "prepared",
    hadDestination: await exists(spec.destinationRoot),
    hadGenerated: await exists(spec.generatedPath),
  };
  await writeMarker(spec, marker);

  try {
    if (marker.hadDestination) {
      await fs.rename(spec.destinationRoot, paths.destinationBackup);
    }
    marker.phase = "destination-backed-up";
    await writeMarker(spec, marker);

    if (marker.hadGenerated) {
      await fs.rename(spec.generatedPath, paths.generatedBackup);
    }
    marker.phase = "both-backed-up";
    await writeMarker(spec, marker);

    await fs.rename(paths.stagingRoot, spec.destinationRoot);
    marker.phase = "destination-installed";
    await writeMarker(spec, marker);

    await fs.rename(paths.generatedTemp, spec.generatedPath);
    marker.phase = "committed";
    await writeMarker(spec, marker);
  } catch (error) {
    try {
      await rollbackTransaction(spec, marker);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Prompt-default transaction failed and rollback was incomplete.",
      );
    }
    throw error;
  }
  await finishCommittedTransaction(spec, marker);
};
