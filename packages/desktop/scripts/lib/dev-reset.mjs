import { execFileSync, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { resolveDevStellaHome } from './dev-home-paths.mjs';

const scriptDir = import.meta.dirname;
const desktopDir = resolve(scriptDir, '..', '..');
const repoRootDir = resolve(desktopDir, '..', '..');
export const stellaStatePath = resolveDevStellaHome();

const devElectronBinaryPathFragments = [
  resolve(repoRootDir, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
].map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

export const desktopGeneratedPaths = [
  resolve(desktopDir, '.stella-hmr-state.json'),
  resolve(desktopDir, 'dist-electron'),
];

export const stellaSqlitePaths = [
  'stella.sqlite',
  'stella.sqlite-shm',
  'stella.sqlite-wal',
].map((relativePath) => resolve(stellaStatePath, relativePath));

export const stellaStateRuntimePaths = [
  'electron-user-data',
  'office-previews',
  'raw',
  'tmp',
  'skills/user-profile',
  'core-memory.md',
  'device.json',
  'local-scheduler.json',
  'preferences.json',
  'ui-state.json',
  'stella.sqlite',
  'stella.sqlite-shm',
  'stella.sqlite-wal',
].map((relativePath) => resolve(stellaStatePath, relativePath));

const killWindowsTree = (pid) =>
  new Promise((resolvePromise) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', resolvePromise);
    killer.on('exit', resolvePromise);
  });

const waitForExit = async (pid, timeoutMs = 5000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    } catch {
      return;
    }
  }
};

const killPosixTree = async (pid) => {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
  }

  await waitForExit(pid, 2500);

  try {
    process.kill(pid, 0);
  } catch {
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process already exited.
    }
  }
};

const stopResidualDevElectron = async () => {
  if (process.platform === 'win32') {
    return 0;
  }

  const matchedPids = new Set();

  for (const pathFragment of devElectronBinaryPathFragments) {
    let stdout = '';
    try {
      stdout = execFileSync(
        'pgrep',
        [
          '-f',
          pathFragment,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && error.status === 1) {
        continue;
      }
      continue;
    }

    stdout
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
      .forEach((pid) => matchedPids.add(pid));
  }

  const pids = [...matchedPids];

  await Promise.allSettled(pids.map((pid) => killPosixTree(pid)));
  return pids.length;
};

export const clearPaths = async (paths, options = { recursive: true }) => {
  await Promise.allSettled(
    paths.map((targetPath) =>
      fs.rm(targetPath, {
        recursive: options.recursive,
        force: true,
      }),
    ),
  );
};

export const stopDevProcesses = async () => {
  const stoppedResidualElectron = await stopResidualDevElectron();
  return {
    stoppedResidualElectron,
  };
};

export const formatStoppedProcessLines = ({
  stoppedResidualElectron,
}) => [
  stoppedResidualElectron > 0
    ? `Stopped ${stoppedResidualElectron} residual Electron dev process${stoppedResidualElectron === 1 ? '' : 'es'}.`
    : '',
];
