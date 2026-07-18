import {
  clearPaths,
  formatStoppedProcessLines,
  stellaSqlitePaths,
  stellaStatePath,
  stopDevProcesses,
} from './lib/dev-reset.mjs';

const main = async () => {
  const stopped = await stopDevProcesses();

  await clearPaths(stellaSqlitePaths, { recursive: false });

  console.log(
    [
      '[reset-sql] Removed Stella SQLite under the isolated v2 dev home (stella.sqlite + -shm + -wal).',
      `Target: ${stellaStatePath}`,
      ...formatStoppedProcessLines(stopped),
    ].filter(Boolean).join('\n'),
  );
};

await main();
