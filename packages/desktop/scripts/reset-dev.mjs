import { execFileSync } from 'node:child_process';
import {
  clearPaths,
  desktopGeneratedPaths,
  formatStoppedProcessLines,
  stellaStatePath,
  stellaStateRuntimePaths,
  stopDevProcesses,
} from './lib/dev-reset.mjs';

// Dev now runs under com.stella.app.dev (see lib/macos-dev-permission-identity.mjs).
// Reset the dev identity, and keep the legacy com.stella.app so machines that were
// granted permissions before the split still get cleaned up.
const macPermissionBundleIds = ['com.stella.app.dev', 'com.stella.app'];
const macPermissionServices = [
  'Accessibility',
  'ScreenCapture',
  'ListenEvent',
  'SystemPolicyAllFiles',
];

const resetMacPermissions = () => {
  if (process.platform !== 'darwin') return [];

  const resetPairs = [];

  for (const service of macPermissionServices) {
    if (service === 'ScreenCapture') {
      try {
        execFileSync('tccutil', ['reset', service], { stdio: 'ignore' });
        resetPairs.push(`${service}:ALL_APPS`);
      } catch {
        // No-op if the reset fails on this machine.
      }
      continue;
    }

    for (const bundleId of macPermissionBundleIds) {
      try {
        execFileSync('tccutil', ['reset', service, bundleId], { stdio: 'ignore' });
        resetPairs.push(`${service}:${bundleId}`);
      } catch {
        // Some services may be unsupported or absent for a given identity.
      }
    }
  }

  return resetPairs;
};

const main = async () => {
  const includePermissions = process.argv.slice(2).includes('--with-permissions');
  const stopped = await stopDevProcesses();

  await clearPaths([
    ...stellaStateRuntimePaths,
    ...desktopGeneratedPaths,
  ]);

  const resetPairs = includePermissions ? resetMacPermissions() : [];

  console.log(
    [
      '[reset] Stella desktop dev environment reset.',
      `Cleared ${stellaStatePath}`,
      includePermissions && process.platform === 'darwin'
        ? resetPairs.length > 0
          ? `Reset macOS TCC permissions for ${resetPairs.join(', ')}`
          : `Attempted macOS TCC reset for ${macPermissionServices.join(', ')} on ${macPermissionBundleIds.join(', ')}`
        : '',
      ...formatStoppedProcessLines(stopped),
    ].filter(Boolean).join('\n'),
  );
};

await main();
