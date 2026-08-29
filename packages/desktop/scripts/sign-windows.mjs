/**
 * electron-builder `win.signtoolOptions.sign` hook.
 *
 * DigiCert KeyLocker holds the private key in a hosted HSM, so there is no PFX
 * for electron-builder's built-in signer to load. Instead the CI job
 * synchronizes the approved certificate into the runner's user store, exports
 * the *public* half to a `.cer`, and points Microsoft SignTool at the DigiCert
 * KSP; SignTool then finds the matching private key by keypair alias. This
 * hook is the seam that runs that command for every artifact electron-builder
 * would otherwise sign itself.
 *
 * Every candidate must be classified by `signingPolicy`. An unrecognized path
 * fails the build rather than being signed or silently skipped: a packaging
 * change that starts shipping a new `.exe` should be a deliberate decision
 * about whose identity it carries, not an accident.
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { basename, win32 } from "node:path";

// The Bun/ripgrep/uv trio Stella builds its own launch story around; these are
// re-signed as FromYou because Stella invokes them as first-class entry points.
const managedRuntimeExecutables = new Set(["bun.exe", "rg.exe", "uv.exe"]);

function requireEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for Windows code signing`);
  }
  return value;
}

function runSignTool(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `Microsoft SignTool failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`,
        ),
      );
    });
  });
}

/**
 * Classify a signing candidate by its packaged location.
 *
 * Returns an artifact-type label for anything Stella signs, `null` for the
 * pinned third-party runtime trees whose upstream Authenticode identity we
 * deliberately preserve (re-signing Git/Node/Python as FromYou would claim
 * authorship of binaries we only redistribute), and throws for anything else.
 *
 * Paths are normalized to backslashes first: electron-builder hands this hook
 * whatever separator the caller produced, and the `resources\...` prefixes
 * below are the packaged layout from `build.extraResources`.
 */
export function signingPolicy(filePath) {
  const normalized = filePath.replaceAll("/", "\\");
  const lowerPath = normalized.toLowerCase();
  const fileName = win32.basename(normalized).toLowerCase();

  if (fileName === "stella.exe") {
    return "application-executable";
  }
  // Matches both `Stella-1.2.3-Windows-x64.exe` and the intermediate
  // `...__uninstaller.exe` NSIS produces before embedding it in the installer.
  if (/^stella-.+-windows-.+(?:\.__uninstaller)?\.exe$/iu.test(fileName)) {
    return "nsis-package";
  }
  if (lowerPath.endsWith("\\resources\\elevate.exe")) {
    return "nsis-helper";
  }
  if (lowerPath.includes("\\resources\\native\\out\\win32\\")) {
    return "native-helper";
  }
  if (lowerPath.includes("\\resources\\stella-browser\\out\\win-x64\\")) {
    return "stella-browser-helper";
  }
  if (
    lowerPath.includes("\\resources\\bin\\") &&
    managedRuntimeExecutables.has(fileName)
  ) {
    return "managed-cli-runtime";
  }
  if (
    lowerPath.includes("\\resources\\runtimes\\git\\") ||
    lowerPath.includes("\\resources\\runtimes\\node\\") ||
    lowerPath.includes("\\resources\\runtimes\\python\\")
  ) {
    return null;
  }
  throw new Error(
    `Unexpected Windows signing candidate: ${basename(filePath)}`,
  );
}

export async function sign(configuration) {
  if (process.platform !== "win32") {
    throw new Error("DigiCert KeyLocker signing requires Windows");
  }
  if (configuration.hash?.toLowerCase() !== "sha256") {
    throw new Error("Windows artifacts must be signed with SHA-256");
  }

  const artifactType = signingPolicy(configuration.path);
  if (!artifactType) {
    console.log(
      `Preserving upstream Authenticode identity for ${basename(configuration.path)}`,
    );
    return;
  }

  const signTool = requireEnvironment("STELLA_WINDOWS_SIGNTOOL_PATH");
  const certificateFile = requireEnvironment("STELLA_WINDOWS_PUBLIC_CERT_FILE");
  const keypairAlias = requireEnvironment("SM_KEYPAIR_ALIAS");
  await Promise.all([
    access(signTool),
    access(certificateFile),
    access(configuration.path),
  ]);

  console.log(
    `Authenticode signing ${artifactType} ${basename(configuration.path)} with DigiCert KeyLocker`,
  );
  await runSignTool(signTool, [
    "sign",
    // `/csp` + `/kc` route the private-key operation to KeyLocker; `/f` only
    // supplies the public certificate so SignTool can build the chain.
    "/csp",
    "DigiCert Signing Manager KSP",
    "/kc",
    keypairAlias,
    "/f",
    certificateFile,
    "/tr",
    "http://timestamp.digicert.com",
    "/td",
    "SHA256",
    "/fd",
    "SHA256",
    "/d",
    "Stella",
    "/du",
    "https://github.com/ruuxi/stella-v2",
    configuration.path,
  ]);
}
