/**
 * Strict rendered-client acceptance primitives.
 *
 * This module drives the real Stella renderer through Chromium DevTools
 * Protocol. It never imports ConversationSocket, Convex functions, or React
 * stores into the proof process: authentication is the one dev-only setup
 * seam, and every product action after that is a DOM event against the modern
 * RootLayout/Composer/ChatTimeline surface.
 *
 * Evidence returned from this module is deliberately hash-only. DOM text,
 * conversation ids, cookies, JWTs, CDP handshake headers, and frame payloads
 * are never retained in observations or written to logs.
 */

import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  createReadStream,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  CloudProofError,
  FORBIDDEN_TARGET_PATTERN,
  REQUIRED_CLOUD_BUILDER_ORIGIN,
  REQUIRED_CONVEX,
  assert,
  poll,
  requestJson,
  sha256,
} from "./cloud-proof-lib.mjs";

export const RENDERED_CLIENT_CDP_CONTRACT = "stella-rendered-client-cdp-v1";
export const RENDERED_CLIENT_SURFACES = Object.freeze([
  "electron-cdp",
  "browser-cdp",
]);

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = realpathSync(
  path.resolve(path.dirname(SCRIPT_FILE), "../../.."),
);
const LIVE_STELLA_ROOT = path.resolve(homedir(), ".stella");
const execFileAsync = promisify(execFile);
const MAX_CDP_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_TRACKED_REQUESTS = 8_192;
const MAX_TRACKED_SOCKETS = 256;
const MAX_TRACKED_RECORDS = 100_000;
const CDP_CONNECT_TIMEOUT_MS = 30_000;
const UI_SETTLE_TIMEOUT_MS = 60_000;
const PROFILE_OWNERSHIP_MARKER = ".stella-rendered-acceptance-profile.json";

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
};

const canonicalJson = (value) => JSON.stringify(canonicalize(value));

const requireSha256 = (value, label) => {
  assert(
    typeof value === "string" && /^[a-f0-9]{64}$/u.test(value),
    `${label} must be a lowercase SHA-256 digest.`,
  );
  return value;
};

const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const inside = (candidate, root) =>
  candidate === root || candidate.startsWith(`${root}${path.sep}`);

const overlaps = (left, right) => inside(left, right) || inside(right, left);

const canonicalPathIfPresent = (candidate) => {
  const resolved = path.resolve(candidate);
  const suffix = [];
  let cursor = resolved;
  while (true) {
    try {
      const existing = realpathSync(cursor);
      return path.join(existing, ...suffix.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      assert(parent !== cursor, "Rendered-client path has no existing root.");
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
};

export const assertIsolatedRenderedClientPath = (
  candidate,
  harnessRoot,
  {
    repoRoot = REPO_ROOT,
    homeDir = homedir(),
    liveStellaRoot = LIVE_STELLA_ROOT,
  } = {},
) => {
  assert(path.isAbsolute(candidate), "Rendered-client path must be absolute.");
  assert(path.isAbsolute(harnessRoot), "Harness root must be absolute.");
  const root = canonicalPathIfPresent(harnessRoot);
  const resolved = canonicalPathIfPresent(candidate);
  const protectedRoots = [
    canonicalPathIfPresent(repoRoot),
    canonicalPathIfPresent(homeDir),
    canonicalPathIfPresent(liveStellaRoot),
  ];
  assert(
    resolved !== root &&
      inside(resolved, root) &&
      !FORBIDDEN_TARGET_PATTERN.test(resolved) &&
      !protectedRoots.some((protectedRoot) =>
        overlaps(resolved, protectedRoot),
      ),
    "Rendered-client path must be narrow, harness-owned, and outside protected state.",
  );
  return resolved;
};

const REVIEWED_CHROMIUM_CANDIDATES = Object.freeze({
  darwin: Object.freeze([
    Object.freeze({
      flavor: "google-chrome",
      binary: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      liveProfile: "Library/Application Support/Google/Chrome",
    }),
    Object.freeze({
      flavor: "brave",
      binary: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      liveProfile: "Library/Application Support/BraveSoftware/Brave-Browser",
    }),
  ]),
  linux: Object.freeze([
    Object.freeze({
      flavor: "google-chrome",
      binary: "/usr/bin/google-chrome",
      liveProfile: ".config/google-chrome",
    }),
    Object.freeze({
      flavor: "chromium",
      binary: "/usr/bin/chromium",
      liveProfile: ".config/chromium",
    }),
    Object.freeze({
      flavor: "chromium",
      binary: "/usr/bin/chromium-browser",
      liveProfile: ".config/chromium",
    }),
    Object.freeze({
      flavor: "brave",
      binary: "/usr/bin/brave-browser",
      liveProfile: ".config/BraveSoftware/Brave-Browser",
    }),
  ]),
});

export const reviewedChromiumCandidates = (
  platform = process.platform,
  homeDir = homedir(),
) => {
  const installed = (REVIEWED_CHROMIUM_CANDIDATES[platform] ?? []).map(
    (candidate) => ({
      ...candidate,
      liveProfile: path.resolve(homeDir, candidate.liveProfile),
    }),
  );
  if (platform !== "darwin") return installed;
  // Exact, locally installed Chrome-for-Testing shells are deliberately
  // separate from the user's interactive Chrome/Brave profiles. Keep these
  // paths version-pinned: a newly downloaded binary requires explicit review.
  const shellRoot = path.join(
    homeDir,
    ".cache",
    "puppeteer",
    "chrome-headless-shell",
  );
  return [
    ...installed,
    {
      flavor: "chrome-headless-shell-148",
      binary: path.join(
        shellRoot,
        "mac_arm-148.0.7778.97",
        "chrome-headless-shell-mac-arm64",
        "chrome-headless-shell",
      ),
      liveProfile: path.join(
        homeDir,
        "Library",
        "Application Support",
        "Google",
        "Chrome for Testing",
      ),
    },
    {
      flavor: "chrome-headless-shell-131",
      binary: path.join(
        shellRoot,
        "mac_arm-131.0.6778.204",
        "chrome-headless-shell-mac-arm64",
        "chrome-headless-shell",
      ),
      liveProfile: path.join(
        homeDir,
        "Library",
        "Application Support",
        "Google",
        "Chrome for Testing",
      ),
    },
  ];
};

export const resolveReviewedChromiumBinary = ({
  env = process.env,
  platform = process.platform,
  homeDir = homedir(),
  candidates = reviewedChromiumCandidates(platform, homeDir),
} = {}) => {
  const declared = env.STELLA_CLOUD_ACCEPTANCE_BROWSER_BINARY?.trim();
  const eligible = candidates
    .map((candidate) => {
      try {
        const binary = realpathSync(candidate.binary);
        if (!statSync(binary).isFile()) return null;
        accessSync(binary, fsConstants.X_OK);
        return { ...candidate, binary };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (declared) {
    const resolved = canonicalPathIfPresent(declared);
    const match = eligible.find((candidate) => candidate.binary === resolved);
    assert(
      match,
      "STELLA_CLOUD_ACCEPTANCE_BROWSER_BINARY must resolve to a reviewed installed Chromium-family binary.",
    );
    return Object.freeze(match);
  }
  assert(
    eligible.length > 0,
    "No reviewed installed Chromium-family binary is available for rendered browser acceptance.",
  );
  return Object.freeze(eligible[0]);
};

/**
 * Complete metadata-only fingerprint of the live browser profile. Files are
 * never opened and symlinks are never followed. This proves the harness did
 * not write anywhere in the user's real profile without reading cookies,
 * login databases, history, filenames, or other secret-bearing content into
 * evidence (relative names are hashed before entering the observation).
 */
const browserProfileMetadataSha256 = (
  profileRoot,
  {
    excludedRelativePaths = new Set(),
    ignoreDirectoryMutationMetadata = false,
  } = {},
) => {
  const root = path.resolve(profileRoot);
  const observations = [];
  const visit = (candidate, relativePath) => {
    if (excludedRelativePaths.has(relativePath)) return;
    const info = lstatSync(candidate, { bigint: true });
    const isDirectory = info.isDirectory() && !info.isSymbolicLink();
    observations.push({
      relativePathSha256: sha256(relativePath),
      kind: info.isSymbolicLink()
        ? "symlink"
        : info.isDirectory()
          ? "directory"
          : info.isFile()
            ? "file"
            : "other",
      dev: String(info.dev),
      ino: String(info.ino),
      mode: String(info.mode),
      ...(!isDirectory || !ignoreDirectoryMutationMetadata
        ? {
            size: String(info.size),
            mtimeNs: String(info.mtimeNs),
            ctimeNs: String(info.ctimeNs),
          }
        : {}),
    });
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    const names = readdirSync(candidate).sort();
    assert(
      observations.length + names.length <= 250_000,
      "Live browser profile metadata exceeds the strict proof bound.",
    );
    for (const name of names) {
      visit(
        path.join(candidate, name),
        relativePath ? `${relativePath}/${name}` : name,
      );
    }
  };
  try {
    visit(root, "");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    observations.push({ relativePathSha256: sha256(""), kind: "absent" });
  }
  return sha256(canonicalJson(observations));
};

export const liveBrowserProfileMetadataSha256 = (profileRoot) =>
  browserProfileMetadataSha256(profileRoot);

const OWNED_PROFILE_VOLATILE_PATHS = new Set([
  "DevToolsActivePort",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
]);

/**
 * Metadata-only continuity fingerprint for the disposable harness profile.
 * Browser lock and CDP discovery files are intentionally omitted, but cookies,
 * storage databases, and their names are never opened or returned. Removing or
 * replacing durable profile state still changes this digest.
 */
export const ownedBrowserProfileContinuitySha256 = (profileRoot) =>
  browserProfileMetadataSha256(profileRoot, {
    excludedRelativePaths: OWNED_PROFILE_VOLATILE_PATHS,
    ignoreDirectoryMutationMetadata: true,
  });

const sha256File = async (filePath) =>
  await new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(digest.digest("hex")));
  });

const processAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const chromiumEnvironment = (env) => {
  const allowed = [
    "PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "DISPLAY",
    "XDG_RUNTIME_DIR",
  ];
  return Object.fromEntries(
    allowed
      .filter((key) => typeof env[key] === "string" && env[key].length > 0)
      .map((key) => [key, env[key]]),
  );
};

const processFingerprintSha256 = async (pid) => {
  const result = await execFileAsync(
    "/bin/ps",
    ["-p", String(pid), "-o", "lstart=,command="],
    {
      timeout: 5_000,
      maxBuffer: 256_000,
    },
  );
  assert(result.stdout.trim().length > 0, "Browser process is unavailable.");
  return sha256(result.stdout.trim());
};

const assertReviewedBrowserQuiescent = async (browser) => {
  const result = await execFileAsync("/bin/ps", ["-axo", "command="], {
    timeout: 5_000,
    maxBuffer: 4_000_000,
  });
  const running = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .some(
      (command) =>
        command === browser.binary || command.startsWith(`${browser.binary} `),
    );
  assert(
    !running,
    "Reviewed browser is already running; choose a quiescent allowlisted binary so live-profile isolation is unambiguous.",
  );
};

const loopbackListenerName = (name, port) => {
  const normalized = name.replace(/ \(LISTEN\)$/u, "");
  if (normalized === `127.0.0.1:${port}` || normalized === `[::1]:${port}`) {
    return normalized;
  }
  return null;
};

/** Parse lsof field output without accepting wildcard or non-loopback binds. */
export const parseLoopbackCdpListenerRecords = (output, { pid, port }) => {
  assert(typeof output === "string", "Rendered lsof output is invalid.");
  assert(
    Number.isSafeInteger(pid) && pid > 0,
    "Rendered listener pid is invalid.",
  );
  assert(
    Number.isSafeInteger(port) && port >= 1_024 && port <= 65_535,
    "Rendered listener port is invalid.",
  );
  let currentPid = null;
  const records = [];
  for (const line of output.split(/\r?\n/u)) {
    if (/^p\d+$/u.test(line)) {
      currentPid = Number(line.slice(1));
      continue;
    }
    if (line.startsWith("n")) {
      assert(
        Number.isSafeInteger(currentPid) && currentPid > 0,
        "Rendered listener name has no owning pid.",
      );
      records.push({ pid: currentPid, name: line.slice(1) });
    }
  }
  assert(records.length > 0, "Rendered CDP listener has no address record.");
  const addresses = records.map((record) => {
    assert(
      record.pid === pid,
      "Rendered CDP listener includes a different owning process.",
    );
    const address = loopbackListenerName(record.name, port);
    assert(
      address !== null,
      "Rendered CDP listener is not bound exclusively to loopback.",
    );
    return address;
  });
  const uniqueAddresses = [...new Set(addresses)].sort();
  return Object.freeze({
    listenerAddressCount: uniqueAddresses.length,
    listenerAddressesSha256: sha256(canonicalJson(uniqueAddresses)),
  });
};

const assertCdpListenerOwnership = async ({
  port,
  pid,
  processFingerprintSha256: expectedFingerprint,
}) => {
  assert(
    Number.isSafeInteger(pid) && pid > 0,
    "Rendered CDP owner pid is invalid.",
  );
  requireSha256(expectedFingerprint, "Rendered CDP process fingerprint");
  const executable = process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof";
  const result = await execFileAsync(
    executable,
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"],
    { timeout: 5_000, maxBuffer: 128_000 },
  );
  const listener = parseLoopbackCdpListenerRecords(result.stdout, {
    pid,
    port,
  });
  assert(
    (await processFingerprintSha256(pid)) === expectedFingerprint,
    "Rendered CDP owner process fingerprint changed.",
  );
  return Object.freeze({
    processIdSha256: sha256(String(pid)),
    processFingerprintSha256: expectedFingerprint,
    listenerPortSha256: sha256(String(port)),
    listenerAddressCount: listener.listenerAddressCount,
    listenerAddressesSha256: listener.listenerAddressesSha256,
  });
};

export const fingerprintRenderedProcess = async (pid) =>
  await processFingerprintSha256(pid);

const processGroupAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
};

const signalProcessGroup = (pid, signal) => {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
};

const waitForProcessGroupExit = async (pid, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!processGroupAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new CloudProofError(
    "Isolated browser process group did not exit before timeout.",
  );
};

const profileMarkerBase = (harnessRoot, profile) => ({
  contract: RENDERED_CLIENT_CDP_CONTRACT,
  harnessRootSha256: sha256(realpathSync(harnessRoot)),
  profilePathSha256: sha256(profile),
});

const prepareOwnedBrowserProfile = async ({ harnessRoot, profile, mode }) => {
  assert(
    mode === "fresh" || mode === "reuse",
    "Rendered browser profile mode must be fresh or reuse.",
  );
  const expected = profileMarkerBase(harnessRoot, profile);
  const marker = path.join(profile, PROFILE_OWNERSHIP_MARKER);
  let markerBody;
  let profileContinuityBeforeLaunchSha256;
  if (mode === "fresh") {
    await mkdir(profile, { recursive: false, mode: 0o700 }).catch(
      async (error) => {
        if (error?.code !== "EEXIST") throw error;
        const entries = await readdir(profile);
        assert(
          entries.length === 0,
          "Fresh rendered browser profile must be empty before launch.",
        );
      },
    );
    markerBody = { ...expected, profileInstanceId: randomUUID() };
    await writeFile(marker, `${JSON.stringify(markerBody)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    profileContinuityBeforeLaunchSha256 =
      ownedBrowserProfileContinuitySha256(profile);
  } else {
    const parsed = JSON.parse(await readFile(marker, "utf8"));
    assert(
      isRecord(parsed) &&
        parsed.contract === expected.contract &&
        parsed.harnessRootSha256 === expected.harnessRootSha256 &&
        parsed.profilePathSha256 === expected.profilePathSha256 &&
        typeof parsed.profileInstanceId === "string" &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
          parsed.profileInstanceId,
        ) &&
        Object.keys(parsed).sort().join(",") ===
          [
            "contract",
            "harnessRootSha256",
            "profileInstanceId",
            "profilePathSha256",
          ]
            .sort()
            .join(","),
      "Reusable rendered browser profile is not owned by this harness.",
    );
    markerBody = parsed;
    try {
      lstatSync(path.join(profile, "SingletonLock"));
      throw new CloudProofError(
        "Reusable rendered browser profile is already locked by a browser.",
      );
    } catch (error) {
      if (error instanceof CloudProofError) throw error;
      if (error?.code !== "ENOENT") throw error;
    }
    // Capture the complete quiescent durable metadata before deleting Chrome's
    // volatile discovery file. It must match the preceding verified stop.
    profileContinuityBeforeLaunchSha256 =
      ownedBrowserProfileContinuitySha256(profile);
    // Chrome may leave this discovery file after a clean exit. Remove the
    // exact harness-owned file before spawning so waitForOwnedCdp can only
    // consume an endpoint published by this launch.
    await unlink(path.join(profile, "DevToolsActivePort")).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  assert(
    realpathSync(profile) === profile && lstatSync(profile).isDirectory(),
    "Rendered browser profile must be a real directory, not a symlink.",
  );
  return Object.freeze({
    profileOwnershipSha256: sha256(canonicalJson(markerBody)),
    profileInstanceSha256: sha256(markerBody.profileInstanceId),
    profilePathSha256: expected.profilePathSha256,
    profileContinuityBeforeLaunchSha256,
  });
};

const waitForCdp = async (port, timeoutMs = CDP_CONNECT_TIMEOUT_MS) =>
  await poll(
    async () => {
      try {
        const response = await requestJson(
          `http://127.0.0.1:${port}/json/version`,
          {
            label: "isolated browser CDP version",
            timeoutMs: 1_000,
            method: "GET",
            maxResponseBytes: 128_000,
          },
        );
        return response.body;
      } catch {
        return null;
      }
    },
    (value) =>
      isRecord(value) && typeof value.webSocketDebuggerUrl === "string",
    { timeoutMs, intervalMs: 100, label: "isolated browser CDP" },
  );

const waitForOwnedCdp = async (profile, timeoutMs = CDP_CONNECT_TIMEOUT_MS) =>
  await poll(
    async () => {
      try {
        const activePortText = await readFile(
          path.join(profile, "DevToolsActivePort"),
          "utf8",
        );
        assert(
          Buffer.byteLength(activePortText, "utf8") <= 4_096,
          "Owned DevToolsActivePort exceeded its bound.",
        );
        const [portText, browserPath] = activePortText.trim().split(/\r?\n/u);
        const port = Number(portText);
        if (
          !Number.isSafeInteger(port) ||
          port < 1_024 ||
          port > 65_535 ||
          !/^\/devtools\/browser\/[A-Za-z0-9-]+$/u.test(browserPath ?? "")
        ) {
          return null;
        }
        const version = await waitForCdp(port, 1_000);
        const debuggerUrl = new URL(version.webSocketDebuggerUrl);
        if (
          debuggerUrl.protocol !== "ws:" ||
          debuggerUrl.hostname !== "127.0.0.1" ||
          Number(debuggerUrl.port) !== port ||
          debuggerUrl.pathname !== browserPath
        ) {
          return null;
        }
        return { port, version, browserPathSha256: sha256(browserPath) };
      } catch {
        return null;
      }
    },
    (value) =>
      isRecord(value) &&
      Number.isSafeInteger(value.port) &&
      isRecord(value.version),
    { timeoutMs, intervalMs: 50, label: "owned isolated browser CDP" },
  );

export const launchIsolatedChromium = async ({
  harnessRoot,
  profileDirectory,
  debugPort = 0,
  appUrl,
  profileMode = "fresh",
  headless = true,
  env = process.env,
}) => {
  assert(
    typeof env.STELLA_CLOUD_ACCEPTANCE_BROWSER_BINARY === "string" &&
      env.STELLA_CLOUD_ACCEPTANCE_BROWSER_BINARY.trim().length > 0,
    "Rendered acceptance requires an explicit reviewed browser binary.",
  );
  const reviewedBrowser = resolveReviewedChromiumBinary({ env });
  await assertReviewedBrowserQuiescent(reviewedBrowser);
  assert(
    debugPort === 0,
    "Isolated browser CDP must use Chrome-owned ephemeral port 0.",
  );
  assert(
    headless === true,
    "Strict rendered acceptance currently supports only deterministic headless Chromium.",
  );
  const parsedAppUrl = new URL(appUrl);
  assert(
    parsedAppUrl.protocol === "http:" &&
      (parsedAppUrl.hostname === "127.0.0.1" ||
        parsedAppUrl.hostname === "localhost"),
    "Rendered browser acceptance may open only a loopback product shell.",
  );
  const profile = assertIsolatedRenderedClientPath(
    profileDirectory,
    harnessRoot,
  );
  const profileIdentity = await prepareOwnedBrowserProfile({
    harnessRoot,
    profile,
    mode: profileMode,
  });
  const isolatedHome = assertIsolatedRenderedClientPath(
    path.join(harnessRoot, "browser-home"),
    harnessRoot,
  );
  const isolatedConfig = assertIsolatedRenderedClientPath(
    path.join(isolatedHome, "config"),
    harnessRoot,
  );
  const isolatedCache = assertIsolatedRenderedClientPath(
    path.join(isolatedHome, "cache"),
    harnessRoot,
  );
  await mkdir(isolatedConfig, { recursive: true, mode: 0o700 });
  await mkdir(isolatedCache, { recursive: true, mode: 0o700 });

  const quiescentProfileMetadata = liveBrowserProfileMetadataSha256(
    reviewedBrowser.liveProfile,
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  const liveProfileMetadataBefore = liveBrowserProfileMetadataSha256(
    reviewedBrowser.liveProfile,
  );
  assert(
    quiescentProfileMetadata === liveProfileMetadataBefore,
    "Reviewed browser live profile is changing while quiescent; isolation proof cannot start.",
  );
  const binarySha256 = await sha256File(reviewedBrowser.binary);
  const version = await execFileAsync(reviewedBrowser.binary, ["--version"], {
    timeout: 10_000,
    maxBuffer: 128_000,
  });
  const versionSha256 = sha256(`${version.stdout}${version.stderr}`);
  const browserArguments = [
    `--user-data-dir=${profile}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-features=OptimizationHints,MediaRouter",
    "--headless=new",
    "--window-size=1440,1000",
    "about:blank",
  ];
  const child = spawn(reviewedBrowser.binary, browserArguments, {
    cwd: harnessRoot,
    env: {
      ...chromiumEnvironment(env),
      HOME: isolatedHome,
      XDG_CONFIG_HOME: isolatedConfig,
      XDG_CACHE_HOME: isolatedCache,
    },
    detached: true,
    shell: false,
    // Chromium stdout/stderr can contain visited URLs or renderer output.
    // Strict acceptance never persists it; CDP supplies hash-only evidence.
    stdio: "ignore",
  });
  child.unref();
  assert(child.pid && child.pid > 0, "Isolated browser returned no pid.");
  try {
    const ownedCdp = await waitForOwnedCdp(profile);
    const cdpVersion = ownedCdp.version;
    assert(processAlive(child.pid), "Isolated browser exited during startup.");
    const processFingerprint = await processFingerprintSha256(child.pid);
    return Object.freeze({
      contract: RENDERED_CLIENT_CDP_CONTRACT,
      surface: "browser-cdp",
      flavor: reviewedBrowser.flavor,
      headless,
      binary: reviewedBrowser.binary,
      binarySha256,
      versionSha256,
      cdpBrowserSha256: sha256(String(cdpVersion.Browser ?? "")),
      pid: child.pid,
      pidSha256: sha256(String(child.pid)),
      processFingerprintSha256: processFingerprint,
      profile,
      profileSha256: profileIdentity.profileInstanceSha256,
      profileInstanceSha256: profileIdentity.profileInstanceSha256,
      profilePathSha256: profileIdentity.profilePathSha256,
      profileOwnershipSha256: profileIdentity.profileOwnershipSha256,
      profileContinuityBeforeLaunchSha256:
        profileIdentity.profileContinuityBeforeLaunchSha256,
      profileMode,
      debugPort: ownedCdp.port,
      cdpBrowserPathSha256: ownedCdp.browserPathSha256,
      appOrigin: parsedAppUrl.origin,
      appUrlSha256: sha256(parsedAppUrl.href),
      liveProfile: reviewedBrowser.liveProfile,
      liveProfileMetadataBefore,
    });
  } catch (error) {
    signalProcessGroup(child.pid, "SIGTERM");
    try {
      await waitForProcessGroupExit(child.pid, 5_000);
    } catch {
      signalProcessGroup(child.pid, "SIGKILL");
      await waitForProcessGroupExit(child.pid, 5_000).catch(() => undefined);
    }
    throw error;
  }
};

export const stopIsolatedChromium = async (
  browser,
  { timeoutMs = 15_000 } = {},
) => {
  assert(
    browser?.surface === "browser-cdp" &&
      Number.isSafeInteger(browser.pid) &&
      browser.pid > 0,
    "Invalid isolated browser process.",
  );
  if (processGroupAlive(browser.pid)) {
    const currentFingerprint = await processFingerprintSha256(browser.pid);
    assert(
      currentFingerprint === browser.processFingerprintSha256,
      "Isolated browser pid was reused; refusing to signal it.",
    );
    signalProcessGroup(browser.pid, "SIGTERM");
    try {
      await waitForProcessGroupExit(browser.pid, timeoutMs);
    } catch {
      if (processGroupAlive(browser.pid)) {
        signalProcessGroup(browser.pid, "SIGKILL");
      }
      await waitForProcessGroupExit(browser.pid, 5_000);
    }
  }
  const liveProfileMetadataAfter = liveBrowserProfileMetadataSha256(
    browser.liveProfile,
  );
  assert(
    liveProfileMetadataAfter === browser.liveProfileMetadataBefore,
    "The live browser profile changed during isolated acceptance; proof is ambiguous.",
  );
  const processInstanceSha256 = sha256(
    canonicalJson({
      processIdSha256: browser.pidSha256,
      processFingerprintSha256: browser.processFingerprintSha256,
    }),
  );
  const profileContinuityAfterStopSha256 = ownedBrowserProfileContinuitySha256(
    browser.profile,
  );
  return Object.freeze({
    stopped: true,
    pidSha256: browser.pidSha256,
    processInstanceSha256,
    profileSha256: browser.profileSha256,
    profilePathSha256: browser.profilePathSha256,
    profileContinuityBeforeLaunchSha256:
      browser.profileContinuityBeforeLaunchSha256,
    profileContinuityAfterStopSha256,
    liveProfileMetadataBefore: browser.liveProfileMetadataBefore,
    liveProfileMetadataAfter,
  });
};

const safeWebSocketUrlObservation = (urlValue) => {
  try {
    const url = new URL(urlValue);
    const expectedOrigin = new URL(REQUIRED_CLOUD_BUILDER_ORIGIN);
    expectedOrigin.protocol =
      expectedOrigin.protocol === "https:" ? "wss:" : "ws:";
    if (url.origin !== expectedOrigin.origin) return null;
    const match = url.pathname.match(/^\/conversations\/([^/]+)\/socket$/u);
    if (!match) return null;
    if (url.searchParams.get("protocol") !== "1") return null;
    const sinceRaw = url.searchParams.get("since");
    const epochRaw = url.searchParams.get("epoch");
    const since = sinceRaw === null ? null : Number(sinceRaw);
    const epoch = epochRaw === null ? null : Number(epochRaw);
    if (since !== null && !Number.isSafeInteger(since)) return null;
    if (epoch !== null && !Number.isSafeInteger(epoch)) return null;
    return {
      requestUrlSha256: sha256(url.href),
      conversationIdSha256: sha256(decodeURIComponent(match[1])),
      since,
      epoch,
    };
  } catch {
    return null;
  }
};

const safeNetworkOriginSha256 = (urlValue) => {
  try {
    const url = new URL(urlValue);
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol === "wss:") url.protocol = "https:";
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return sha256(url.origin);
  } catch {
    return null;
  }
};

const SAFE_CONVERSATION_FRAME_TYPES = new Set([
  "auth",
  "auth.expiring",
  "backfill",
  "cancel",
  "delta",
  "deltas_dropped",
  "error",
  "gap",
  "ready",
  "record",
  "reset",
  "tool",
]);

const frameObservation = (payload) => {
  const observation = {
    payloadSha256: sha256(payload),
    type: "opaque",
  };
  if (payload === "pong") return { ...observation, type: "pong" };
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return observation;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return observation;
  const type = parsed.type;
  const opaqueTypedObservation = {
    ...observation,
    frameTypeSha256: sha256(type),
  };
  if (!SAFE_CONVERSATION_FRAME_TYPES.has(type)) {
    return opaqueTypedObservation;
  }
  if (type === "ready") {
    const values = [
      parsed.epoch,
      parsed.headSeq,
      parsed.windowStartSeq,
      parsed.floorSeq,
    ];
    if (values.every(Number.isSafeInteger)) {
      if (parsed.protocol !== 1 || typeof parsed.conversationId !== "string") {
        return opaqueTypedObservation;
      }
      return {
        ...observation,
        type,
        protocol: parsed.protocol,
        conversationIdSha256: sha256(parsed.conversationId),
        epoch: parsed.epoch,
        headSeq: parsed.headSeq,
        windowStartSeq: parsed.windowStartSeq,
        floorSeq: parsed.floorSeq,
      };
    }
    return opaqueTypedObservation;
  }
  if (type === "record" && Number.isSafeInteger(parsed.seq)) {
    return {
      ...observation,
      type,
      seq: parsed.seq,
      recordKind:
        typeof parsed.kind === "string" ? sha256(parsed.kind) : undefined,
      phase:
        typeof parsed.phase === "string" ? sha256(parsed.phase) : undefined,
      role: typeof parsed.role === "string" ? sha256(parsed.role) : undefined,
    };
  }
  if (
    type === "backfill" &&
    Number.isSafeInteger(parsed.fromSeq) &&
    Number.isSafeInteger(parsed.toSeq)
  ) {
    const recordSeqs = Array.isArray(parsed.records)
      ? parsed.records
          .map((record) => (isRecord(record) ? record.seq : null))
          .filter(Number.isSafeInteger)
      : [];
    return {
      ...observation,
      type,
      requestIdSha256: sha256(String(parsed.requestId ?? "")),
      fromSeq: parsed.fromSeq,
      toSeq: parsed.toSeq,
      complete: parsed.complete === true,
      recordSeqs,
    };
  }
  if (type === "record" || type === "backfill") {
    return opaqueTypedObservation;
  }
  return { ...observation, type };
};

export class RenderedClientCdpSession {
  constructor({
    socket,
    surface,
    targetUrlSha256,
    targetIdSha256 = sha256("<unbound-test-target>"),
    commandTimeoutMs = 30_000,
  }) {
    assert(
      RENDERED_CLIENT_SURFACES.includes(surface),
      "Rendered CDP surface is invalid.",
    );
    this.socket = socket;
    this.surface = surface;
    this.targetUrlSha256 = requireSha256(
      targetUrlSha256,
      "CDP target URL hash",
    );
    this.targetIdSha256 = requireSha256(targetIdSha256, "CDP target id hash");
    this.commandTimeoutMs = commandTimeoutMs;
    this.sequence = 0;
    this.pending = new Map();
    this.requests = [];
    this.responses = [];
    this.networkOriginHashes = new Set();
    this.webSockets = [];
    this.socketByRequestId = new Map();
    this.authSetupUseCount = 0;
    this.closed = false;
    this.messageChain = Promise.resolve();
    this.onMessage = (event) => {
      this.messageChain = this.messageChain
        .then(() => this.handleMessage(event))
        .catch(() => {
          this.handleClose();
          try {
            this.socket.close();
          } catch {
            // Already closing.
          }
        });
    };
    this.onClose = () => this.handleClose();
    socket.addEventListener("message", this.onMessage);
    socket.addEventListener("close", this.onClose, { once: true });
  }

  handleClose() {
    this.closed = true;
    for (const waiter of this.pending.values()) {
      waiter.reject(new CloudProofError("Rendered CDP connection closed."));
      clearTimeout(waiter.timer);
    }
    this.pending.clear();
  }

  async handleMessage(event) {
    const data = event.data;
    let raw;
    if (typeof data === "string") {
      assert(
        Buffer.byteLength(data, "utf8") <= MAX_CDP_MESSAGE_BYTES,
        "Rendered CDP text frame exceeded its bound.",
      );
      raw = data;
    } else if (typeof Blob !== "undefined" && data instanceof Blob) {
      assert(
        data.size <= MAX_CDP_MESSAGE_BYTES,
        "Rendered CDP Blob frame exceeded its bound.",
      );
      raw = new TextDecoder("utf-8", { fatal: true }).decode(
        await data.arrayBuffer(),
      );
    } else if (data instanceof ArrayBuffer) {
      assert(
        data.byteLength <= MAX_CDP_MESSAGE_BYTES,
        "Rendered CDP ArrayBuffer frame exceeded its bound.",
      );
      raw = new TextDecoder("utf-8", { fatal: true }).decode(data);
    } else if (ArrayBuffer.isView(data)) {
      assert(
        data.byteLength <= MAX_CDP_MESSAGE_BYTES,
        "Rendered CDP typed frame exceeded its bound.",
      );
      raw = new TextDecoder("utf-8", { fatal: true }).decode(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
    } else {
      throw new CloudProofError(
        "Rendered CDP returned an unsupported frame type.",
      );
    }
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (Number.isSafeInteger(message.id)) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) {
        waiter.reject(
          new CloudProofError("Rendered CDP command failed.", {
            code: message.error.code,
            messageSha256: sha256(String(message.error.message ?? "")),
          }),
        );
      } else {
        waiter.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message.method !== "string") return;
    this.captureEvent(message.method, message.params ?? {});
  }

  captureEvent(method, params) {
    if (method === "Network.requestWillBeSent") {
      if (this.requests.length >= MAX_TRACKED_REQUESTS) return;
      const request = params.request;
      if (!isRecord(request) || typeof request.url !== "string") return;
      const originSha256 = safeNetworkOriginSha256(request.url);
      if (originSha256) this.networkOriginHashes.add(originSha256);
      // Headers are intentionally ignored: WebSocket subprotocol headers carry
      // the Convex JWT and must never enter harness state.
      this.requests.push({
        requestIdSha256: sha256(String(params.requestId ?? "")),
        urlSha256: sha256(request.url),
        methodSha256: sha256(String(request.method ?? "")),
        typeSha256: sha256(String(params.type ?? "")),
      });
      return;
    }
    if (method === "Network.responseReceived") {
      if (this.responses.length >= MAX_TRACKED_REQUESTS) return;
      const response = params.response;
      if (!isRecord(response) || typeof response.url !== "string") return;
      const originSha256 = safeNetworkOriginSha256(response.url);
      if (originSha256) this.networkOriginHashes.add(originSha256);
      // Response headers and bodies are intentionally never requested. The
      // status plus URL/MIME hashes prove which product route answered while
      // keeping Set-Cookie and payload data outside harness state.
      this.responses.push({
        requestIdSha256: sha256(String(params.requestId ?? "")),
        urlSha256: sha256(response.url),
        status:
          typeof response.status === "number" &&
          Number.isFinite(response.status)
            ? response.status
            : null,
        mimeTypeSha256: sha256(String(response.mimeType ?? "")),
        typeSha256: sha256(String(params.type ?? "")),
      });
      return;
    }
    if (method === "Network.webSocketCreated") {
      const originSha256 = safeNetworkOriginSha256(params.url);
      if (originSha256) this.networkOriginHashes.add(originSha256);
      if (this.webSockets.length >= MAX_TRACKED_SOCKETS) return;
      const safe = safeWebSocketUrlObservation(params.url);
      if (!safe) return;
      const entry = {
        ...safe,
        requestIdSha256: sha256(String(params.requestId ?? "")),
        closed: false,
        frames: [],
        sentFrames: [],
        recordSeqs: [],
      };
      this.webSockets.push(entry);
      this.socketByRequestId.set(String(params.requestId ?? ""), entry);
      return;
    }
    if (method === "Network.webSocketClosed") {
      const entry = this.socketByRequestId.get(String(params.requestId ?? ""));
      if (entry) entry.closed = true;
      return;
    }
    if (method === "Network.webSocketFrameReceived") {
      const entry = this.socketByRequestId.get(String(params.requestId ?? ""));
      const payload = params.response?.payloadData;
      if (!entry || typeof payload !== "string") return;
      const observed = frameObservation(payload);
      if (entry.frames.length < MAX_TRACKED_RECORDS)
        entry.frames.push(observed);
      if (
        observed.type === "record" &&
        Number.isSafeInteger(observed.seq) &&
        entry.recordSeqs.length < MAX_TRACKED_RECORDS
      ) {
        entry.recordSeqs.push(observed.seq);
      }
      if (observed.type === "backfill") {
        for (const seq of observed.recordSeqs) {
          if (entry.recordSeqs.length >= MAX_TRACKED_RECORDS) break;
          entry.recordSeqs.push(seq);
        }
      }
      return;
    }
    if (method === "Network.webSocketFrameSent") {
      const entry = this.socketByRequestId.get(String(params.requestId ?? ""));
      const payload = params.response?.payloadData;
      if (!entry || typeof payload !== "string") return;
      const observed = frameObservation(payload);
      // Auth refresh frames can carry credentials. Only the metadata-only
      // backfill request shape is retained from client-to-server traffic.
      if (
        observed.type === "backfill" &&
        observed.recordSeqs.length === 0 &&
        entry.sentFrames.length < MAX_TRACKED_RECORDS
      ) {
        entry.sentFrames.push(observed);
      }
    }
  }

  async command(method, params = {}, timeoutMs = this.commandTimeoutMs) {
    assert(!this.closed, "Rendered CDP connection is closed.");
    this.sequence += 1;
    const id = this.sequence;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CloudProofError("Rendered CDP command timed out."));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, label, timeoutMs = this.commandTimeoutMs) {
    const result = await this.command(
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      throw new CloudProofError(`${label} threw in the rendered client.`, {
        exceptionSha256: sha256(
          String(result.exceptionDetails.text ?? "rendered exception"),
        ),
      });
    }
    return result.result?.value;
  }

  telemetry() {
    return Object.freeze({
      surface: this.surface,
      targetUrlSha256: this.targetUrlSha256,
      targetIdSha256: this.targetIdSha256,
      requestCount: this.requests.length,
      requestsSha256: sha256(canonicalJson(this.requests)),
      responseCount: this.responses.length,
      responsesSha256: sha256(canonicalJson(this.responses)),
      networkOriginHashes: [...this.networkOriginHashes].sort(),
      networkOriginsSha256: sha256(
        canonicalJson([...this.networkOriginHashes].sort()),
      ),
      sockets: this.webSockets.map((entry) => ({
        requestIdSha256: entry.requestIdSha256,
        requestUrlSha256: entry.requestUrlSha256,
        conversationIdSha256: entry.conversationIdSha256,
        since: entry.since,
        epoch: entry.epoch,
        closed: entry.closed,
        frameCount: entry.frames.length,
        framesSha256: sha256(canonicalJson(entry.frames)),
        sentFramesSha256: sha256(canonicalJson(entry.sentFrames)),
        recordSeqs: [...entry.recordSeqs],
        backfillRequests: entry.sentFrames.map((frame) => ({
          payloadSha256: frame.payloadSha256,
          requestIdSha256: frame.requestIdSha256,
          fromSeq: frame.fromSeq,
          toSeq: frame.toSeq,
        })),
        resetFrameCount: entry.frames.filter((frame) => frame.type === "reset")
          .length,
        gapFrameCount: entry.frames.filter((frame) => frame.type === "gap")
          .length,
        readyFrames: entry.frames
          .filter((frame) => frame.type === "ready")
          .map((frame) => ({
            payloadSha256: frame.payloadSha256,
            protocol: frame.protocol,
            conversationIdSha256: frame.conversationIdSha256,
            epoch: frame.epoch,
            headSeq: frame.headSeq,
            windowStartSeq: frame.windowStartSeq,
            floorSeq: frame.floorSeq,
          })),
      })),
    });
  }

  async drainMessages() {
    await this.messageChain;
  }

  async setOffline(offline) {
    await this.command("Network.emulateNetworkConditions", {
      offline,
      latency: 0,
      downloadThroughput: offline ? 0 : -1,
      uploadThroughput: offline ? 0 : -1,
      connectionType: offline ? "none" : "wifi",
    });
    if (!offline) {
      await this.evaluate(
        `window.dispatchEvent(new Event("online")); true`,
        "wake rendered client after transport restore",
      );
    }
  }

  async reload() {
    await this.command("Page.reload", { ignoreCache: false });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.socket.removeEventListener("message", this.onMessage);
    try {
      this.socket.close();
    } catch {
      // Already closing.
    }
  }
}

export const connectRenderedClientCdp = async ({
  debugPort,
  expectedUrl,
  surface,
  expectedProcess,
  timeoutMs = CDP_CONNECT_TIMEOUT_MS,
  webSocketFactory = (url) => new WebSocket(url),
  verifyEndpointOwnership = assertCdpListenerOwnership,
}) => {
  assert(
    RENDERED_CLIENT_SURFACES.includes(surface),
    "Rendered CDP surface is invalid.",
  );
  assert(
    Number.isSafeInteger(debugPort) &&
      debugPort >= 1_024 &&
      debugPort <= 65_535,
    "Rendered CDP port is invalid.",
  );
  const endpointOwnership = await verifyEndpointOwnership({
    port: debugPort,
    pid: expectedProcess?.pid,
    processFingerprintSha256: expectedProcess?.processFingerprintSha256,
  });
  requireSha256(
    endpointOwnership?.processIdSha256,
    "Rendered endpoint process id hash",
  );
  requireSha256(
    endpointOwnership?.processFingerprintSha256,
    "Rendered endpoint process fingerprint",
  );
  requireSha256(
    endpointOwnership?.listenerPortSha256,
    "Rendered endpoint listener port hash",
  );
  assert(
    Number.isSafeInteger(endpointOwnership?.listenerAddressCount) &&
      endpointOwnership.listenerAddressCount >= 1,
    "Rendered endpoint listener address count is invalid.",
  );
  requireSha256(
    endpointOwnership?.listenerAddressesSha256,
    "Rendered endpoint listener address set hash",
  );
  const expectedTarget = new URL(expectedUrl);
  assert(
    expectedTarget.href === "about:blank" ||
      (expectedTarget.protocol === "http:" &&
        (expectedTarget.hostname === "127.0.0.1" ||
          expectedTarget.hostname === "localhost")),
    "Rendered CDP target must be about:blank or an exact loopback shell URL.",
  );
  const list = await poll(
    async () => {
      try {
        const response = await requestJson(
          `http://127.0.0.1:${debugPort}/json/list`,
          {
            label: `${surface} target list`,
            timeoutMs: 1_000,
            method: "GET",
            maxResponseBytes: 256_000,
          },
        );
        return response.body;
      } catch {
        return null;
      }
    },
    (value) =>
      Array.isArray(value) &&
      value.some(
        (entry) =>
          isRecord(entry) &&
          entry.type === "page" &&
          typeof entry.url === "string" &&
          entry.url === expectedTarget.href &&
          typeof entry.webSocketDebuggerUrl === "string",
      ),
    { timeoutMs, intervalMs: 100, label: `${surface} rendered target` },
  );
  const matchingTargets = list.filter(
    (entry) =>
      isRecord(entry) &&
      entry.type === "page" &&
      typeof entry.url === "string" &&
      entry.url === expectedTarget.href &&
      typeof entry.webSocketDebuggerUrl === "string",
  );
  assert(
    matchingTargets.length === 1 &&
      typeof matchingTargets[0].id === "string" &&
      /^[A-Za-z0-9-]+$/u.test(matchingTargets[0].id),
    `${surface} must expose exactly one matching rendered target.`,
  );
  const target = matchingTargets[0];
  const debuggerUrl = new URL(target.webSocketDebuggerUrl);
  assert(
    debuggerUrl.protocol === "ws:" &&
      debuggerUrl.hostname === "127.0.0.1" &&
      Number(debuggerUrl.port) === debugPort &&
      debuggerUrl.pathname === `/devtools/page/${target.id}`,
    `${surface} debugger target is not owned by the exact loopback CDP endpoint.`,
  );
  const socket = webSocketFactory(debuggerUrl.href);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new CloudProofError(`${surface} CDP socket timed out.`)),
      timeoutMs,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new CloudProofError(`${surface} CDP socket failed.`));
      },
      { once: true },
    );
  });
  const session = new RenderedClientCdpSession({
    socket,
    surface,
    targetUrlSha256: sha256(target.url),
    targetIdSha256: sha256(target.id),
  });
  session.endpointOwnership = endpointOwnership;
  await session.command("Runtime.enable");
  await session.command("Page.enable");
  await session.command("Network.enable", {
    maxTotalBufferSize: MAX_CDP_MESSAGE_BYTES,
    maxResourceBufferSize: MAX_CDP_MESSAGE_BYTES,
  });
  const finalEndpointOwnership = await verifyEndpointOwnership({
    port: debugPort,
    pid: expectedProcess?.pid,
    processFingerprintSha256: expectedProcess?.processFingerprintSha256,
  });
  assert(
    canonicalJson(finalEndpointOwnership) === canonicalJson(endpointOwnership),
    "Rendered CDP endpoint ownership changed during attachment.",
  );
  return session;
};

export const navigateRenderedClient = async (
  client,
  { appUrl, timeoutMs = CDP_CONNECT_TIMEOUT_MS },
) => {
  const target = new URL(appUrl);
  assert(
    target.protocol === "http:" &&
      (target.hostname === "127.0.0.1" || target.hostname === "localhost"),
    "Rendered client may navigate only to its loopback product shell.",
  );
  const navigation = await client.command("Page.navigate", {
    url: target.href,
  });
  assert(
    typeof navigation.frameId === "string" && !navigation.errorText,
    "Rendered product navigation failed.",
  );
  await poll(
    () =>
      client.evaluate(
        `location.href === ${JSON.stringify(target.href)}`,
        `observe ${client.surface} product navigation`,
      ),
    (loaded) => loaded === true,
    {
      timeoutMs,
      intervalMs: 50,
      label: `${client.surface} exact product navigation`,
    },
  );
  return Object.freeze({
    outcome: "navigated",
    appUrlSha256: sha256(target.href),
    appOriginSha256: sha256(target.origin),
  });
};

const pageShaHelper = `async (value) => {
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}`;

const pagePaintedHelper = `(element) => {
  if (!(element instanceof Element) || !element.isConnected) return false;
  if (element.closest('[inert], [hidden], [aria-hidden="true"]')) return false;
  for (let current = element; current instanceof Element; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    if (Number.parseFloat(style.opacity || '1') <= 0.01) return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
}`;

const pageInteractiveHelper = `(element) => {
  const painted = ${pagePaintedHelper};
  if (!painted(element)) return false;
  if (element.matches(':disabled, [readonly], [aria-disabled="true"]')) return false;
  for (let current = element; current instanceof Element; current = current.parentElement) {
    if (getComputedStyle(current).pointerEvents === 'none') return false;
  }
  return true;
}`;

const browserAuthExpression = ({ sessionCookie, convexUrl, convexSiteUrl }) =>
  `(async () => {
    try {
      if (window.electronAPI) throw new Error("wrong surface");
      if (!/^(?:127\\.0\\.0\\.1|localhost)$/u.test(location.hostname)) throw new Error("not loopback");
      const { readRenderedAcceptanceTarget } = await import("/src/dev/rendered-acceptance-target.ts");
      const observedTarget = readRenderedAcceptanceTarget();
      if (observedTarget.convexUrl !== ${JSON.stringify(convexUrl)} || observedTarget.convexSiteUrl !== ${JSON.stringify(convexSiteUrl)}) {
        throw new Error("renderer target mismatch");
      }
      const { applyBrowserAuthSessionCookie } = await import("/src/global/auth/services/auth-storage.ts");
      const { refreshAuthSession, getAuthSessionSnapshot } = await import("/src/global/auth/services/auth-session.ts");
      applyBrowserAuthSessionCookie(${JSON.stringify(sessionCookie)});
      await refreshAuthSession();
      const snapshot = getAuthSessionSnapshot();
      const user = snapshot.data?.user;
      if (!user?.id || snapshot.isPending) throw new Error("authentication failed");
      const hash = ${pageShaHelper};
      return {
        authenticated: true,
        identitySha256: await hash(user.id),
        identityRevision: snapshot.identityRevision,
        anonymous: user.isAnonymous === true,
        targetSha256: await hash(observedTarget.convexUrl + "\\n" + observedTarget.convexSiteUrl),
        convexOriginSha256: await hash(new URL(observedTarget.convexUrl).origin),
        convexSiteOriginSha256: await hash(new URL(observedTarget.convexSiteUrl).origin)
      };
    } catch {
      throw new Error("rendered browser authentication failed");
    }
  })()`;

const electronAuthExpression = ({ sessionCookie, convexUrl, convexSiteUrl }) =>
  `(async () => {
    try {
      if (!window.electronAPI?.system) throw new Error("wrong surface");
      const { readRenderedAcceptanceTarget } = await import("/src/dev/rendered-acceptance-target.ts");
      const observedTarget = readRenderedAcceptanceTarget();
      if (observedTarget.convexUrl !== ${JSON.stringify(convexUrl)} || observedTarget.convexSiteUrl !== ${JSON.stringify(convexSiteUrl)}) {
        throw new Error("renderer target mismatch");
      }
      const applied = await window.electronAPI.system.applyAuthSessionCookie(${JSON.stringify(sessionCookie)});
      if (!applied?.ok) throw new Error("cookie rejected");
      await window.electronAPI.system.configurePiRuntime({
        convexUrl: observedTarget.convexUrl,
        convexSiteUrl: observedTarget.convexSiteUrl
      });
      const { refreshAuthSession, getAuthSessionSnapshot } = await import("/src/global/auth/services/auth-session.ts");
      await refreshAuthSession();
      const snapshot = getAuthSessionSnapshot();
      const user = snapshot.data?.user;
      if (!user?.id || snapshot.isPending) throw new Error("authentication failed");
      const hash = ${pageShaHelper};
      return {
        authenticated: true,
        identitySha256: await hash(user.id),
        identityRevision: snapshot.identityRevision,
        anonymous: user.isAnonymous === true,
        targetSha256: await hash(observedTarget.convexUrl + "\\n" + observedTarget.convexSiteUrl),
        convexOriginSha256: await hash(new URL(observedTarget.convexUrl).origin),
        convexSiteOriginSha256: await hash(new URL(observedTarget.convexSiteUrl).origin)
      };
    } catch {
      throw new Error("rendered Electron authentication failed");
    }
  })()`;

const existingAnonymousElectronExpression = ({ convexUrl, convexSiteUrl }) =>
  `(async () => {
    try {
      if (!window.electronAPI?.system) throw new Error("wrong surface");
      const { readRenderedAcceptanceTarget } = await import("/src/dev/rendered-acceptance-target.ts");
      const observedTarget = readRenderedAcceptanceTarget();
      if (observedTarget.convexUrl !== ${JSON.stringify(convexUrl)} || observedTarget.convexSiteUrl !== ${JSON.stringify(convexSiteUrl)}) {
        throw new Error("renderer target mismatch");
      }
      await window.electronAPI.system.configurePiRuntime({
        convexUrl: observedTarget.convexUrl,
        convexSiteUrl: observedTarget.convexSiteUrl
      });
      const { refreshAuthSession, getAuthSessionSnapshot } = await import("/src/global/auth/services/auth-session.ts");
      await refreshAuthSession();
      const snapshot = getAuthSessionSnapshot();
      const user = snapshot.data?.user;
      const session = snapshot.data?.session;
      const token = await window.electronAPI.system.getConvexAuthToken();
      if (!user?.id || !session?.id || snapshot.isPending || user.isAnonymous !== true || typeof token !== "string" || token.length < 16 || token.length > 16384) {
        throw new Error("existing anonymous authority unavailable");
      }
      const parts = token.split(".");
      if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new Error("invalid jwt");
      const normalized = parts[1].split("-").join("+").split("_").join("/");
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      if (payload.iss !== observedTarget.convexSiteUrl || payload.sub !== user.id || !Number.isSafeInteger(payload.exp) || payload.exp * 1000 <= Date.now() + 60000) {
        throw new Error("jwt authority mismatch");
      }
      const hash = ${pageShaHelper};
      const tokenIdentifier = payload.iss + "|" + payload.sub;
      const identitySha256 = await hash(user.id);
      const sessionIdSha256 = await hash(session.id);
      const jwtSha256 = await hash(token);
      const jwtIssuerSha256 = await hash(payload.iss);
      const jwtSubjectSha256 = await hash(payload.sub);
      const jwtTokenIdentifierSha256 = await hash(tokenIdentifier);
      return {
        authenticated: true,
        anonymous: true,
        identityClass: "anonymous-secondary",
        identityRevision: snapshot.identityRevision,
        identitySha256,
        sessionIdSha256,
        jwtSha256,
        jwtIssuerSha256,
        jwtSubjectSha256,
        jwtTokenIdentifierSha256,
        ownerAccountSha256: jwtTokenIdentifierSha256,
        jwtExpirySha256: await hash(String(payload.exp)),
        sessionJwtBindingSha256: await hash(identitySha256 + "\\n" + sessionIdSha256 + "\\n" + jwtTokenIdentifierSha256),
        targetSha256: await hash(observedTarget.convexUrl + "\\n" + observedTarget.convexSiteUrl),
        convexOriginSha256: await hash(new URL(observedTarget.convexUrl).origin),
        convexSiteOriginSha256: await hash(new URL(observedTarget.convexSiteUrl).origin)
      };
    } catch {
      throw new Error("existing anonymous Electron verification failed");
    }
  })()`;

const existingPrimaryBrowserExpression = ({ convexUrl, convexSiteUrl }) =>
  `(async () => {
    try {
      if (window.electronAPI) throw new Error("wrong surface");
      if (!/^(?:127\\.0\\.0\\.1|localhost)$/u.test(location.hostname)) throw new Error("not loopback");
      const { readRenderedAcceptanceTarget } = await import("/src/dev/rendered-acceptance-target.ts");
      const observedTarget = readRenderedAcceptanceTarget();
      if (observedTarget.convexUrl !== ${JSON.stringify(convexUrl)} || observedTarget.convexSiteUrl !== ${JSON.stringify(convexSiteUrl)}) {
        throw new Error("renderer target mismatch");
      }
      const { refreshAuthSession, getAuthSessionSnapshot } = await import("/src/global/auth/services/auth-session.ts");
      const { getConvexToken } = await import("/src/global/auth/services/auth-token.ts");
      await refreshAuthSession();
      const snapshot = getAuthSessionSnapshot();
      const user = snapshot.data?.user;
      const session = snapshot.data?.session;
      const token = await getConvexToken({ forceRefresh: true });
      if (!user?.id || !session?.id || snapshot.isPending || user.isAnonymous === true || typeof token !== "string" || token.length < 16 || token.length > 16384) {
        throw new Error("existing primary authority unavailable");
      }
      const parts = token.split(".");
      if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new Error("invalid jwt");
      const normalized = parts[1].split("-").join("+").split("_").join("/");
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      if (payload.iss !== observedTarget.convexSiteUrl || payload.sub !== user.id || !Number.isSafeInteger(payload.exp) || payload.exp * 1000 <= Date.now() + 60000) {
        throw new Error("jwt authority mismatch");
      }
      const hash = ${pageShaHelper};
      const tokenIdentifier = payload.iss + "|" + payload.sub;
      const identitySha256 = await hash(user.id);
      const sessionIdSha256 = await hash(session.id);
      const jwtSha256 = await hash(token);
      const jwtIssuerSha256 = await hash(payload.iss);
      const jwtSubjectSha256 = await hash(payload.sub);
      const jwtTokenIdentifierSha256 = await hash(tokenIdentifier);
      return {
        authenticated: true,
        anonymous: false,
        identityClass: "non-anonymous",
        identityRevision: snapshot.identityRevision,
        identitySha256,
        sessionIdSha256,
        jwtSha256,
        jwtIssuerSha256,
        jwtSubjectSha256,
        jwtTokenIdentifierSha256,
        ownerAccountSha256: jwtTokenIdentifierSha256,
        jwtExpirySha256: await hash(String(payload.exp)),
        sessionJwtBindingSha256: await hash(identitySha256 + "\\n" + sessionIdSha256 + "\\n" + jwtTokenIdentifierSha256),
        targetSha256: await hash(observedTarget.convexUrl + "\\n" + observedTarget.convexSiteUrl),
        convexOriginSha256: await hash(new URL(observedTarget.convexUrl).origin),
        convexSiteOriginSha256: await hash(new URL(observedTarget.convexSiteUrl).origin)
      };
    } catch {
      throw new Error("existing primary browser verification failed");
    }
  })()`;

const existingPrimaryElectronExpression = ({ convexUrl, convexSiteUrl }) =>
  `(async () => {
    try {
      if (!window.electronAPI?.system) throw new Error("wrong surface");
      const { readRenderedAcceptanceTarget } = await import("/src/dev/rendered-acceptance-target.ts");
      const observedTarget = readRenderedAcceptanceTarget();
      if (observedTarget.convexUrl !== ${JSON.stringify(convexUrl)} || observedTarget.convexSiteUrl !== ${JSON.stringify(convexSiteUrl)}) {
        throw new Error("renderer target mismatch");
      }
      await window.electronAPI.system.configurePiRuntime({
        convexUrl: observedTarget.convexUrl,
        convexSiteUrl: observedTarget.convexSiteUrl
      });
      const { refreshAuthSession, getAuthSessionSnapshot } = await import("/src/global/auth/services/auth-session.ts");
      await refreshAuthSession();
      const snapshot = getAuthSessionSnapshot();
      const user = snapshot.data?.user;
      const session = snapshot.data?.session;
      const token = await window.electronAPI.system.getConvexAuthToken();
      if (!user?.id || !session?.id || snapshot.isPending || user.isAnonymous === true || typeof token !== "string" || token.length < 16 || token.length > 16384) {
        throw new Error("existing primary authority unavailable");
      }
      const parts = token.split(".");
      if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new Error("invalid jwt");
      const normalized = parts[1].split("-").join("+").split("_").join("/");
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
      const binary = atob(padded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      if (payload.iss !== observedTarget.convexSiteUrl || payload.sub !== user.id || !Number.isSafeInteger(payload.exp) || payload.exp * 1000 <= Date.now() + 60000) {
        throw new Error("jwt authority mismatch");
      }
      const hash = ${pageShaHelper};
      const tokenIdentifier = payload.iss + "|" + payload.sub;
      const identitySha256 = await hash(user.id);
      const sessionIdSha256 = await hash(session.id);
      const jwtSha256 = await hash(token);
      const jwtIssuerSha256 = await hash(payload.iss);
      const jwtSubjectSha256 = await hash(payload.sub);
      const jwtTokenIdentifierSha256 = await hash(tokenIdentifier);
      return {
        authenticated: true,
        anonymous: false,
        identityClass: "non-anonymous",
        identityRevision: snapshot.identityRevision,
        identitySha256,
        sessionIdSha256,
        jwtSha256,
        jwtIssuerSha256,
        jwtSubjectSha256,
        jwtTokenIdentifierSha256,
        ownerAccountSha256: jwtTokenIdentifierSha256,
        jwtExpirySha256: await hash(String(payload.exp)),
        sessionJwtBindingSha256: await hash(identitySha256 + "\\n" + sessionIdSha256 + "\\n" + jwtTokenIdentifierSha256),
        targetSha256: await hash(observedTarget.convexUrl + "\\n" + observedTarget.convexSiteUrl),
        convexOriginSha256: await hash(new URL(observedTarget.convexUrl).origin),
        convexSiteOriginSha256: await hash(new URL(observedTarget.convexSiteUrl).origin)
      };
    } catch {
      throw new Error("existing primary Electron verification failed");
    }
  })()`;

const EXISTING_RENDERED_AUTHORITY_RESULT_KEYS = Object.freeze(
  [
    "anonymous",
    "authenticated",
    "convexOriginSha256",
    "convexSiteOriginSha256",
    "identityClass",
    "identityRevision",
    "identitySha256",
    "jwtExpirySha256",
    "jwtIssuerSha256",
    "jwtSha256",
    "jwtSubjectSha256",
    "jwtTokenIdentifierSha256",
    "ownerAccountSha256",
    "sessionIdSha256",
    "sessionJwtBindingSha256",
    "targetSha256",
  ].sort(),
);

const validateExistingRenderedAuthorityResult = (
  value,
  { anonymous, identityClass, label },
) => {
  assert(
    isRecord(value) &&
      Object.keys(value).sort().join(",") ===
        EXISTING_RENDERED_AUTHORITY_RESULT_KEYS.join(","),
    `${label} returned an unsafe result shape.`,
  );
  assert(
    value.authenticated === true &&
      value.anonymous === anonymous &&
      value.identityClass === identityClass &&
      Number.isSafeInteger(value.identityRevision) &&
      value.identityRevision >= 0,
    `${label} is not the required rendered authority.`,
  );
  for (const [digestLabel, digest] of Object.entries({
    identity: value.identitySha256,
    "session id": value.sessionIdSha256,
    JWT: value.jwtSha256,
    "JWT issuer": value.jwtIssuerSha256,
    "JWT subject": value.jwtSubjectSha256,
    "JWT token identifier": value.jwtTokenIdentifierSha256,
    "owner account": value.ownerAccountSha256,
    "JWT expiry": value.jwtExpirySha256,
    "session JWT binding": value.sessionJwtBindingSha256,
    target: value.targetSha256,
    "Convex origin": value.convexOriginSha256,
    "Convex site origin": value.convexSiteOriginSha256,
  })) {
    requireSha256(digest, `${label} ${digestLabel}`);
  }
  assert(
    value.jwtSubjectSha256 === value.identitySha256 &&
      value.ownerAccountSha256 === value.jwtTokenIdentifierSha256,
    `${label} JWT is not bound to the rendered identity.`,
  );
};

const verifyExistingRenderedAuthorityProfile = async (
  client,
  {
    surface,
    convexUrl,
    convexSiteUrl,
    expression,
    evaluationLabel,
    resultLabel,
    networkLabel,
    anonymous,
    identityClass,
    expectedIdentitySha256,
    expectedSessionIdSha256,
    expectedOwnerAccountSha256,
  },
) => {
  assert(client.surface === surface, `${resultLabel} requires ${surface}.`);
  assert(
    convexUrl === REQUIRED_CONVEX.cloudUrl &&
      convexSiteUrl === REQUIRED_CONVEX.siteUrl,
    `${resultLabel} is pinned to the reviewed dev Convex target.`,
  );
  assert(
    client.authSetupUseCount === 0,
    `${resultLabel} must run before any cookie setup seam.`,
  );
  const expected = [
    expectedIdentitySha256,
    expectedSessionIdSha256,
    expectedOwnerAccountSha256,
  ];
  const continuityExpected = expected.every((value) => value !== null);
  assert(
    continuityExpected || expected.every((value) => value === null),
    `${resultLabel} continuity expectations must be supplied together.`,
  );
  if (continuityExpected) {
    requireSha256(expectedIdentitySha256, `Expected ${resultLabel} identity`);
    requireSha256(
      expectedSessionIdSha256,
      `Expected ${resultLabel} session id`,
    );
    requireSha256(
      expectedOwnerAccountSha256,
      `Expected ${resultLabel} owner account`,
    );
  }
  const observe = async () =>
    await client.evaluate(expression, evaluationLabel, 60_000);
  let result = await observe();
  validateExistingRenderedAuthorityResult(result, {
    anonymous,
    identityClass,
    label: resultLabel,
  });
  const expectedConvexOriginSha256 = sha256(new URL(convexUrl).origin);
  const expectedConvexSiteOriginSha256 = sha256(new URL(convexSiteUrl).origin);
  const expectedTargetSha256 = sha256(`${convexUrl}\n${convexSiteUrl}`);
  assert(
    result.convexOriginSha256 === expectedConvexOriginSha256 &&
      result.convexSiteOriginSha256 === expectedConvexSiteOriginSha256 &&
      result.targetSha256 === expectedTargetSha256 &&
      result.jwtIssuerSha256 === sha256(convexSiteUrl),
    `${resultLabel} is not cryptographically bound to the reviewed target.`,
  );
  // Browser auth/token requests happen in this renderer and therefore both
  // reviewed origins must be visible to CDP. Electron obtains its JWT through
  // main-process IPC: renderer CDP must still observe the Convex cloud origin,
  // while the exact signed JWT issuer above binds the unobservable site hop.
  const requiredNetworkOrigins =
    surface === "browser-cdp"
      ? [expectedConvexOriginSha256, expectedConvexSiteOriginSha256]
      : [expectedConvexOriginSha256];
  const initialOrigins = client.telemetry().networkOriginHashes;
  if (
    !requiredNetworkOrigins.every((digest) => initialOrigins.includes(digest))
  ) {
    await client.setOffline(true);
    await new Promise((resolve) => setTimeout(resolve, 75));
    await client.setOffline(false);
    result = await observe();
    validateExistingRenderedAuthorityResult(result, {
      anonymous,
      identityClass,
      label: resultLabel,
    });
  }
  const observedNetwork = await poll(
    () => Promise.resolve(client.telemetry()),
    (telemetry) =>
      requiredNetworkOrigins.every((digest) =>
        telemetry.networkOriginHashes.includes(digest),
      ),
    {
      timeoutMs: 30_000,
      intervalMs: 100,
      label: networkLabel,
    },
  );
  assert(
    client.authSetupUseCount === 0,
    `${resultLabel} used a cookie setup seam.`,
  );
  if (continuityExpected) {
    assert(
      result.identitySha256 === expectedIdentitySha256 &&
        result.sessionIdSha256 === expectedSessionIdSha256 &&
        result.ownerAccountSha256 === expectedOwnerAccountSha256,
      `${resultLabel} did not preserve its authority.`,
    );
  }
  return Object.freeze({
    ...result,
    existingProfileContinuityVerified: continuityExpected,
    credentialMaterialReturned: false,
    networkOriginsSha256: observedNetwork.networkOriginsSha256,
  });
};

export const authenticateRenderedClient = async (
  client,
  {
    sessionCookie,
    convexUrl,
    convexSiteUrl,
    expectedIdentityClass = "non-anonymous",
  },
) => {
  assert(
    typeof sessionCookie === "string" && sessionCookie.length > 0,
    "Rendered-client session cookie is required.",
  );
  assert(
    convexUrl === REQUIRED_CONVEX.cloudUrl &&
      convexSiteUrl === REQUIRED_CONVEX.siteUrl,
    "Rendered-client authentication is pinned to the reviewed dev Convex target.",
  );
  assert(
    expectedIdentityClass === "non-anonymous" ||
      expectedIdentityClass === "anonymous-secondary",
    "Rendered identity class is invalid.",
  );
  assert(
    Number.isSafeInteger(client.authSetupUseCount) &&
      client.authSetupUseCount >= 0,
    "Rendered auth setup counter is invalid.",
  );
  client.authSetupUseCount += 1;
  const expression =
    client.surface === "browser-cdp"
      ? browserAuthExpression({ sessionCookie, convexUrl, convexSiteUrl })
      : electronAuthExpression({ sessionCookie, convexUrl, convexSiteUrl });
  const result = await client.evaluate(
    expression,
    `authenticate ${client.surface}`,
    60_000,
  );
  assert(
    result?.authenticated === true,
    "Rendered client is not authenticated.",
  );
  if (expectedIdentityClass === "anonymous-secondary") {
    assert(
      result.anonymous === true,
      "Rendered disposable secondary identity must be anonymous.",
    );
  } else {
    assert(
      result.anonymous === false,
      "Rendered acceptance requires a non-anonymous signed-in identity.",
    );
  }
  requireSha256(result.identitySha256, "Rendered identity hash");
  requireSha256(result.targetSha256, "Rendered auth target hash");
  requireSha256(result.convexOriginSha256, "Rendered Convex origin hash");
  requireSha256(
    result.convexSiteOriginSha256,
    "Rendered Convex site origin hash",
  );
  const initiallyObservedOrigins = client.telemetry().networkOriginHashes;
  if (
    !initiallyObservedOrigins.includes(result.convexOriginSha256) ||
    !initiallyObservedOrigins.includes(result.convexSiteOriginSha256)
  ) {
    // CDP can attach after the shell's first anonymous socket opened. Force a
    // renderer-network cycle, then perform an authoritative session read so
    // both the configured Convex websocket and auth HTTP origins are observed
    // after Network.enable rather than trusted from caller input.
    await client.setOffline(true);
    await new Promise((resolve) => setTimeout(resolve, 75));
    await client.setOffline(false);
    await client.evaluate(
      `(async () => {
        const { refreshAuthSession } = await import("/src/global/auth/services/auth-session.ts");
        await refreshAuthSession();
        return true;
      })()`,
      `reobserve ${client.surface} auth network origin`,
      60_000,
    );
  }
  const observedNetwork = await poll(
    () => Promise.resolve(client.telemetry()),
    (telemetry) =>
      telemetry.networkOriginHashes.includes(result.convexOriginSha256) &&
      telemetry.networkOriginHashes.includes(result.convexSiteOriginSha256),
    {
      timeoutMs: 30_000,
      intervalMs: 100,
      label: `${client.surface} observed dev network origins`,
    },
  );
  assert(
    Number.isSafeInteger(result.identityRevision) &&
      result.identityRevision >= 0,
    "Rendered identity revision is invalid.",
  );
  return Object.freeze({
    ...result,
    identityClass: expectedIdentityClass,
    networkOriginsSha256: observedNetwork.networkOriginsSha256,
  });
};

/**
 * Verifies an anonymous authority already persisted by an isolated Electron
 * profile. Credential material is obtained and hashed inside the renderer;
 * neither the session cookie nor the Convex JWT crosses CDP.
 */
export const verifyExistingAnonymousElectronProfile = async (
  client,
  {
    convexUrl,
    convexSiteUrl,
    expectedIdentitySha256 = null,
    expectedSessionIdSha256 = null,
    expectedOwnerAccountSha256 = null,
  },
) =>
  await verifyExistingRenderedAuthorityProfile(client, {
    surface: "electron-cdp",
    convexUrl,
    convexSiteUrl,
    expression: existingAnonymousElectronExpression({
      convexUrl,
      convexSiteUrl,
    }),
    evaluationLabel: "verify existing anonymous Electron profile",
    resultLabel: "Existing anonymous Electron profile",
    networkLabel: "existing anonymous Electron observed dev network origins",
    anonymous: true,
    identityClass: "anonymous-secondary",
    expectedIdentitySha256,
    expectedSessionIdSha256,
    expectedOwnerAccountSha256,
  });

/**
 * Verifies the primary non-anonymous authority already persisted by an
 * isolated browser profile. The token and session remain inside the rendered
 * product; only fixed SHA-256 observations cross CDP.
 */
export const verifyExistingPrimaryBrowserProfile = async (
  client,
  {
    convexUrl,
    convexSiteUrl,
    expectedIdentitySha256 = null,
    expectedSessionIdSha256 = null,
    expectedOwnerAccountSha256 = null,
  },
) =>
  await verifyExistingRenderedAuthorityProfile(client, {
    surface: "browser-cdp",
    convexUrl,
    convexSiteUrl,
    expression: existingPrimaryBrowserExpression({
      convexUrl,
      convexSiteUrl,
    }),
    evaluationLabel: "verify existing primary browser profile",
    resultLabel: "Existing primary browser profile",
    networkLabel: "existing primary browser observed dev network origins",
    anonymous: false,
    identityClass: "non-anonymous",
    expectedIdentitySha256,
    expectedSessionIdSha256,
    expectedOwnerAccountSha256,
  });

/**
 * Electron counterpart to verifyExistingPrimaryBrowserProfile. This is used
 * after a clean isolated Electron profile completes its own product login;
 * safeStorage/session material never leaves that process.
 */
export const verifyExistingPrimaryElectronProfile = async (
  client,
  {
    convexUrl,
    convexSiteUrl,
    expectedIdentitySha256 = null,
    expectedSessionIdSha256 = null,
    expectedOwnerAccountSha256 = null,
  },
) =>
  await verifyExistingRenderedAuthorityProfile(client, {
    surface: "electron-cdp",
    convexUrl,
    convexSiteUrl,
    expression: existingPrimaryElectronExpression({
      convexUrl,
      convexSiteUrl,
    }),
    evaluationLabel: "verify existing primary Electron profile",
    resultLabel: "Existing primary Electron profile",
    networkLabel: "existing primary Electron observed dev network origins",
    anonymous: false,
    identityClass: "non-anonymous",
    expectedIdentitySha256,
    expectedSessionIdSha256,
    expectedOwnerAccountSha256,
  });

export const refreshRenderedClientIdentity = async (client) => {
  const result = await client.evaluate(
    `(async () => {
      try {
        const { refreshAuthSession, getAuthSessionSnapshot } = await import("/src/global/auth/services/auth-session.ts");
        await refreshAuthSession();
        const snapshot = getAuthSessionSnapshot();
        const user = snapshot.data?.user;
        if (!user?.id || snapshot.isPending) throw new Error("refresh failed");
        const hash = ${pageShaHelper};
        return {
          authenticated: true,
          identitySha256: await hash(user.id),
          identityRevision: snapshot.identityRevision,
          anonymous: user.isAnonymous === true
        };
      } catch {
        throw new Error("rendered identity refresh failed");
      }
    })()`,
    `refresh ${client.surface} identity`,
    60_000,
  );
  requireSha256(result?.identitySha256, "Refreshed identity hash");
  return Object.freeze(result);
};

const renderedSnapshotExpression = `
  (async () => {
    const hash = ${pageShaHelper};
    const visible = ${pagePaintedHelper};
    const interactive = ${pageInteractiveHelper};
    const surface = document.querySelector('[data-testid="chat-surface"]');
    const scroller = surface?.querySelector('.session-content') ?? null;
    const composer = surface?.querySelector('form[data-testid="chat-composer"]') ?? null;
    const topbar = document.querySelector('[data-testid="conversation-topbar"]');
    const rows = surface ? [...surface.querySelectorAll('[data-chat-row-id]')] : [];
    const mountedRowObservations = await Promise.all(rows.map(async (row) => {
      const kind = row.classList.contains('event-row--user') ? 'user' : row.classList.contains('event-row--assistant') ? 'assistant' : 'other';
      const container = row.closest('[data-index]');
      const rawListIndex = container?.getAttribute('data-index') ?? '';
      const parsedListIndex = Number(rawListIndex);
      const listIndex = rawListIndex !== '' && Number.isSafeInteger(parsedListIndex) && parsedListIndex >= 0 && String(parsedListIndex) === rawListIndex ? parsedListIndex : null;
      const containerRect = container?.getBoundingClientRect();
      const scrollerRect = scroller?.getBoundingClientRect();
      const layoutTop = containerRect && scrollerRect
        ? containerRect.top - scrollerRect.top + scroller.scrollTop
        : null;
      const messageBody = kind === 'user'
        ? row.querySelector('.event-item.user .event-body')
        : kind === 'assistant'
          ? row.querySelector('.assistant-message-text') ?? row.querySelector('.event-item.assistant')
          : row;
      const semanticAttributes = ['role', 'aria-label', 'alt', 'title', 'type', 'href', 'src', 'poster', 'data-state', 'data-status', 'data-testid'];
      const semanticElements = [row, ...row.querySelectorAll('*')].map((element) => ({
        tag: element.tagName.toLowerCase(),
        attributes: semanticAttributes
          .filter((name) => element.hasAttribute(name))
          .map((name) => [name, element.getAttribute(name)])
      }));
      return {
        idSha256: await hash(row.getAttribute('data-chat-row-id') ?? ''),
        textSha256: await hash(messageBody?.textContent ?? ''),
        contentSha256: await hash(JSON.stringify({ text: row.textContent ?? '', elements: semanticElements })),
        kind,
        listIndex,
        layoutTop,
        streaming: row.classList.contains('event-row--streaming'),
        visible: visible(row)
      };
    }));
    mountedRowObservations.sort((left, right) => (left.listIndex ?? Number.MAX_SAFE_INTEGER) - (right.listIndex ?? Number.MAX_SAFE_INTEGER));
    const geometryOrdered = mountedRowObservations.every((row, index) =>
      Number.isSafeInteger(row.listIndex) && row.listIndex >= 0 && Number.isFinite(row.layoutTop) &&
      (index === 0 || (
        mountedRowObservations[index - 1].listIndex < row.listIndex &&
        mountedRowObservations[index - 1].layoutTop <= row.layoutTop
      ))
    );
    const rowObservations = mountedRowObservations.map(({ layoutTop, ...row }) => row);
    const notices = surface ? [...surface.querySelectorAll('.cloud-chat-status-tail [role="status"], .cloud-chat-status-tail [role="alert"]')] : [];
    const noticeObservations = await Promise.all(notices.map(async (notice) => ({
      role: notice.getAttribute('role'),
      textSha256: await hash(notice.textContent ?? ''),
      visible: visible(notice)
    })));
    const rowIds = rowObservations.map((row) => row.idSha256);
    const conversationId = surface?.getAttribute('data-conversation-id') ?? '';
    const activeConversationId = topbar?.getAttribute('data-active-conversation-id') ?? '';
    return {
      surface: window.electronAPI ? 'electron-cdp' : 'browser-cdp',
      locationSha256: await hash(location.href),
      conversationIdSha256: conversationId ? await hash(conversationId) : null,
      activeConversationIdSha256: activeConversationId ? await hash(activeConversationId) : null,
      chatSurfacePresent: Boolean(surface),
      chatSurfaceVisible: visible(surface),
      composerPresent: Boolean(composer),
      composerVisible: visible(composer),
      composerEnabled: Boolean(composer?.querySelector('textarea:not([disabled]):not([readonly])')),
      composerInteractive: interactive(composer?.querySelector('textarea:not([disabled]):not([readonly])')),
      composerBusy: composer?.getAttribute('aria-busy') === 'true',
      composerMountSha256: composer?.dataset.renderedAcceptanceMount ? await hash(composer.dataset.renderedAcceptanceMount) : null,
      rowCount: rowObservations.length,
      uniqueRowCount: new Set(rowIds).size,
      duplicateRowCount: rowIds.length - new Set(rowIds).size,
      geometryOrdered,
      userRowCount: rowObservations.filter((row) => row.kind === 'user').length,
      assistantRowCount: rowObservations.filter((row) => row.kind === 'assistant').length,
      streamingRowCount: rowObservations.filter((row) => row.streaming).length,
      visibleRowCount: rowObservations.filter((row) => row.visible).length,
      workingIndicatorCount: surface?.querySelectorAll('.event-list-working-indicator').length ?? 0,
      activeWorkingIndicatorCount: surface ? [...surface.querySelectorAll('.inline-working-indicator:not(.inline-working-indicator--vacated):not(.inline-working-indicator--leaving)')].filter(visible).length : 0,
      rowsSha256: await hash(JSON.stringify(rowObservations)),
      rows: rowObservations,
      rowIdHashes: rowObservations.map((row) => row.idSha256),
      userRows: rowObservations.filter((row) => row.kind === 'user'),
      assistantRows: rowObservations.filter((row) => row.kind === 'assistant'),
      userTextHashes: rowObservations.filter((row) => row.kind === 'user').map((row) => row.textSha256),
      assistantTextHashes: rowObservations.filter((row) => row.kind === 'assistant').map((row) => row.textSha256),
      noticeCount: noticeObservations.length,
      visibleAlertCount: noticeObservations.filter((notice) => notice.role === 'alert' && notice.visible).length,
      visibleStatusCount: noticeObservations.filter((notice) => notice.role === 'status' && notice.visible).length,
      noticesSha256: await hash(JSON.stringify(noticeObservations))
    };
  })()
`;

export const snapshotRenderedConversation = async (client) => {
  const snapshot = await client.evaluate(
    renderedSnapshotExpression,
    `snapshot ${client.surface} conversation`,
  );
  assert(snapshot?.surface === client.surface, "Rendered surface changed.");
  requireSha256(snapshot.locationSha256, "Rendered location hash");
  requireSha256(snapshot.rowsSha256, "Rendered rows hash");
  requireSha256(snapshot.noticesSha256, "Rendered notices hash");
  assert(
    Number.isSafeInteger(snapshot.rowCount) &&
      Number.isSafeInteger(snapshot.uniqueRowCount) &&
      Number.isSafeInteger(snapshot.workingIndicatorCount) &&
      Number.isSafeInteger(snapshot.activeWorkingIndicatorCount) &&
      snapshot.workingIndicatorCount >= 0 &&
      snapshot.activeWorkingIndicatorCount >= 0 &&
      snapshot.rowCount >= snapshot.uniqueRowCount &&
      snapshot.duplicateRowCount ===
        snapshot.rowCount - snapshot.uniqueRowCount &&
      snapshot.geometryOrdered === true,
    "Rendered row counts are invalid.",
  );
  assert(
    Array.isArray(snapshot.rows) && snapshot.rows.length === snapshot.rowCount,
    "Rendered rows are not in a complete DOM-order observation.",
  );
  const orderedRows = [...snapshot.rows].sort(
    (left, right) => left.listIndex - right.listIndex,
  );
  const normalized = {
    ...snapshot,
    rowsSha256: sha256(canonicalJson(orderedRows)),
    rows: orderedRows,
    rowIdHashes: orderedRows.map((row) => row.idSha256),
    userRows: orderedRows.filter((row) => row.kind === "user"),
    assistantRows: orderedRows.filter((row) => row.kind === "assistant"),
    userTextHashes: orderedRows
      .filter((row) => row.kind === "user")
      .map((row) => row.textSha256),
    assistantTextHashes: orderedRows
      .filter((row) => row.kind === "assistant")
      .map((row) => row.textSha256),
  };
  for (const digest of [
    ...(normalized.rowIdHashes ?? []),
    ...(normalized.userTextHashes ?? []),
    ...(normalized.assistantTextHashes ?? []),
  ]) {
    requireSha256(digest, "Rendered text hash");
  }
  for (const row of normalized.rows) {
    requireSha256(row.idSha256, "Rendered row id hash");
    requireSha256(row.textSha256, "Rendered row text hash");
    requireSha256(row.contentSha256, "Rendered row semantic content hash");
    assert(
      Number.isSafeInteger(row.listIndex) &&
        row.listIndex >= 0 &&
        typeof row.streaming === "boolean" &&
        typeof row.visible === "boolean",
      "Rendered row flags are invalid.",
    );
  }
  assert(
    normalized.rows.every(
      (row, index) =>
        index === 0 || normalized.rows[index - 1].listIndex < row.listIndex,
    ),
    "Rendered rows are not in strict product list order.",
  );
  return Object.freeze(normalized);
};

const renderedTimelineMetricsExpression = `(() => {
  const surface = document.querySelector('[data-testid="chat-surface"]');
  const scroller = surface?.querySelector('.session-content');
  if (!(scroller instanceof HTMLElement)) return null;
  const rect = scroller.getBoundingClientRect();
  return {
    conversationId: surface.getAttribute('data-conversation-id') ?? '',
    hasOlder: surface.getAttribute('data-has-older-messages') === 'true',
    loadingOlder: surface.getAttribute('data-loading-older-messages') === 'true',
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    renderedRowCount: Number(scroller.getAttribute('data-rendered-row-count')),
    x: rect.left + rect.width / 2,
    y: rect.top + Math.min(rect.height / 2, Math.max(1, rect.height - 1)),
    width: rect.width,
    height: rect.height
  };
})()`;

const renderedTimelineMetrics = async (client) => {
  const metrics = await client.evaluate(
    renderedTimelineMetricsExpression,
    `observe ${client.surface} rendered timeline geometry`,
  );
  assert(
    typeof metrics?.conversationId === "string" &&
      typeof metrics.hasOlder === "boolean" &&
      typeof metrics.loadingOlder === "boolean" &&
      [
        metrics.scrollTop,
        metrics.scrollHeight,
        metrics.clientHeight,
        metrics.renderedRowCount,
        metrics.x,
        metrics.y,
        metrics.width,
        metrics.height,
      ].every(Number.isFinite) &&
      metrics.scrollTop >= 0 &&
      metrics.scrollHeight >= metrics.clientHeight &&
      metrics.clientHeight > 0 &&
      Number.isSafeInteger(metrics.renderedRowCount) &&
      metrics.renderedRowCount >= 0 &&
      metrics.width > 0 &&
      metrics.height > 0,
    "Rendered timeline geometry is invalid.",
  );
  return metrics;
};

const wheelRenderedTimeline = async (client, direction) => {
  assert(
    direction === "older" || direction === "newer",
    "Invalid rendered scroll direction.",
  );
  const before = await renderedTimelineMetrics(client);
  const deltaY =
    (direction === "older" ? -1 : 1) *
    Math.max(240, Math.floor(before.clientHeight * 0.72));
  await client.command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: before.x,
    y: before.y,
  });
  await client.command("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: before.x,
    y: before.y,
    deltaX: 0,
    deltaY,
  });
  await new Promise((resolve) => setTimeout(resolve, 35));
  return before;
};

/**
 * Sweeps the actual virtualized LegendList with trusted CDP wheel input. The
 * proof first drains every older page, then walks oldest-to-newest while
 * collecting each row as it is really mounted by React. Raw ids/text never
 * leave the renderer; only SHA-256 observations are merged here.
 */
export const snapshotFullRenderedConversation = async (
  client,
  { timeoutMs = UI_SETTLE_TIMEOUT_MS, maxScrollSteps = 4_096 } = {},
) => {
  assert(
    Number.isSafeInteger(maxScrollSteps) &&
      maxScrollSteps >= 1 &&
      maxScrollSteps <= 20_000,
    "Rendered projection scroll bound is invalid.",
  );
  const initial = await snapshotRenderedConversation(client);
  assert(
    initial.chatSurfaceVisible === true &&
      initial.conversationIdSha256 !== null &&
      initial.streamingRowCount === 0 &&
      initial.activeWorkingIndicatorCount === 0 &&
      initial.composerBusy === false,
    "Full rendered projection requires a visible terminal conversation.",
  );
  const expectedConversation = initial.conversationIdSha256;
  const rows = new Map();
  const rowIdsByListIndex = new Map();
  let mountedSnapshotCount = 0;
  let scrollStepCount = 0;

  const collect = async () => {
    const snapshot = await snapshotRenderedConversation(client);
    assert(
      snapshot.conversationIdSha256 === expectedConversation &&
        snapshot.activeConversationIdSha256 === expectedConversation &&
        snapshot.duplicateRowCount === 0 &&
        snapshot.streamingRowCount === 0,
      "Rendered projection changed conversation or became non-terminal during its sweep.",
    );
    for (const row of snapshot.rows) {
      const observation = Object.freeze({
        idSha256: row.idSha256,
        textSha256: row.textSha256,
        contentSha256: row.contentSha256,
        kind: row.kind,
        listIndex: row.listIndex,
        streaming: row.streaming,
      });
      const prior = rows.get(row.idSha256);
      assert(
        !prior || canonicalJson(prior) === canonicalJson(observation),
        "A rendered row changed while the terminal projection was swept.",
      );
      rows.set(row.idSha256, observation);
      const priorId = rowIdsByListIndex.get(row.listIndex);
      assert(
        !priorId || priorId === row.idSha256,
        "A rendered list index changed row identity during the terminal sweep.",
      );
      rowIdsByListIndex.set(row.listIndex, row.idSha256);
    }
    mountedSnapshotCount += 1;
    return snapshot;
  };

  await collect();
  const deadline = Date.now() + timeoutMs;
  // Start at the newest tail and drive upward. Reaching scrollTop=0 while
  // hasOlder=true intentionally sends another trusted wheel gesture so the
  // product's user-intent pagination fence is exercised rather than bypassed.
  while (true) {
    assert(
      Date.now() <= deadline,
      "Rendered projection older-page sweep timed out.",
    );
    assert(
      scrollStepCount < maxScrollSteps,
      "Rendered projection exceeded its scroll bound.",
    );
    const metrics = await renderedTimelineMetrics(client);
    assert(
      sha256(metrics.conversationId) === expectedConversation,
      "Rendered projection timeline changed conversations.",
    );
    await collect();
    if (!metrics.hasOlder && !metrics.loadingOlder && metrics.scrollTop <= 1)
      break;
    if (metrics.loadingOlder) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    } else {
      await wheelRenderedTimeline(client, "older");
      scrollStepCount += 1;
    }
  }

  // Walk the now-complete list from the absolute oldest row to the tail.
  // Discard observations gathered while travelling backward: insertion order
  // from this point on is the actual oldest-to-newest rendered DOM order.
  const completeMetrics = await renderedTimelineMetrics(client);
  const expectedRenderedRowCount = completeMetrics.renderedRowCount;
  rows.clear();
  rowIdsByListIndex.clear();
  mountedSnapshotCount = 0;
  while (true) {
    assert(
      Date.now() <= deadline,
      "Rendered projection forward sweep timed out.",
    );
    assert(
      scrollStepCount < maxScrollSteps,
      "Rendered projection exceeded its scroll bound.",
    );
    const metrics = await renderedTimelineMetrics(client);
    assert(
      metrics.renderedRowCount === expectedRenderedRowCount,
      "Rendered projection row count changed during its forward sweep.",
    );
    await collect();
    const remaining =
      metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop;
    if (remaining <= 1) break;
    await wheelRenderedTimeline(client, "newer");
    scrollStepCount += 1;
  }
  const finalSnapshot = await collect();
  const canonicalRows = [...rows.values()].sort(
    (left, right) => left.listIndex - right.listIndex,
  );
  const rowIdHashes = canonicalRows.map((row) => row.idSha256);
  assert(
    new Set(rowIdHashes).size === rowIdHashes.length &&
      canonicalRows.length === expectedRenderedRowCount &&
      canonicalRows.every((row, index) => row.listIndex === index),
    "Full rendered projection is incomplete or contains duplicate row ids.",
  );
  const projection = {
    conversationIdSha256: expectedConversation,
    rowCount: canonicalRows.length,
    productRowCount: expectedRenderedRowCount,
    userRowCount: canonicalRows.filter((row) => row.kind === "user").length,
    assistantRowCount: canonicalRows.filter((row) => row.kind === "assistant")
      .length,
    rowIdHashes,
    userTextHashes: canonicalRows
      .filter((row) => row.kind === "user")
      .map((row) => row.textSha256),
    assistantTextHashes: canonicalRows
      .filter((row) => row.kind === "assistant")
      .map((row) => row.textSha256),
    rowsSha256: sha256(canonicalJson(canonicalRows)),
    mountedSnapshotCount,
    scrollStepCount,
    completeHistory: true,
    atNewestTail: true,
    finalMountedRowsSha256: finalSnapshot.rowsSha256,
  };
  requireSha256(projection.rowsSha256, "Full rendered projection hash");
  return Object.freeze(projection);
};

export const markRenderedClientMount = async (client) => {
  const nonce = randomUUID();
  const result = await client.evaluate(
    `(() => {
      const composer = document.querySelector('form[data-testid="chat-composer"]');
      if (!composer) throw new Error("composer unavailable");
      composer.dataset.renderedAcceptanceMount = ${JSON.stringify(nonce)};
      return true;
    })()`,
    `mark ${client.surface} mount`,
  );
  assert(result === true, "Rendered mount marker was not applied.");
  return sha256(nonce);
};

/**
 * Observes only outbox key structure through the rendered origin's Storage
 * implementation. Values (which contain prompt text and attachments) are
 * never read. This is a browser-surface observation, not an import of the
 * product outbox singleton.
 */
export const snapshotRenderedOutbox = async (client) => {
  const observation = await client.evaluate(
    `(async () => {
      const hash = ${pageShaHelper};
      const prefix = 'stella:cloud-conversation-outbox:v1:';
      const keys = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key?.startsWith(prefix)) continue;
        const parts = key.slice(prefix.length).split('/');
        keys.push({
          keySha256: await hash(key),
          accountScopeSha256: await hash(decodeURIComponent(parts[0] ?? '')),
          ownerGenerationSha256: await hash(decodeURIComponent(parts[1] ?? '')),
          conversationKeySha256: await hash(decodeURIComponent(parts[2] ?? '')),
          clientMsgIdSha256: await hash(decodeURIComponent(parts[3] ?? ''))
        });
      }
      keys.sort((left, right) => left.keySha256.localeCompare(right.keySha256));
      return {
        count: keys.length,
        keyHashes: keys.map((entry) => entry.keySha256),
        accountScopeHashes: [...new Set(keys.map((entry) => entry.accountScopeSha256))].sort(),
        ownerGenerationHashes: [...new Set(keys.map((entry) => entry.ownerGenerationSha256))].sort(),
        keysSha256: await hash(JSON.stringify(keys))
      };
    })()`,
    `snapshot ${client.surface} rendered outbox`,
  );
  assert(
    Number.isSafeInteger(observation?.count) && observation.count >= 0,
    "Rendered outbox count is invalid.",
  );
  for (const digest of [
    observation.keysSha256,
    ...(observation.keyHashes ?? []),
    ...(observation.accountScopeHashes ?? []),
    ...(observation.ownerGenerationHashes ?? []),
  ]) {
    requireSha256(digest, "Rendered outbox hash");
  }
  return Object.freeze(observation);
};

const DISPATCH_BARRIER_HOOK =
  "__STELLA_RENDERED_ACCEPTANCE_BEFORE_BROWSER_DISPATCH__";
const DISPATCH_BARRIER_CONTROL =
  "__STELLA_RENDERED_ACCEPTANCE_DISPATCH_CONTROL__";
const DISPATCH_OUTCOME_HOOK =
  "__STELLA_RENDERED_ACCEPTANCE_AFTER_BROWSER_DISPATCH__";
const AUTHORITY_OBSERVATION_HOOK = "__STELLA_RENDERED_ACCEPTANCE_AUTHORITY__";
const AUTHORITY_OBSERVATION_CONTROL =
  "__STELLA_RENDERED_ACCEPTANCE_AUTHORITY_CONTROL__";

const installRenderedDispatchBarrier = async (client) => {
  assert(
    client.surface === "browser-cdp",
    "The rendered dispatch barrier exists only in the browser shell.",
  );
  const installed = await client.evaluate(
    `(() => {
      if (window.electronAPI) throw new Error("wrong surface");
      if (window[${JSON.stringify(DISPATCH_BARRIER_HOOK)}] || window[${JSON.stringify(DISPATCH_BARRIER_CONTROL)}]) {
        throw new Error("dispatch barrier already installed");
      }
      let release;
      const continuation = new Promise((resolve) => { release = resolve; });
      const control = { ready: false, released: false, calls: 0, metadata: null, release, outcomes: [], authorities: [] };
      window[${JSON.stringify(DISPATCH_BARRIER_CONTROL)}] = control;
      window[${JSON.stringify(DISPATCH_BARRIER_HOOK)}] = async (metadata) => {
        const keys = ['authoritySha256', 'clientMsgIdSha256', 'conversationIdSha256', 'outboxKeySha256'];
        if (control.ready || !metadata || keys.some((key) => !/^[a-f0-9]{64}$/u.test(metadata[key]))) {
          throw new Error("invalid dispatch barrier metadata");
        }
        if (Object.keys(metadata).sort().join(',') !== keys.sort().join(',')) {
          throw new Error("unexpected dispatch barrier metadata");
        }
        control.calls += 1;
        control.metadata = Object.fromEntries(keys.map((key) => [key, metadata[key]]));
        control.ready = true;
        await continuation;
        control.released = true;
      };
      window[${JSON.stringify(DISPATCH_OUTCOME_HOOK)}] = (metadata) => {
        if (!metadata || !/^[a-f0-9]{64}$/u.test(metadata.clientMsgIdSha256) || !/^[a-f0-9]{64}$/u.test(metadata.errorCodeSha256)) return;
        if (!['accepted', 'owner_generation_rejected', 'other_rejected'].includes(metadata.outcome)) return;
        control.outcomes.push({
          clientMsgIdSha256: metadata.clientMsgIdSha256,
          outcome: metadata.outcome,
          errorCodeSha256: metadata.errorCodeSha256
        });
      };
      window[${JSON.stringify(AUTHORITY_OBSERVATION_HOOK)}] = (metadata) => {
        if (!metadata || !/^[a-f0-9]{64}$/u.test(metadata.authoritySha256) || !/^[a-f0-9]{64}$/u.test(metadata.ownerGenerationSha256)) return;
        control.authorities.push({
          authoritySha256: metadata.authoritySha256,
          ownerGenerationSha256: metadata.ownerGenerationSha256
        });
      };
      return true;
    })()`,
    "install rendered browser dispatch barrier",
  );
  assert(installed === true, "Rendered dispatch barrier was not installed.");
};

const observeRenderedDispatchBarrier = async (client) => {
  const observation = await client.evaluate(
    `(() => {
      const control = window[${JSON.stringify(DISPATCH_BARRIER_CONTROL)}];
      if (!control) return null;
      return {
        ready: control.ready === true,
        released: control.released === true,
        calls: control.calls,
        outcomes: [...control.outcomes],
        authorities: [...control.authorities],
        ...(control.metadata ?? {})
      };
    })()`,
    "observe rendered browser dispatch barrier",
  );
  if (!observation) return null;
  assert(
    Number.isSafeInteger(observation.calls) && observation.calls >= 0,
    "Rendered dispatch barrier call count is invalid.",
  );
  if (observation.ready) {
    for (const key of [
      "authoritySha256",
      "clientMsgIdSha256",
      "conversationIdSha256",
      "outboxKeySha256",
    ]) {
      requireSha256(observation[key], `Rendered dispatch barrier ${key}`);
    }
  }
  for (const outcome of observation.outcomes ?? []) {
    requireSha256(
      outcome.clientMsgIdSha256,
      "Rendered dispatch outcome client hash",
    );
    requireSha256(
      outcome.errorCodeSha256,
      "Rendered dispatch outcome code hash",
    );
    assert(
      ["accepted", "owner_generation_rejected", "other_rejected"].includes(
        outcome.outcome,
      ),
      "Rendered dispatch outcome is invalid.",
    );
  }
  for (const authority of observation.authorities ?? []) {
    requireSha256(authority.authoritySha256, "Rendered authority hash");
    requireSha256(
      authority.ownerGenerationSha256,
      "Rendered owner generation hash",
    );
  }
  return Object.freeze(observation);
};

const releaseRenderedDispatchBarrier = async (client) => {
  const observation = await observeRenderedDispatchBarrier(client);
  assert(
    observation?.ready === true &&
      observation.released === false &&
      observation.calls === 1,
    "Rendered dispatch barrier is not ready for one-shot release.",
  );
  const released = await client.evaluate(
    `(() => {
      const control = window[${JSON.stringify(DISPATCH_BARRIER_CONTROL)}];
      if (!control?.ready || control.released) throw new Error("dispatch barrier unavailable");
      delete window[${JSON.stringify(DISPATCH_BARRIER_HOOK)}];
      control.release();
      return true;
    })()`,
    "release rendered browser dispatch barrier",
  );
  assert(released === true, "Rendered dispatch barrier was not released.");
  return observation;
};

const cleanupRenderedDispatchBarrier = async (client) => {
  await client
    .evaluate(
      `(() => {
        const control = window[${JSON.stringify(DISPATCH_BARRIER_CONTROL)}];
        if (control && !control.released) control.release();
        delete window[${JSON.stringify(DISPATCH_BARRIER_HOOK)}];
        delete window[${JSON.stringify(DISPATCH_OUTCOME_HOOK)}];
        delete window[${JSON.stringify(AUTHORITY_OBSERVATION_HOOK)}];
        delete window[${JSON.stringify(DISPATCH_BARRIER_CONTROL)}];
        return true;
      })()`,
      "cleanup rendered browser dispatch barrier",
    )
    .catch(() => undefined);
};

const installRenderedAuthorityObserver = async (client) => {
  const installed = await client.evaluate(
    `(() => {
      if (window[${JSON.stringify(AUTHORITY_OBSERVATION_HOOK)}] || window[${JSON.stringify(AUTHORITY_OBSERVATION_CONTROL)}]) {
        throw new Error("authority observer already installed");
      }
      const control = { authorities: [] };
      window[${JSON.stringify(AUTHORITY_OBSERVATION_CONTROL)}] = control;
      window[${JSON.stringify(AUTHORITY_OBSERVATION_HOOK)}] = (metadata) => {
        if (!metadata || !/^[a-f0-9]{64}$/u.test(metadata.authoritySha256) || !/^[a-f0-9]{64}$/u.test(metadata.ownerGenerationSha256)) return;
        control.authorities.push({
          authoritySha256: metadata.authoritySha256,
          ownerGenerationSha256: metadata.ownerGenerationSha256
        });
      };
      return true;
    })()`,
    `install ${client.surface} rendered authority observer`,
  );
  assert(installed === true, "Rendered authority observer was not installed.");
};

const observeRenderedAuthorities = async (client) => {
  const authorities = await client.evaluate(
    `(() => [...(window[${JSON.stringify(AUTHORITY_OBSERVATION_CONTROL)}]?.authorities ?? [])])()`,
    `observe ${client.surface} rendered authorities`,
  );
  assert(
    Array.isArray(authorities),
    "Rendered authority observations are invalid.",
  );
  for (const authority of authorities) {
    requireSha256(authority.authoritySha256, "Rendered authority hash");
    requireSha256(
      authority.ownerGenerationSha256,
      "Rendered authority generation hash",
    );
  }
  return Object.freeze(authorities);
};

const cleanupRenderedAuthorityObserver = async (client) => {
  await client
    .evaluate(
      `(() => {
        delete window[${JSON.stringify(AUTHORITY_OBSERVATION_HOOK)}];
        delete window[${JSON.stringify(AUTHORITY_OBSERVATION_CONTROL)}];
        return true;
      })()`,
      `cleanup ${client.surface} rendered authority observer`,
    )
    .catch(() => undefined);
};

export const waitForRenderedConversation = async (
  client,
  { conversationId, timeoutMs = UI_SETTLE_TIMEOUT_MS },
) => {
  const expected = sha256(conversationId);
  return await poll(
    () => snapshotRenderedConversation(client),
    (snapshot) =>
      snapshot.chatSurfacePresent === true &&
      snapshot.chatSurfaceVisible === true &&
      snapshot.composerPresent === true &&
      snapshot.composerVisible === true &&
      snapshot.composerEnabled === true &&
      snapshot.composerInteractive === true &&
      snapshot.conversationIdSha256 === expected &&
      snapshot.activeConversationIdSha256 === expected,
    {
      timeoutMs,
      intervalMs: 100,
      label: `${client.surface} rendered conversation`,
    },
  );
};

const clickRenderedElement = async (client, elementExpression, label) => {
  const point = await client.evaluate(
    `(() => {
      const visible = ${pageInteractiveHelper};
      const element = (${elementExpression});
      if (!visible(element)) throw new Error("target is not visibly interactive");
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`,
    label,
  );
  assert(
    Number.isFinite(point?.x) &&
      Number.isFinite(point?.y) &&
      point.x >= 0 &&
      point.y >= 0,
    "Rendered input target has no valid viewport point.",
  );
  await client.command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
  await client.command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await client.command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
};

const PRODUCT_MAGIC_LINK_REQUEST_CONTRACT =
  "stella-rendered-product-magic-link-request-v1";
const STRICT_PRODUCT_AUTH_ORIGIN = "http://127.0.0.1:57314";
const PRODUCT_ONBOARDING_CONTRACT =
  "stella-rendered-product-onboarding-persistence-v1";
const PRODUCT_ONBOARDING_KEYS = Object.freeze(
  [
    "appShellRendered",
    "crashSurfaceAbsent",
    "credentialMaterialReturned",
    "driverVisibleOnboardingAttestationSha256",
    "onboardingContract",
    "onboardingPersisted",
    "onboardingStateSha256",
    "onboardingSurfaceAbsent",
    "productOriginSha256",
    "profileSha256",
    "surface",
    "targetIdSha256",
  ].sort(),
);

const validateProductOnboardingReceipt = (receipt) => {
  assert(
    isRecord(receipt) &&
      Object.keys(receipt).sort().join(",") ===
        [...PRODUCT_ONBOARDING_KEYS, "onboardingReceiptSha256"]
          .sort()
          .join(","),
    "Rendered product onboarding receipt has an unsafe shape.",
  );
  const { onboardingReceiptSha256, ...body } = receipt;
  requireSha256(onboardingReceiptSha256, "Rendered product onboarding receipt");
  assert(
    onboardingReceiptSha256 === sha256(canonicalJson(body)) &&
      body.onboardingContract === PRODUCT_ONBOARDING_CONTRACT &&
      RENDERED_CLIENT_SURFACES.includes(body.surface) &&
      body.onboardingPersisted === true &&
      body.appShellRendered === true &&
      body.onboardingSurfaceAbsent === true &&
      body.crashSurfaceAbsent === true &&
      body.credentialMaterialReturned === false,
    "Rendered product onboarding receipt is not strict persistence proof.",
  );
  for (const [label, digest] of Object.entries({
    driver: body.driverVisibleOnboardingAttestationSha256,
    origin: body.productOriginSha256,
    profile: body.profileSha256,
    state: body.onboardingStateSha256,
    target: body.targetIdSha256,
  })) {
    requireSha256(digest, `Rendered product onboarding ${label}`);
  }
  return Object.freeze(body);
};

/**
 * Binds the driver's trusted-click, visible-phase onboarding transcript to the
 * product's persisted completion bit and post-onboarding app shell. The driver
 * owns phase-sequence validation; this helper never writes the completion bit.
 */
export const verifyRenderedProductOnboardingPersistence = async (
  client,
  {
    productOrigin,
    profileSha256,
    driverVisibleOnboardingAttestationSha256,
    timeoutMs = UI_SETTLE_TIMEOUT_MS,
  },
) => {
  assert(
    RENDERED_CLIENT_SURFACES.includes(client.surface) &&
      productOrigin === STRICT_PRODUCT_AUTH_ORIGIN,
    "Rendered product onboarding must use the reviewed surface and exact trusted origin.",
  );
  requireSha256(profileSha256, "Rendered product onboarding profile");
  requireSha256(
    driverVisibleOnboardingAttestationSha256,
    "Rendered visible onboarding driver attestation",
  );
  const targetIdSha256 = requireSha256(
    client.targetIdSha256,
    "Rendered product onboarding target",
  );
  const state = await poll(
    () =>
      client.evaluate(
        `(async () => {
          const hash = ${pageShaHelper};
          const painted = ${pagePaintedHelper};
          const { uiState } = await import("/src/platform/ui-state/index.ts");
          const { readLocalOnboardingCompleted } = await import("/src/global/onboarding/use-onboarding-state.ts");
          const shell = document.querySelector('.window-shell.full[data-window-mode="app"]');
          const onboarding = document.querySelector('.onboarding-dialogue, .onboarding-start-button');
          const crash = document.querySelector('.error-boundary');
          return {
            exactOrigin: location.origin === ${JSON.stringify(productOrigin)},
            productOriginSha256: await hash(location.origin),
            onboardingPersisted: readLocalOnboardingCompleted() === true && uiState.getItem("stella-onboarding-complete") === "true",
            appShellRendered: painted(shell),
            onboardingSurfaceAbsent: !onboarding,
            crashSurfaceAbsent: !crash
          };
        })()`,
        `verify ${client.surface} product onboarding persistence`,
      ),
    (value) =>
      value?.exactOrigin === true &&
      value.productOriginSha256 === sha256(productOrigin) &&
      value.onboardingPersisted === true &&
      value.appShellRendered === true &&
      value.onboardingSurfaceAbsent === true &&
      value.crashSurfaceAbsent === true,
    {
      timeoutMs,
      intervalMs: 100,
      label: `${client.surface} product onboarding persistence`,
    },
  );
  const body = Object.freeze({
    onboardingContract: PRODUCT_ONBOARDING_CONTRACT,
    surface: client.surface,
    targetIdSha256,
    profileSha256,
    productOriginSha256: sha256(productOrigin),
    driverVisibleOnboardingAttestationSha256,
    onboardingStateSha256: sha256(canonicalJson(state)),
    onboardingPersisted: true,
    appShellRendered: true,
    onboardingSurfaceAbsent: true,
    crashSurfaceAbsent: true,
    credentialMaterialReturned: false,
  });
  assert(
    Object.keys(body).sort().join(",") === PRODUCT_ONBOARDING_KEYS.join(","),
    "Rendered product onboarding body drifted.",
  );
  return Object.freeze({
    ...body,
    onboardingReceiptSha256: sha256(canonicalJson(body)),
  });
};

const PRODUCT_MAGIC_LINK_REQUEST_KEYS = Object.freeze(
  [
    "authDialogReady",
    "crashSurfaceAbsent",
    "credentialMaterialReturned",
    "dialogStateSha256",
    "driverZeroConversationAttestationSha256",
    "driverVisibleOnboardingAttestationSha256",
    "emailSha256",
    "externalCompletionRequired",
    "networkDeltaSha256",
    "onboardingPersistenceVerified",
    "onboardingReceiptSha256",
    "preChatStateSha256",
    "preChatSurfaceAbsent",
    "productOriginSha256",
    "productDomDriven",
    "profileSha256",
    "requestContract",
    "settingsAuthRouteVerified",
    "surface",
    "targetIdSha256",
  ].sort(),
);

const validateProductMagicLinkRequest = (receipt) => {
  assert(
    isRecord(receipt) &&
      Object.keys(receipt).sort().join(",") ===
        [...PRODUCT_MAGIC_LINK_REQUEST_KEYS, "requestReceiptSha256"]
          .sort()
          .join(","),
    "Rendered product magic-link request has an unsafe shape.",
  );
  const { requestReceiptSha256, ...body } = receipt;
  requireSha256(requestReceiptSha256, "Rendered magic-link request receipt");
  assert(
    requestReceiptSha256 === sha256(canonicalJson(body)),
    "Rendered magic-link request receipt hash is invalid.",
  );
  assert(
    body.requestContract === PRODUCT_MAGIC_LINK_REQUEST_CONTRACT &&
      RENDERED_CLIENT_SURFACES.includes(body.surface) &&
      body.credentialMaterialReturned === false &&
      body.externalCompletionRequired === true &&
      body.productDomDriven === true &&
      body.onboardingPersistenceVerified === true &&
      body.settingsAuthRouteVerified === true &&
      body.authDialogReady === true &&
      body.preChatSurfaceAbsent === true &&
      body.crashSurfaceAbsent === true,
    "Rendered magic-link request is not a strict product handoff.",
  );
  for (const [label, digest] of Object.entries({
    dialog: body.dialogStateSha256,
    driverAttestation: body.driverZeroConversationAttestationSha256,
    driverOnboarding: body.driverVisibleOnboardingAttestationSha256,
    email: body.emailSha256,
    network: body.networkDeltaSha256,
    onboarding: body.onboardingReceiptSha256,
    origin: body.productOriginSha256,
    preChat: body.preChatStateSha256,
    profile: body.profileSha256,
    target: body.targetIdSha256,
  })) {
    requireSha256(digest, `Rendered magic-link request ${label}`);
  }
  return Object.freeze(body);
};

/**
 * Drives the real sign-in dialog and magic-link form with trusted CDP input.
 * The caller must open the delivered link outside this profile; no request id,
 * email, session cookie, or token is returned by the helper.
 */
export const beginRenderedProductMagicLinkLogin = async (
  client,
  {
    email,
    productOnboardingReceipt,
    driverZeroConversationAttestationSha256,
    timeoutMs = UI_SETTLE_TIMEOUT_MS,
  },
) => {
  assert(
    RENDERED_CLIENT_SURFACES.includes(client.surface),
    "Rendered product magic-link login requires a reviewed CDP surface.",
  );
  assert(
    client.authSetupUseCount === 0,
    "Rendered product magic-link login must precede every cookie setup seam.",
  );
  const onboarding = validateProductOnboardingReceipt(productOnboardingReceipt);
  assert(
    onboarding.surface === client.surface &&
      onboarding.targetIdSha256 === client.targetIdSha256,
    "Rendered product login changed target after onboarding.",
  );
  const productOrigin = STRICT_PRODUCT_AUTH_ORIGIN;
  const profileSha256 = onboarding.profileSha256;
  requireSha256(
    driverZeroConversationAttestationSha256,
    "Rendered pre-chat driver attestation",
  );
  const normalizedEmail = String(email ?? "")
    .trim()
    .toLowerCase();
  assert(
    normalizedEmail === email &&
      normalizedEmail.length <= 320 &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalizedEmail),
    "Rendered product magic-link email must be normalized and valid.",
  );
  const targetIdSha256 = requireSha256(
    client.targetIdSha256,
    "Rendered magic-link target id",
  );
  const preChat = await poll(
    () =>
      client.evaluate(
        `(async () => {
          const hash = ${pageShaHelper};
          const interactive = ${pageInteractiveHelper};
          const { router } = await import("/src/router.tsx");
          const { readLocalOnboardingCompleted } = await import("/src/global/onboarding/use-onboarding-state.ts");
          const locationState = router.state.location;
          const search = locationState.search ?? {};
          const emailInput = document.querySelector('.auth-dialog-content .auth-dialog-form input[type="email"]');
          const submit = document.querySelector('.auth-dialog-content .auth-dialog-cta');
          const crashSurface = document.querySelector('.error-boundary');
          return {
            exactOrigin: location.origin === ${JSON.stringify(productOrigin)},
            productOriginSha256: await hash(location.origin),
            onboardingPersisted: readLocalOnboardingCompleted() === true,
            settingsAuthRoute: locationState.pathname === "/settings" && search.dialog === "auth",
            routeSha256: await hash(locationState.pathname + "?dialog=" + String(search.dialog ?? "")),
            authDialogReady: interactive(emailInput) && interactive(submit),
            preChatSurfaceAbsent: !document.querySelector('[data-testid="chat-surface"]'),
            crashSurfaceAbsent: !crashSurface
          };
        })()`,
        `observe ${client.surface} pre-chat product login readiness`,
      ),
    (state) =>
      state?.exactOrigin === true &&
      state.productOriginSha256 === sha256(productOrigin) &&
      state.onboardingPersisted === true &&
      state.settingsAuthRoute === true &&
      state.authDialogReady === true &&
      state.preChatSurfaceAbsent === true &&
      state.crashSurfaceAbsent === true &&
      /^[a-f0-9]{64}$/u.test(state.routeSha256 ?? ""),
    {
      timeoutMs,
      intervalMs: 100,
      label: `${client.surface} pre-chat product login readiness`,
    },
  );
  const preLogin = await client.evaluate(
    `(async () => {
      const { refreshAuthSession, getAuthSessionSnapshot } = await import("/src/global/auth/services/auth-session.ts");
      await refreshAuthSession();
      const snapshot = getAuthSessionSnapshot();
      const user = snapshot.data?.user;
      return {
        pending: snapshot.isPending === true,
        signedIn: Boolean(user?.id),
        anonymous: user?.isAnonymous === true
      };
    })()`,
    `observe ${client.surface} pre-login authority`,
    60_000,
  );
  assert(
    preLogin?.pending === false &&
      (!preLogin.signedIn || preLogin.anonymous === true),
    "Rendered product magic-link login requires a signed-out or anonymous profile.",
  );
  const beforeTelemetry = client.telemetry();
  const dialogOpen = await client.evaluate(
    `Boolean(document.querySelector('.auth-dialog-content .auth-dialog-form input[type="email"]'))`,
    `observe ${client.surface} auth dialog`,
  );
  assert(
    dialogOpen === true,
    "Rendered product login left the pinned settings AuthDialog route.",
  );
  await poll(
    () =>
      client.evaluate(
        `(() => {
          const interactive = ${pageInteractiveHelper};
          return interactive(document.querySelector('.auth-dialog-content .auth-dialog-form input[type="email"]')) &&
            interactive(document.querySelector('.auth-dialog-content .auth-dialog-cta'));
        })()`,
        `observe ${client.surface} product magic-link form`,
      ),
    (ready) => ready === true,
    {
      timeoutMs,
      intervalMs: 100,
      label: `${client.surface} product magic-link form`,
    },
  );
  const inputExpression = `document.querySelector('.auth-dialog-content .auth-dialog-form input[type="email"]')`;
  await clickRenderedElement(
    client,
    inputExpression,
    `focus ${client.surface} product magic-link email`,
  );
  const selectionModifier = process.platform === "darwin" ? 4 : 2;
  await client.command("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: selectionModifier,
  });
  await client.command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: selectionModifier,
  });
  await client.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
  await client.command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
  await client.command("Input.insertText", { text: normalizedEmail });
  const typed = await client.evaluate(
    `(async () => {
      const hash = ${pageShaHelper};
      const input = document.querySelector('.auth-dialog-content .auth-dialog-form input[type="email"]');
      return input instanceof HTMLInputElement ? await hash(input.value.trim().toLowerCase()) : null;
    })()`,
    `verify ${client.surface} product magic-link email`,
  );
  assert(
    typed === sha256(normalizedEmail),
    "Rendered product magic-link email did not enter the real form.",
  );
  await clickRenderedElement(
    client,
    `document.querySelector('.auth-dialog-content .auth-dialog-cta')`,
    `submit ${client.surface} product magic-link form`,
  );
  const sent = await poll(
    () =>
      client.evaluate(
        `(async () => {
          const hash = ${pageShaHelper};
          const painted = ${pagePaintedHelper};
          const dialog = document.querySelector('.auth-dialog-content');
          const input = dialog?.querySelector('.auth-dialog-form input[type="email"]');
          const extras = dialog?.querySelector('.auth-dialog-extras');
          const error = dialog?.querySelector('.auth-dialog-error');
          return {
            dialogVisible: painted(dialog),
            emailSha256: input instanceof HTMLInputElement ? await hash(input.value.trim().toLowerCase()) : null,
            sentOpen: extras?.getAttribute('data-open') === 'true' && extras?.getAttribute('aria-hidden') === 'false',
            sentVisible: painted(extras),
            errorVisible: painted(error),
            errorSha256: error ? await hash(error.textContent ?? '') : null
          };
        })()`,
        `observe ${client.surface} product magic-link request`,
      ),
    (state) =>
      state?.dialogVisible === true &&
      state.emailSha256 === sha256(normalizedEmail) &&
      state.sentOpen === true &&
      state.sentVisible === true &&
      state.errorVisible === false,
    {
      timeoutMs,
      intervalMs: 100,
      label: `${client.surface} product magic-link request`,
    },
  );
  const afterTelemetry = client.telemetry();
  assert(
    afterTelemetry.requestCount > beforeTelemetry.requestCount &&
      afterTelemetry.responseCount > beforeTelemetry.responseCount &&
      client.authSetupUseCount === 0,
    "Rendered product magic-link form did not produce an observed product request.",
  );
  const body = Object.freeze({
    requestContract: PRODUCT_MAGIC_LINK_REQUEST_CONTRACT,
    surface: client.surface,
    targetIdSha256,
    profileSha256,
    productOriginSha256: sha256(productOrigin),
    driverZeroConversationAttestationSha256,
    driverVisibleOnboardingAttestationSha256:
      onboarding.driverVisibleOnboardingAttestationSha256,
    onboardingReceiptSha256: productOnboardingReceipt.onboardingReceiptSha256,
    preChatStateSha256: sha256(canonicalJson(preChat)),
    emailSha256: sha256(normalizedEmail),
    dialogStateSha256: sha256(canonicalJson(sent)),
    networkDeltaSha256: sha256(
      canonicalJson({
        beforeRequestCount: beforeTelemetry.requestCount,
        afterRequestCount: afterTelemetry.requestCount,
        beforeRequestsSha256: beforeTelemetry.requestsSha256,
        afterRequestsSha256: afterTelemetry.requestsSha256,
        beforeResponseCount: beforeTelemetry.responseCount,
        afterResponseCount: afterTelemetry.responseCount,
        beforeResponsesSha256: beforeTelemetry.responsesSha256,
        afterResponsesSha256: afterTelemetry.responsesSha256,
      }),
    ),
    productDomDriven: true,
    externalCompletionRequired: true,
    onboardingPersistenceVerified: true,
    settingsAuthRouteVerified: true,
    authDialogReady: true,
    preChatSurfaceAbsent: true,
    crashSurfaceAbsent: true,
    credentialMaterialReturned: false,
  });
  assert(
    Object.keys(body).sort().join(",") ===
      PRODUCT_MAGIC_LINK_REQUEST_KEYS.join(","),
    "Rendered product magic-link request body drifted.",
  );
  return Object.freeze({
    ...body,
    requestReceiptSha256: sha256(canonicalJson(body)),
  });
};

const PRODUCT_MAGIC_LINK_COMPLETION_CONTRACT =
  "stella-rendered-product-magic-link-completion-v1";
const PRODUCT_MAGIC_LINK_COMPLETION_KEYS = Object.freeze(
  [
    "authorityReceiptSha256",
    "completionContract",
    "credentialMaterialReturned",
    "driverZeroConversationAttestationSha256",
    "driverVisibleOnboardingAttestationSha256",
    "emailSha256",
    "identitySha256",
    "jwtIssuerSha256",
    "jwtSha256",
    "outcome",
    "ownerAccountSha256",
    "onboardingReceiptSha256",
    "preChatStateSha256",
    "productOriginSha256",
    "productPollAppliedSession",
    "profileSha256",
    "requestReceiptSha256",
    "sessionIdSha256",
    "sessionJwtBindingSha256",
    "surface",
    "targetIdSha256",
  ].sort(),
);

const validateProductMagicLinkCompletion = (receipt) => {
  assert(
    isRecord(receipt) &&
      Object.keys(receipt).sort().join(",") ===
        [...PRODUCT_MAGIC_LINK_COMPLETION_KEYS, "completionReceiptSha256"]
          .sort()
          .join(","),
    "Rendered product magic-link completion has an unsafe shape.",
  );
  const { completionReceiptSha256, ...body } = receipt;
  requireSha256(
    completionReceiptSha256,
    "Rendered magic-link completion receipt",
  );
  assert(
    completionReceiptSha256 === sha256(canonicalJson(body)),
    "Rendered magic-link completion receipt hash is invalid.",
  );
  assert(
    body.completionContract === PRODUCT_MAGIC_LINK_COMPLETION_CONTRACT &&
      body.outcome === "product-magic-link-completed" &&
      RENDERED_CLIENT_SURFACES.includes(body.surface) &&
      body.productPollAppliedSession === true &&
      body.credentialMaterialReturned === false,
    "Rendered product magic-link completion is not a strict product handoff.",
  );
  for (const [label, digest] of Object.entries({
    authority: body.authorityReceiptSha256,
    driverAttestation: body.driverZeroConversationAttestationSha256,
    driverOnboarding: body.driverVisibleOnboardingAttestationSha256,
    email: body.emailSha256,
    identity: body.identitySha256,
    issuer: body.jwtIssuerSha256,
    jwt: body.jwtSha256,
    origin: body.productOriginSha256,
    owner: body.ownerAccountSha256,
    onboarding: body.onboardingReceiptSha256,
    preChat: body.preChatStateSha256,
    profile: body.profileSha256,
    request: body.requestReceiptSha256,
    session: body.sessionIdSha256,
    sessionBinding: body.sessionJwtBindingSha256,
    target: body.targetIdSha256,
  })) {
    requireSha256(digest, `Rendered magic-link completion ${label}`);
  }
  return Object.freeze(body);
};

/**
 * Waits for the product's own magic-link poller to consume the externally
 * opened link, then verifies the resulting authority wholly inside the same
 * rendered profile.
 */
export const completeRenderedProductMagicLinkLogin = async (
  client,
  { requestReceipt, convexUrl, convexSiteUrl, timeoutMs = 5 * 60_000 },
) => {
  const request = validateProductMagicLinkRequest(requestReceipt);
  assert(
    request.surface === client.surface &&
      request.targetIdSha256 === client.targetIdSha256 &&
      client.authSetupUseCount === 0,
    "Rendered product magic-link completion changed target or used a cookie setup seam.",
  );
  const completed = await poll(
    () =>
      client.evaluate(
        `(async () => {
          const hash = ${pageShaHelper};
          const { refreshAuthSession, getAuthSessionSnapshot } = await import("/src/global/auth/services/auth-session.ts");
          await refreshAuthSession();
          const snapshot = getAuthSessionSnapshot();
          const user = snapshot.data?.user;
          return {
            pending: snapshot.isPending === true,
            authenticated: Boolean(user?.id),
            anonymous: user?.isAnonymous === true,
            identitySha256: user?.id ? await hash(user.id) : null,
            authDialogOpen: Boolean(document.querySelector('.auth-dialog-content'))
          };
        })()`,
        `observe ${client.surface} product magic-link completion`,
        60_000,
      ),
    (state) =>
      state?.pending === false &&
      state.authenticated === true &&
      state.anonymous === false &&
      /^[a-f0-9]{64}$/u.test(state.identitySha256 ?? "") &&
      state.authDialogOpen === false,
    {
      timeoutMs,
      intervalMs: 500,
      label: `${client.surface} product magic-link completion`,
    },
  );
  const verify =
    client.surface === "browser-cdp"
      ? verifyExistingPrimaryBrowserProfile
      : verifyExistingPrimaryElectronProfile;
  const authority = await verify(client, { convexUrl, convexSiteUrl });
  assert(
    authority.identitySha256 === completed.identitySha256 &&
      client.authSetupUseCount === 0,
    "Rendered product magic-link completion did not bind the verified authority.",
  );
  const body = Object.freeze({
    completionContract: PRODUCT_MAGIC_LINK_COMPLETION_CONTRACT,
    outcome: "product-magic-link-completed",
    surface: client.surface,
    targetIdSha256: client.targetIdSha256,
    profileSha256: request.profileSha256,
    productOriginSha256: request.productOriginSha256,
    driverZeroConversationAttestationSha256:
      request.driverZeroConversationAttestationSha256,
    driverVisibleOnboardingAttestationSha256:
      request.driverVisibleOnboardingAttestationSha256,
    onboardingReceiptSha256: request.onboardingReceiptSha256,
    preChatStateSha256: request.preChatStateSha256,
    requestReceiptSha256: requestReceipt.requestReceiptSha256,
    emailSha256: request.emailSha256,
    identitySha256: authority.identitySha256,
    sessionIdSha256: authority.sessionIdSha256,
    jwtSha256: authority.jwtSha256,
    jwtIssuerSha256: authority.jwtIssuerSha256,
    ownerAccountSha256: authority.ownerAccountSha256,
    sessionJwtBindingSha256: authority.sessionJwtBindingSha256,
    authorityReceiptSha256: sha256(canonicalJson(authority)),
    productPollAppliedSession: true,
    credentialMaterialReturned: false,
  });
  assert(
    Object.keys(body).sort().join(",") ===
      PRODUCT_MAGIC_LINK_COMPLETION_KEYS.join(","),
    "Rendered product magic-link completion body drifted.",
  );
  return Object.freeze({
    ...body,
    completionReceiptSha256: sha256(canonicalJson(body)),
  });
};

/**
 * Proves that the connected authority from a completed product login later
 * rendered its canonical chat in the same CDP target and driver-owned
 * profile. The driver remains authoritative for the zero-conversation
 * precondition; this helper only carries its hash across the login boundary.
 */
export const verifyRenderedProductLoginSameProfileChat = async (
  client,
  {
    completedLoginReceipt,
    profileSha256,
    conversationId,
    timeoutMs = UI_SETTLE_TIMEOUT_MS,
  },
) => {
  const completed = validateProductMagicLinkCompletion(completedLoginReceipt);
  requireSha256(profileSha256, "Rendered post-login profile");
  assert(
    completed.surface === client.surface &&
      completed.targetIdSha256 === client.targetIdSha256 &&
      completed.profileSha256 === profileSha256 &&
      client.authSetupUseCount === 0,
    "Rendered post-login chat changed target/profile or used a credential setup seam.",
  );
  assert(
    typeof conversationId === "string" && conversationId.length > 0,
    "Rendered post-login conversation id is required.",
  );
  const view = await waitForRenderedConversation(client, {
    conversationId,
    timeoutMs,
  });
  const productState = await client.evaluate(
    `(async () => {
      const hash = ${pageShaHelper};
      const { router } = await import("/src/router.tsx");
      return {
        chatRoute: router.state.location.pathname === "/chat",
        routeSha256: await hash(router.state.location.pathname),
        authDialogAbsent: !document.querySelector('.auth-dialog-content'),
        crashSurfaceAbsent: !document.querySelector('.error-boundary')
      };
    })()`,
    `verify ${client.surface} same-profile product chat surface`,
  );
  assert(
    productState?.chatRoute === true &&
      productState.authDialogAbsent === true &&
      productState.crashSurfaceAbsent === true,
    "Rendered post-login product chat is not a clean /chat surface.",
  );
  requireSha256(productState.routeSha256, "Rendered post-login route");
  const body = Object.freeze({
    outcome: "product-login-same-profile-chat-rendered",
    surface: client.surface,
    targetIdSha256: client.targetIdSha256,
    profileSha256,
    identitySha256: completed.identitySha256,
    ownerAccountSha256: completed.ownerAccountSha256,
    driverZeroConversationAttestationSha256:
      completed.driverZeroConversationAttestationSha256,
    driverVisibleOnboardingAttestationSha256:
      completed.driverVisibleOnboardingAttestationSha256,
    onboardingReceiptSha256: completed.onboardingReceiptSha256,
    completionReceiptSha256: completedLoginReceipt.completionReceiptSha256,
    conversationIdSha256: sha256(conversationId),
    rowsSha256: view.rowsSha256,
    rowCount: view.rowCount,
    routeSha256: productState.routeSha256,
    chatSurfaceRendered: true,
    composerRendered: true,
    crashSurfaceAbsent: true,
    sameTarget: true,
    sameProfile: true,
    credentialMaterialReturned: false,
  });
  return Object.freeze({
    ...body,
    chatReceiptSha256: sha256(canonicalJson(body)),
  });
};

export const listRenderedConversations = async (
  client,
  { timeoutMs = UI_SETTLE_TIMEOUT_MS, maxScrollSteps = 2_048 } = {},
) => {
  assert(
    Number.isSafeInteger(maxScrollSteps) &&
      maxScrollSteps >= 1 &&
      maxScrollSteps <= 10_000,
    "Rendered history scroll bound is invalid.",
  );
  const alreadyOpen = await client.evaluate(
    `Boolean(document.querySelector('.conversation-history-popover'))`,
    `observe ${client.surface} conversation history`,
  );
  if (!alreadyOpen) {
    await clickRenderedElement(
      client,
      `document.querySelector('.conversation-topbar__history')`,
      `open ${client.surface} conversation history`,
    );
  }
  const observedIds = new Set();
  const deadline = Date.now() + timeoutMs;
  let scrollStepCount = 0;
  while (true) {
    assert(
      Date.now() <= deadline,
      "Rendered conversation history sweep timed out.",
    );
    assert(
      scrollStepCount < maxScrollSteps,
      "Rendered history exceeded its scroll bound.",
    );
    const state = await client.evaluate(
      `(async () => {
        const hash = ${pageShaHelper};
        const popover = document.querySelector('.conversation-history-popover');
        const scroller = popover?.querySelector('.conversation-history-popover__list');
        if (!(popover instanceof HTMLElement) || !(scroller instanceof HTMLElement)) return null;
        const rows = [...popover.querySelectorAll('.conversation-history-popover__item[data-conversation-id]')];
        const ids = await Promise.all(rows.map((row) => hash(row.getAttribute('data-conversation-id') ?? '')));
        const rect = scroller.getBoundingClientRect();
        return {
          ids,
          mountedUnique: new Set(ids).size === ids.length,
          hasMore: popover.getAttribute('data-history-has-more') === 'true',
          loading: popover.getAttribute('data-history-loading') === 'true',
          scrollTop: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        };
      })()`,
      `list ${client.surface} conversations`,
    );
    assert(
      Array.isArray(state?.ids) &&
        state.mountedUnique === true &&
        state.ids.every((digest) => /^[a-f0-9]{64}$/u.test(digest)) &&
        [
          state.scrollTop,
          state.scrollHeight,
          state.clientHeight,
          state.x,
          state.y,
        ].every(Number.isFinite) &&
        state.clientHeight > 0,
      "Rendered conversation history state is invalid.",
    );
    state.ids.forEach((digest) => observedIds.add(digest));
    const remaining = state.scrollHeight - state.clientHeight - state.scrollTop;
    if (!state.hasMore && !state.loading && remaining <= 1) break;
    if (state.loading) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    await client.command("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: state.x,
      y: state.y,
      deltaX: 0,
      deltaY: Math.max(120, Math.floor(state.clientHeight * 0.72)),
    });
    scrollStepCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  const ids = [...observedIds].sort();
  assert(ids.length > 0, "Rendered conversation history is empty.");
  return Object.freeze({
    count: ids.length,
    uniqueCount: ids.length,
    idsSha256: sha256(canonicalJson(ids)),
    scrollStepCount,
    completeHistory: true,
  });
};

export const selectRenderedConversation = async (
  client,
  { conversationId, timeoutMs = UI_SETTLE_TIMEOUT_MS },
) => {
  const expected = sha256(conversationId);
  const current = await snapshotRenderedConversation(client);
  if (
    current.conversationIdSha256 === expected &&
    current.activeConversationIdSha256 === expected &&
    current.composerInteractive
  ) {
    return current;
  }
  await listRenderedConversations(client, { timeoutMs });
  const deadline = Date.now() + timeoutMs;
  let direction = "older";
  let steps = 0;
  while (true) {
    assert(
      Date.now() <= deadline,
      "Rendered conversation selection timed out.",
    );
    assert(
      steps < 4_096,
      "Rendered conversation selection exceeded its scroll bound.",
    );
    const target = await client.evaluate(
      `(() => {
        const id = ${JSON.stringify(conversationId)};
        const visible = ${pageInteractiveHelper};
        const scroller = document.querySelector('.conversation-history-popover__list');
        const row = [...document.querySelectorAll('.conversation-history-popover__item[data-conversation-id]')]
          .find((candidate) => candidate.getAttribute('data-conversation-id') === id);
        const button = row?.querySelector('.conversation-history-popover__item-target') ?? null;
        if (!(scroller instanceof HTMLElement)) return null;
        const rect = scroller.getBoundingClientRect();
        return {
          targetVisible: visible(button),
          scrollTop: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2
        };
      })()`,
      `locate ${client.surface} conversation`,
    );
    assert(
      target &&
        [
          target.scrollTop,
          target.scrollHeight,
          target.clientHeight,
          target.x,
          target.y,
        ].every(Number.isFinite),
      "Rendered history selection geometry is invalid.",
    );
    if (target.targetVisible) break;
    const remaining =
      target.scrollHeight - target.clientHeight - target.scrollTop;
    if (direction === "older" && target.scrollTop <= 1) direction = "newer";
    else if (direction === "newer" && remaining <= 1) {
      throw new CloudProofError(
        "Requested conversation is absent from the complete rendered history.",
      );
    }
    await client.command("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: target.x,
      y: target.y,
      deltaX: 0,
      deltaY:
        (direction === "older" ? -1 : 1) *
        Math.max(120, Math.floor(target.clientHeight * 0.72)),
    });
    steps += 1;
    await new Promise((resolve) => setTimeout(resolve, 35));
  }
  await clickRenderedElement(
    client,
    `(() => {
      const id = ${JSON.stringify(conversationId)};
      const row = [...document.querySelectorAll('.conversation-history-popover__item[data-conversation-id]')]
        .find((candidate) => candidate.getAttribute('data-conversation-id') === id);
      return row?.querySelector('.conversation-history-popover__item-target') ?? null;
    })()`,
    `select ${client.surface} conversation`,
  );
  return await waitForRenderedConversation(client, {
    conversationId,
    timeoutMs,
  });
};

export const sendRenderedPrompt = async (
  client,
  { prompt, timeoutMs = UI_SETTLE_TIMEOUT_MS },
) => {
  assert(
    typeof prompt === "string" && prompt.trim().length > 0,
    "Rendered prompt must be non-empty.",
  );
  const baseline = await snapshotRenderedConversation(client);
  const expectedPromptSha256 = sha256(prompt.trim());
  const textareaExpression = `document.querySelector('form[data-testid="chat-composer"] textarea:not([disabled]):not([readonly])')`;
  await clickRenderedElement(
    client,
    textareaExpression,
    `focus ${client.surface} rendered composer`,
  );
  const selectionModifier = process.platform === "darwin" ? 4 : 2;
  await client.command("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: selectionModifier,
  });
  await client.command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    nativeVirtualKeyCode: 65,
    modifiers: selectionModifier,
  });
  await client.command("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
  await client.command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
  await client.command("Input.insertText", { text: prompt });
  await poll(
    () =>
      client.evaluate(
        `(async () => {
          const hash = ${pageShaHelper};
          const visible = ${pageInteractiveHelper};
          const textarea = ${textareaExpression};
          const submit = document.querySelector('form[data-testid="chat-composer"] .composer-submit:not([disabled])');
          return {
            valueSha256: await hash(textarea?.value?.trim() ?? ''),
            submitVisible: visible(submit)
          };
        })()`,
        `observe ${client.surface} rendered input`,
      ),
    (value) =>
      value?.valueSha256 === expectedPromptSha256 &&
      value.submitVisible === true,
    {
      timeoutMs,
      intervalMs: 25,
      label: `${client.surface} rendered input commit`,
    },
  );
  await clickRenderedElement(
    client,
    `document.querySelector('form[data-testid="chat-composer"] .composer-submit:not([disabled])')`,
    `submit ${client.surface} rendered prompt`,
  );
  await poll(
    async () =>
      await client.evaluate(
        `(() => document.querySelector('form[data-testid="chat-composer"] textarea')?.value ?? null)()`,
        `observe ${client.surface} composer clear`,
      ),
    (value) => value === "",
    {
      timeoutMs,
      intervalMs: 50,
      label: `${client.surface} composer clear`,
    },
  );
  const submitted = await poll(
    () => snapshotRenderedConversation(client),
    (snapshot) =>
      snapshot.userRows.some(
        (row) =>
          row.textSha256 === expectedPromptSha256 &&
          row.visible &&
          !baseline.rowIdHashes.includes(row.idSha256),
      ),
    {
      timeoutMs,
      intervalMs: 50,
      label: `${client.surface} newly rendered user row`,
    },
  );
  const userRow = submitted.userRows.find(
    (row) =>
      row.textSha256 === expectedPromptSha256 &&
      row.visible &&
      !baseline.rowIdHashes.includes(row.idSha256),
  );
  assert(userRow, "Rendered prompt produced no new visible user row.");
  return Object.freeze({
    promptSha256: expectedPromptSha256,
    userRowIdSha256: userRow.idSha256,
    baselineRowsSha256: baseline.rowsSha256,
  });
};

export const waitForRenderedStreaming = async (
  client,
  baseline,
  { promptSha256, userRowIdSha256, timeoutMs = UI_SETTLE_TIMEOUT_MS },
) =>
  await poll(
    () => snapshotRenderedConversation(client),
    (snapshot) => {
      const currentUser = snapshot.userRows.some(
        (row) =>
          row.idSha256 === userRowIdSha256 &&
          row.textSha256 === promptSha256 &&
          row.visible,
      );
      const newVisibleStreamingAssistant = snapshot.assistantRows.some(
        (row) =>
          row.streaming &&
          row.visible &&
          !baseline.rowIdHashes.includes(row.idSha256),
      );
      return (
        currentUser &&
        (newVisibleStreamingAssistant ||
          snapshot.activeWorkingIndicatorCount > 0 ||
          snapshot.composerBusy === true)
      );
    },
    {
      timeoutMs,
      intervalMs: 100,
      label: `${client.surface} visible streaming state`,
    },
  );

export const waitForRenderedTerminal = async (
  client,
  baseline,
  { promptSha256, userRowIdSha256, timeoutMs = 10 * 60_000 },
) =>
  await poll(
    () => snapshotRenderedConversation(client),
    (snapshot) =>
      snapshot.streamingRowCount === 0 &&
      snapshot.activeWorkingIndicatorCount === 0 &&
      snapshot.composerBusy === false &&
      snapshot.visibleAlertCount === 0 &&
      snapshot.userRows.some(
        (row) =>
          row.idSha256 === userRowIdSha256 &&
          row.textSha256 === promptSha256 &&
          row.visible,
      ) &&
      snapshot.assistantRows.some(
        (row) =>
          !row.streaming &&
          row.visible &&
          !baseline.rowIdHashes.includes(row.idSha256),
      ) &&
      snapshot.duplicateRowCount === 0,
    {
      timeoutMs,
      intervalMs: 250,
      label: `${client.surface} rendered terminal`,
    },
  );

export const waitForRenderedFailClosed = async (
  client,
  baseline,
  { promptSha256, userRowIdSha256, timeoutMs = UI_SETTLE_TIMEOUT_MS },
) =>
  await poll(
    () => snapshotRenderedConversation(client),
    (snapshot) =>
      snapshot.streamingRowCount === 0 &&
      snapshot.activeWorkingIndicatorCount === 0 &&
      snapshot.composerBusy === false &&
      snapshot.visibleAlertCount > baseline.visibleAlertCount &&
      snapshot.noticesSha256 !== baseline.noticesSha256 &&
      snapshot.userRows.some(
        (row) =>
          row.idSha256 === userRowIdSha256 &&
          row.textSha256 === promptSha256 &&
          row.visible,
      ) &&
      snapshot.assistantRows.every((row) =>
        baseline.rowIdHashes.includes(row.idSha256),
      ) &&
      snapshot.duplicateRowCount === 0,
    {
      timeoutMs,
      intervalMs: 100,
      label: `${client.surface} visible fail-closed state`,
    },
  );

const contiguousUnique = (values, since) => {
  if (!Array.isArray(values) || values.length === 0) return false;
  if (new Set(values).size !== values.length) return false;
  const sorted = [...values].sort((left, right) => left - right);
  if (since !== null && sorted[0] !== since + 1) return false;
  return sorted.every(
    (value, index) => index === 0 || value === sorted[index - 1] + 1,
  );
};

const validReadySocket = (socket, conversationIdSha256) => {
  const ready = socket.readyFrames.at(-1);
  return Boolean(
    ready &&
    ready.protocol === 1 &&
    ready.conversationIdSha256 === conversationIdSha256 &&
    ready.epoch === socket.epoch &&
    socket.resetFrameCount === 0 &&
    socket.gapFrameCount === 0,
  );
};

const completeReplayThroughReady = (socket, conversationIdSha256) => {
  const ready = socket.readyFrames.at(-1);
  if (
    !validReadySocket(socket, conversationIdSha256) ||
    socket.since === null ||
    socket.recordSeqs.length === 0 ||
    !contiguousUnique(socket.recordSeqs, socket.since)
  ) {
    return false;
  }
  return Math.max(...socket.recordSeqs) === ready.headSeq;
};

export const exerciseMountedTransportResume = async (
  client,
  {
    whileOffline,
    timeoutMs = UI_SETTLE_TIMEOUT_MS,
    requireReplayRecords = true,
  },
) => {
  const before = await snapshotRenderedConversation(client);
  assert(before.composerPresent, "Rendered composer is not mounted.");
  const mountSha256 = await markRenderedClientMount(client);
  const telemetryBefore = client.telemetry();
  const socketCountBefore = telemetryBefore.sockets.length;
  const activeBefore = telemetryBefore.sockets.filter(
    (socket) =>
      !socket.closed &&
      socket.conversationIdSha256 === before.conversationIdSha256,
  );
  assert(
    activeBefore.length > 0,
    "Rendered conversation has no observed active socket to resume.",
  );
  const activeRequestHashes = new Set(
    activeBefore.map((socket) => socket.requestIdSha256),
  );
  const priorReadyEpoch = activeBefore
    .flatMap((socket) => socket.readyFrames)
    .at(-1)?.epoch;
  let offlineExpectation;
  await client.setOffline(true);
  try {
    await poll(
      () => Promise.resolve(client.telemetry()),
      (telemetry) =>
        telemetry.sockets
          .filter((socket) => activeRequestHashes.has(socket.requestIdSha256))
          .every((socket) => socket.closed),
      {
        timeoutMs,
        intervalMs: 50,
        label: `${client.surface} transport drop`,
      },
    );
    offlineExpectation = await whileOffline();
  } finally {
    await client.setOffline(false);
  }
  const expectedUserTextHashes = Array.isArray(
    offlineExpectation?.expectedUserTextHashes,
  )
    ? [...offlineExpectation.expectedUserTextHashes]
    : [];
  for (const digest of expectedUserTextHashes) {
    requireSha256(digest, "Offline canonical user text hash");
  }
  if (requireReplayRecords) {
    assert(
      expectedUserTextHashes.length > 0,
      "Replay proof requires at least one offline canonical text expectation.",
    );
  }
  const resumed = await poll(
    () => Promise.resolve(client.telemetry()),
    (telemetry) => {
      const newer = telemetry.sockets.slice(socketCountBefore);
      return newer.some(
        (socket) =>
          socket.conversationIdSha256 === before.conversationIdSha256 &&
          !socket.closed &&
          socket.since !== null &&
          socket.epoch !== null &&
          validReadySocket(socket, before.conversationIdSha256) &&
          (!requireReplayRecords ||
            completeReplayThroughReady(socket, before.conversationIdSha256)),
      );
    },
    {
      timeoutMs,
      intervalMs: 100,
      label: `${client.surface} transport resume`,
    },
  );
  const resumeSocket = resumed.sockets
    .slice(socketCountBefore)
    .find(
      (socket) =>
        socket.conversationIdSha256 === before.conversationIdSha256 &&
        !socket.closed &&
        socket.since !== null &&
        socket.epoch !== null &&
        validReadySocket(socket, before.conversationIdSha256) &&
        (!requireReplayRecords ||
          completeReplayThroughReady(socket, before.conversationIdSha256)),
    );
  assert(
    resumeSocket,
    "Rendered client opened no cursor-bearing resume socket.",
  );
  if (Number.isSafeInteger(priorReadyEpoch)) {
    assert(
      resumeSocket.epoch === priorReadyEpoch &&
        resumeSocket.readyFrames.at(-1)?.epoch === priorReadyEpoch,
      "Rendered resume crossed an unexpected journal epoch.",
    );
  }
  if (requireReplayRecords) {
    assert(
      contiguousUnique(resumeSocket.recordSeqs, resumeSocket.since),
      "Rendered resume replay was duplicated or non-gapless.",
    );
  }
  const after = await poll(
    () => snapshotRenderedConversation(client),
    (snapshot) =>
      snapshot.composerMountSha256 === mountSha256 &&
      snapshot.duplicateRowCount === 0 &&
      expectedUserTextHashes.every((digest) =>
        snapshot.userTextHashes.includes(digest),
      ),
    {
      timeoutMs,
      intervalMs: 100,
      label: `${client.surface} same-mounted-client resume`,
    },
  );
  return Object.freeze({
    outcome: "resumed",
    mountSha256,
    beforeStateSha256: sha256(canonicalJson(before)),
    afterStateSha256: sha256(canonicalJson(after)),
    resumeRequestSha256: resumeSocket.requestUrlSha256,
    conversationIdSha256: resumeSocket.conversationIdSha256,
    since: resumeSocket.since,
    epoch: resumeSocket.epoch,
    replayRecordCount: resumeSocket.recordSeqs.length,
    replaySeqSha256: sha256(canonicalJson(resumeSocket.recordSeqs)),
    expectedUserTextHashesSha256: sha256(canonicalJson(expectedUserTextHashes)),
    readyHeadSeq: resumeSocket.readyFrames.at(-1)?.headSeq ?? null,
    backfillRequestCount: resumeSocket.backfillRequests.length,
    gapless: requireReplayRecords
      ? contiguousUnique(resumeSocket.recordSeqs, resumeSocket.since)
      : true,
    noDuplicateRows: after.duplicateRowCount === 0,
    sameMountedClient: after.composerMountSha256 === mountSha256,
  });
};

export const clearRenderedBrowserStorage = async (client, origin) => {
  assert(
    client.surface === "browser-cdp",
    "Only browser storage is CDP-owned.",
  );
  const parsed = new URL(origin);
  assert(
    parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost"),
    "Rendered browser storage origin must be loopback.",
  );
  const renderedOrigin = await client.evaluate(
    `location.origin`,
    "observe rendered browser storage origin",
  );
  assert(
    renderedOrigin === parsed.origin,
    "Browser storage target is not the attached rendered page origin.",
  );
  await client.command("Storage.clearDataForOrigin", {
    origin: parsed.origin,
    storageTypes: "all",
  });
  const empty = await client.evaluate(
    `(async () => ({
      originMatches: location.origin === ${JSON.stringify(parsed.origin)},
      localStorageCount: localStorage.length,
      sessionStorageCount: sessionStorage.length,
      cookieCount: document.cookie ? document.cookie.split(';').filter(Boolean).length : 0,
      indexedDbCount: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).length : 0,
      cacheCount: 'caches' in window ? (await caches.keys()).length : 0
    }))()`,
    "verify rendered browser storage deletion",
  );
  assert(
    empty?.originMatches === true &&
      empty.localStorageCount === 0 &&
      empty.sessionStorageCount === 0 &&
      empty.cookieCount === 0 &&
      empty.indexedDbCount === 0 &&
      empty.cacheCount === 0,
    "Rendered browser origin storage was not fully deleted.",
  );
  return Object.freeze({
    outcome: "cleared",
    originSha256: sha256(parsed.origin),
    emptyStorageSha256: sha256(canonicalJson(empty)),
  });
};

export const exerciseRenderedTabReload = async (
  client,
  { conversationId, timeoutMs = UI_SETTLE_TIMEOUT_MS },
) => {
  await waitForRenderedConversation(client, {
    conversationId,
    timeoutMs,
  });
  const before = await snapshotFullRenderedConversation(client, { timeoutMs });
  const oldMountSha256 = await markRenderedClientMount(client);
  const targetIdSha256 = requireSha256(
    client.targetIdSha256,
    "Rendered reload target id hash",
  );
  await client.reload();
  const remounted = await poll(
    () => snapshotRenderedConversation(client),
    (snapshot) =>
      snapshot.conversationIdSha256 === sha256(conversationId) &&
      snapshot.activeConversationIdSha256 === sha256(conversationId) &&
      snapshot.composerMountSha256 === null &&
      snapshot.duplicateRowCount === 0,
    {
      timeoutMs,
      intervalMs: 100,
      label: `${client.surface} cold tab reload hydration`,
    },
  );
  const after = await snapshotFullRenderedConversation(client, { timeoutMs });
  assert(
    after.rowsSha256 === before.rowsSha256 &&
      after.rowCount === before.rowCount &&
      client.targetIdSha256 === targetIdSha256,
    "Same-target reload did not hydrate the exact full rendered projection.",
  );
  return Object.freeze({
    outcome: "same-target-page-reloaded",
    oldMountSha256,
    targetIdSha256,
    conversationIdSha256: sha256(conversationId),
    beforeStateSha256: sha256(canonicalJson(before)),
    afterStateSha256: sha256(canonicalJson(after)),
    canonicalRowsSha256: after.rowsSha256,
    renderedRowCount: after.rowCount,
    noDuplicateRows: true,
    newRendererMount: remounted.composerMountSha256 === null,
    sameTarget: client.targetIdSha256 === targetIdSha256,
  });
};

/**
 * Runs in a newly launched browser/Electron process. The caller supplies the
 * prior canonical rows hash; no renderer singleton, socket, or store object is
 * shared with this proof.
 */
export const verifyRenderedColdProcessHydration = async (
  client,
  {
    conversationId,
    expectedProjectionSha256,
    previousProcessIdentity,
    currentProcessIdentity,
    previousStopReceipt,
    previousTargetIdSha256,
    expectedIdentitySha256,
    timeoutMs = UI_SETTLE_TIMEOUT_MS,
  },
) => {
  requireSha256(expectedProjectionSha256, "Expected canonical projection hash");
  requireSha256(previousTargetIdSha256, "Previous rendered target id hash");
  requireSha256(expectedIdentitySha256, "Expected preserved identity hash");
  const previousProcess = assertRenderedProcessIdentity(
    previousProcessIdentity,
    "Previous rendered",
  );
  const currentProcess = assertRenderedProcessIdentity(
    currentProcessIdentity,
    "Current rendered",
  );
  assert(
    previousStopReceipt?.stopped === true &&
      previousStopReceipt.processInstanceSha256 ===
        previousProcess.processInstanceSha256 &&
      previousStopReceipt.profileSha256 === previousProcess.profileSha256,
    "Cold hydration is not chained to a verified prior-process stop.",
  );
  assert(
    previousProcess.processInstanceSha256 !==
      currentProcess.processInstanceSha256,
    "Cold hydration reused the prior process instance.",
  );
  assert(
    previousTargetIdSha256 !== client.targetIdSha256,
    "Cold hydration reused the prior renderer target.",
  );
  assert(
    previousProcess.profileSha256 === currentProcess.profileSha256 &&
      previousProcess.applicationIdentitySha256 ===
        currentProcess.applicationIdentitySha256,
    "Persistence restart must reuse the exact preserved profile and application identity.",
  );
  assert(
    currentProcess.processIdSha256 ===
      client.endpointOwnership?.processIdSha256 &&
      currentProcess.processInstanceSha256 ===
        sha256(
          canonicalJson({
            processIdSha256: client.endpointOwnership.processIdSha256,
            processFingerprintSha256:
              client.endpointOwnership.processFingerprintSha256,
          }),
        ),
    "Cold hydration process identity is not bound to the CDP listener owner.",
  );
  if (client.surface === "browser-cdp") {
    requireSha256(
      previousStopReceipt?.profileContinuityAfterStopSha256,
      "Prior stopped profile continuity hash",
    );
    requireSha256(
      currentProcess.profileContinuityBeforeLaunchSha256,
      "Current launch profile continuity hash",
    );
    assert(
      previousStopReceipt.profileContinuityAfterStopSha256 ===
        currentProcess.profileContinuityBeforeLaunchSha256,
      "Cold browser launch did not preserve the exact stopped profile metadata.",
    );
  }
  assert(
    client.authSetupUseCount === 0,
    "Cold hydration must observe persisted identity before any auth setup seam.",
  );
  const identityBeforeAuth = await refreshRenderedClientIdentity(client);
  assert(
    client.authSetupUseCount === 0 &&
      identityBeforeAuth.authenticated === true &&
      identityBeforeAuth.anonymous === false &&
      identityBeforeAuth.identitySha256 === expectedIdentitySha256,
    "Cold hydration did not preserve the expected signed-in identity before auth setup.",
  );
  await selectRenderedConversation(client, {
    conversationId,
    timeoutMs,
  });
  const view = await snapshotFullRenderedConversation(client, { timeoutMs });
  assert(
    view.rowsSha256 === expectedProjectionSha256,
    "Cold rendered process did not hydrate the exact canonical terminal view.",
  );
  return Object.freeze({
    outcome: "cold-process-hydrated",
    conversationIdSha256: sha256(conversationId),
    canonicalRowsSha256: view.rowsSha256,
    viewSha256: sha256(canonicalJson(view)),
    previousProcessInstanceSha256: previousProcess.processInstanceSha256,
    currentProcessInstanceSha256: currentProcess.processInstanceSha256,
    previousTargetIdSha256,
    currentTargetIdSha256: client.targetIdSha256,
    priorStopReceiptSha256: sha256(canonicalJson(previousStopReceipt)),
    preservedIdentitySha256: identityBeforeAuth.identitySha256,
    identityObservedBeforeAuth: true,
    ...(client.surface === "browser-cdp"
      ? {
          profileContinuitySha256:
            currentProcess.profileContinuityBeforeLaunchSha256,
        }
      : {}),
    profileReused: true,
    newProcess: true,
    newTarget: true,
    noDuplicateRows: true,
  });
};

const BROWSER_STORAGE_RECOVERY_CHECKPOINT_CONTRACT =
  "stella-rendered-browser-storage-recovery-v1";

const BROWSER_STORAGE_RECOVERY_CHECKPOINT_KEYS = Object.freeze(
  [
    "authSetupUseCount",
    "beforeAuthorityReceiptSha256",
    "canonicalRowsSha256",
    "checkpointContract",
    "clearedStateSha256",
    "conversationIdSha256",
    "credentialMaterialReturned",
    "emptyStorageSha256",
    "identitySha256",
    "localRowsAbsentBeforeReauth",
    "networkOriginsSha256",
    "originSha256",
    "outboxEmptyBeforeReauth",
    "ownerAccountSha256",
    "priorAuthoritySignedOutOrAnonymous",
    "sessionIdSha256",
    "targetIdSha256",
  ].sort(),
);

const validateBrowserStorageRecoveryCheckpoint = (checkpoint) => {
  assert(
    isRecord(checkpoint) &&
      Object.keys(checkpoint).sort().join(",") ===
        [...BROWSER_STORAGE_RECOVERY_CHECKPOINT_KEYS, "checkpointSha256"]
          .sort()
          .join(","),
    "Browser storage recovery checkpoint has an unsafe shape.",
  );
  const { checkpointSha256, ...body } = checkpoint;
  requireSha256(checkpointSha256, "Browser storage recovery checkpoint");
  assert(
    checkpointSha256 === sha256(canonicalJson(body)),
    "Browser storage recovery checkpoint hash is invalid.",
  );
  assert(
    body.checkpointContract === BROWSER_STORAGE_RECOVERY_CHECKPOINT_CONTRACT &&
      body.authSetupUseCount === 0 &&
      body.credentialMaterialReturned === false &&
      body.localRowsAbsentBeforeReauth === true &&
      body.outboxEmptyBeforeReauth === true &&
      body.priorAuthoritySignedOutOrAnonymous === true,
    "Browser storage recovery checkpoint did not reach the strict signed-out pause.",
  );
  for (const [label, digest] of Object.entries({
    authority: body.beforeAuthorityReceiptSha256,
    projection: body.canonicalRowsSha256,
    "cleared state": body.clearedStateSha256,
    conversation: body.conversationIdSha256,
    storage: body.emptyStorageSha256,
    identity: body.identitySha256,
    network: body.networkOriginsSha256,
    origin: body.originSha256,
    owner: body.ownerAccountSha256,
    session: body.sessionIdSha256,
    target: body.targetIdSha256,
  })) {
    requireSha256(digest, `Browser storage recovery ${label}`);
  }
  return Object.freeze(body);
};

/**
 * Clears the isolated browser origin and stops at a hash-only signed-out
 * checkpoint. The caller must complete ordinary product magic-link/OAuth in
 * this same rendered profile before calling the completion half.
 */
export const beginRenderedBrowserStorageRecovery = async (
  client,
  {
    origin,
    conversationId,
    expectedProjectionSha256,
    convexUrl,
    convexSiteUrl,
    expectedIdentitySha256 = null,
    expectedSessionIdSha256 = null,
    expectedOwnerAccountSha256 = null,
    timeoutMs = UI_SETTLE_TIMEOUT_MS,
  },
) => {
  assert(
    client.surface === "browser-cdp",
    "Browser storage recovery requires browser-cdp.",
  );
  assert(
    typeof conversationId === "string" && conversationId.length > 0,
    "Browser storage recovery conversation id is required.",
  );
  requireSha256(
    expectedProjectionSha256,
    "Expected browser canonical projection hash",
  );
  const targetIdSha256 = requireSha256(
    client.targetIdSha256,
    "Browser storage recovery target id",
  );
  const beforeAuthority = await verifyExistingPrimaryBrowserProfile(client, {
    convexUrl,
    convexSiteUrl,
    expectedIdentitySha256,
    expectedSessionIdSha256,
    expectedOwnerAccountSha256,
  });
  const before = await snapshotFullRenderedConversation(client, { timeoutMs });
  assert(
    before.conversationIdSha256 === sha256(conversationId) &&
      before.rowsSha256 === expectedProjectionSha256,
    "Browser storage recovery did not begin from the expected canonical view.",
  );
  const oldRowIds = new Set(before.rowIdHashes);
  const cleared = await clearRenderedBrowserStorage(client, origin);
  await client.reload();
  const afterClear = await poll(
    async () => ({
      view: await snapshotRenderedConversation(client),
      auth: await client.evaluate(
        `(async () => {
          const { getAuthSessionSnapshot } = await import("/src/global/auth/services/auth-session.ts");
          const snapshot = getAuthSessionSnapshot();
          const hash = ${pageShaHelper};
          return {
            pending: snapshot.isPending === true,
            signedIn: Boolean(snapshot.data?.user?.id),
            anonymous: snapshot.data?.user?.isAnonymous === true,
            identitySha256: snapshot.data?.user?.id ? await hash(snapshot.data.user.id) : null,
            originSha256: await hash(location.origin),
            readyState: document.readyState
          };
        })()`,
        "observe cleared browser identity",
      ),
      outbox: await snapshotRenderedOutbox(client),
    }),
    ({ view, auth, outbox }) =>
      auth.readyState === "complete" &&
      auth.pending === false &&
      (!auth.signedIn || auth.anonymous === true) &&
      auth.originSha256 === sha256(new URL(origin).origin) &&
      view.composerMountSha256 === null &&
      !view.rowIdHashes.some((digest) => oldRowIds.has(digest)) &&
      outbox.count === 0,
    {
      timeoutMs,
      intervalMs: 100,
      label: "browser cleared-storage render",
    },
  );
  assert(
    client.targetIdSha256 === targetIdSha256 && client.authSetupUseCount === 0,
    "Browser storage recovery crossed a target or cookie setup seam while clearing storage.",
  );
  const body = Object.freeze({
    checkpointContract: BROWSER_STORAGE_RECOVERY_CHECKPOINT_CONTRACT,
    authSetupUseCount: 0,
    beforeAuthorityReceiptSha256: sha256(canonicalJson(beforeAuthority)),
    canonicalRowsSha256: before.rowsSha256,
    clearedStateSha256: sha256(canonicalJson(afterClear)),
    conversationIdSha256: sha256(conversationId),
    credentialMaterialReturned: false,
    emptyStorageSha256: cleared.emptyStorageSha256,
    identitySha256: beforeAuthority.identitySha256,
    localRowsAbsentBeforeReauth: !afterClear.view.rowIdHashes.some((digest) =>
      oldRowIds.has(digest),
    ),
    networkOriginsSha256: beforeAuthority.networkOriginsSha256,
    originSha256: cleared.originSha256,
    outboxEmptyBeforeReauth: afterClear.outbox.count === 0,
    ownerAccountSha256: beforeAuthority.ownerAccountSha256,
    priorAuthoritySignedOutOrAnonymous:
      !afterClear.auth.signedIn || afterClear.auth.anonymous === true,
    sessionIdSha256: beforeAuthority.sessionIdSha256,
    targetIdSha256,
  });
  assert(
    Object.keys(body).sort().join(",") ===
      BROWSER_STORAGE_RECOVERY_CHECKPOINT_KEYS.join(","),
    "Browser storage recovery checkpoint body drifted.",
  );
  return Object.freeze({
    ...body,
    checkpointSha256: sha256(canonicalJson(body)),
  });
};

/**
 * Completes a paused storage-recovery proof after the user has signed in
 * through the ordinary rendered product. A re-login may rotate the session,
 * but it must return to the exact same account/JWT owner.
 */
export const completeRenderedBrowserStorageRecovery = async (
  client,
  {
    checkpoint,
    conversationId,
    convexUrl,
    convexSiteUrl,
    timeoutMs = UI_SETTLE_TIMEOUT_MS,
  },
) => {
  assert(
    client.surface === "browser-cdp",
    "Browser storage recovery completion requires browser-cdp.",
  );
  assert(
    typeof conversationId === "string" && conversationId.length > 0,
    "Browser storage recovery completion conversation id is required.",
  );
  const body = validateBrowserStorageRecoveryCheckpoint(checkpoint);
  assert(
    body.conversationIdSha256 === sha256(conversationId) &&
      body.targetIdSha256 === client.targetIdSha256 &&
      client.authSetupUseCount === body.authSetupUseCount,
    "Browser storage recovery completion is not bound to its paused rendered target.",
  );
  const afterAuthority = await verifyExistingPrimaryBrowserProfile(client, {
    convexUrl,
    convexSiteUrl,
  });
  assert(
    afterAuthority.identitySha256 === body.identitySha256 &&
      afterAuthority.ownerAccountSha256 === body.ownerAccountSha256,
    "Browser product re-login did not restore the original account authority.",
  );
  await selectRenderedConversation(client, {
    conversationId,
    timeoutMs,
  });
  const recovered = await snapshotFullRenderedConversation(client, {
    timeoutMs,
  });
  assert(
    recovered.conversationIdSha256 === body.conversationIdSha256 &&
      recovered.rowsSha256 === body.canonicalRowsSha256,
    "Browser did not recover the exact canonical view after storage deletion.",
  );
  return Object.freeze({
    outcome: "browser-storage-recovered-after-product-login",
    checkpointSha256: checkpoint.checkpointSha256,
    originSha256: body.originSha256,
    emptyStorageSha256: body.emptyStorageSha256,
    clearedStateSha256: body.clearedStateSha256,
    recoveredStateSha256: sha256(canonicalJson(recovered)),
    canonicalRowsSha256: recovered.rowsSha256,
    identitySha256: afterAuthority.identitySha256,
    ownerAccountSha256: afterAuthority.ownerAccountSha256,
    priorSessionIdSha256: body.sessionIdSha256,
    reauthenticatedSessionIdSha256: afterAuthority.sessionIdSha256,
    reauthenticatedAuthorityReceiptSha256: sha256(
      canonicalJson(afterAuthority),
    ),
    localRowsAbsentBeforeReauth: body.localRowsAbsentBeforeReauth,
    priorAuthoritySignedOutOrAnonymous: body.priorAuthoritySignedOutOrAnonymous,
    outboxEmptyBeforeReauth: body.outboxEmptyBeforeReauth,
    accountAuthorityPreserved: true,
    productLoginRequired: true,
    credentialMaterialReturned: false,
    noDuplicateRows: true,
  });
};

/**
 * Convenience wrapper for orchestrators that can perform the ordinary login
 * interaction between the strict pause and completion halves. The callback
 * may drive DOM/product IPC only; using the legacy cookie setup seam is
 * detected and rejected.
 */
export const exerciseRenderedBrowserStorageRecovery = async (
  client,
  { resumeProductLogin, ...options },
) => {
  assert(
    typeof resumeProductLogin === "function",
    "Browser storage recovery requires a product-login callback.",
  );
  const checkpoint = await beginRenderedBrowserStorageRecovery(client, options);
  const loginReceipt = await resumeProductLogin(
    Object.freeze({ client, checkpoint }),
  );
  assert(
    isRecord(loginReceipt) &&
      Object.keys(loginReceipt).sort().join(",") === "completed,method" &&
      loginReceipt.completed === true &&
      loginReceipt.method === "product-ui",
    "Browser storage recovery callback did not attest ordinary product login.",
  );
  assert(
    client.authSetupUseCount === 0,
    "Browser storage recovery callback used the cookie setup seam.",
  );
  return await completeRenderedBrowserStorageRecovery(client, {
    checkpoint,
    conversationId: options.conversationId,
    convexUrl: options.convexUrl,
    convexSiteUrl: options.convexSiteUrl,
    timeoutMs: options.timeoutMs,
  });
};

export const exerciseRenderedIdentityRoundTrip = async (
  client,
  {
    identityA,
    identityB,
    conversationA,
    conversationB,
    accountACanarySha256,
    accountBCanarySha256,
    timeoutMs = UI_SETTLE_TIMEOUT_MS,
  },
) => {
  requireSha256(accountACanarySha256, "Account A rendered canary hash");
  requireSha256(accountBCanarySha256, "Account B rendered canary hash");
  assert(
    accountACanarySha256 !== accountBCanarySha256,
    "Rendered identity canaries must be distinct.",
  );
  const authA = await authenticateRenderedClient(client, identityA);
  await selectRenderedConversation(client, {
    conversationId: conversationA,
    timeoutMs,
  });
  const viewA = await snapshotFullRenderedConversation(client, { timeoutMs });
  assert(
    [...viewA.userTextHashes, ...viewA.assistantTextHashes].includes(
      accountACanarySha256,
    ),
    "Account A canary is not visibly rendered.",
  );
  const telemetryA = client.telemetry();
  const activeA = telemetryA.sockets.filter(
    (socket) =>
      !socket.closed &&
      socket.conversationIdSha256 === viewA.conversationIdSha256,
  );
  assert(activeA.length > 0, "Account A has no active rendered socket.");
  const authB = await authenticateRenderedClient(client, identityB);
  assert(
    authB.identitySha256 !== authA.identitySha256 &&
      authB.identityRevision > authA.identityRevision,
    "A-to-B rendered identity switch did not change owners.",
  );
  await poll(
    () => Promise.resolve(client.telemetry()),
    (telemetry) =>
      activeA.every((prior) =>
        telemetry.sockets.some(
          (socket) =>
            socket.requestIdSha256 === prior.requestIdSha256 && socket.closed,
        ),
      ),
    {
      timeoutMs,
      intervalMs: 50,
      label: `${client.surface} account A socket retirement`,
    },
  );
  await selectRenderedConversation(client, {
    conversationId: conversationB,
    timeoutMs,
  });
  const viewB = await snapshotFullRenderedConversation(client, { timeoutMs });
  assert(
    viewB.conversationIdSha256 !== viewA.conversationIdSha256 &&
      !viewB.rowIdHashes.some((digest) => viewA.rowIdHashes.includes(digest)) &&
      [...viewB.userTextHashes, ...viewB.assistantTextHashes].includes(
        accountBCanarySha256,
      ) &&
      ![...viewB.userTextHashes, ...viewB.assistantTextHashes].includes(
        accountACanarySha256,
      ),
    "B rendered stale A conversation content.",
  );
  const telemetryB = await poll(
    () => Promise.resolve(client.telemetry()),
    (telemetry) =>
      telemetry.sockets
        .slice(telemetryA.sockets.length)
        .some(
          (socket) =>
            !socket.closed &&
            socket.conversationIdSha256 === viewB.conversationIdSha256 &&
            validReadySocket(socket, viewB.conversationIdSha256),
        ),
    {
      timeoutMs,
      intervalMs: 100,
      label: `${client.surface} account B ready socket`,
    },
  );
  const activeB = telemetryB.sockets.filter(
    (socket) =>
      !socket.closed &&
      socket.conversationIdSha256 === viewB.conversationIdSha256,
  );
  const authAReturn = await authenticateRenderedClient(client, identityA);
  assert(
    authAReturn.identitySha256 === authA.identitySha256 &&
      authAReturn.identityRevision > authB.identityRevision,
    "B-to-A rendered identity return did not advance identity fencing.",
  );
  await poll(
    () => Promise.resolve(client.telemetry()),
    (telemetry) =>
      activeB.every((prior) =>
        telemetry.sockets.some(
          (socket) =>
            socket.requestIdSha256 === prior.requestIdSha256 && socket.closed,
        ),
      ),
    {
      timeoutMs,
      intervalMs: 50,
      label: `${client.surface} account B socket retirement`,
    },
  );
  await selectRenderedConversation(client, {
    conversationId: conversationA,
    timeoutMs,
  });
  const viewAReturn = await snapshotFullRenderedConversation(client, {
    timeoutMs,
  });
  assert(
    viewAReturn.conversationIdSha256 === viewA.conversationIdSha256 &&
      viewAReturn.rowsSha256 === viewA.rowsSha256 &&
      [
        ...viewAReturn.userTextHashes,
        ...viewAReturn.assistantTextHashes,
      ].includes(accountACanarySha256) &&
      ![
        ...viewAReturn.userTextHashes,
        ...viewAReturn.assistantTextHashes,
      ].includes(accountBCanarySha256),
    "A rendered conversation did not hydrate cleanly after A-B-A.",
  );
  await poll(
    () => Promise.resolve(client.telemetry()),
    (telemetry) =>
      telemetry.sockets.some(
        (socket) =>
          !socket.closed &&
          socket.conversationIdSha256 === viewAReturn.conversationIdSha256 &&
          validReadySocket(socket, viewAReturn.conversationIdSha256),
      ),
    {
      timeoutMs,
      intervalMs: 100,
      label: `${client.surface} returned account A ready socket`,
    },
  );
  return Object.freeze({
    outcome: "identity-round-trip",
    identityASha256: authA.identitySha256,
    identityBSha256: authB.identitySha256,
    identityBAnonymous: authB.anonymous,
    identityBClass: authB.identityClass,
    identityRevisionA: authA.identityRevision,
    identityRevisionB: authB.identityRevision,
    identityRevisionAReturn: authAReturn.identityRevision,
    accountACanarySha256,
    accountBCanarySha256,
    viewASha256: sha256(canonicalJson(viewA)),
    viewBSha256: sha256(canonicalJson(viewB)),
    viewAReturnSha256: sha256(canonicalJson(viewAReturn)),
    staleContentRejected: true,
  });
};

export const exerciseRenderedBrowserGenerationRotation = async (
  client,
  {
    oldAccountScope,
    oldOwnerGeneration,
    stalePrompt,
    rotateGeneration,
    onOldGenerationReady = async () => undefined,
    timeoutMs = UI_SETTLE_TIMEOUT_MS,
    staleCallbackSettleMs = 750,
  },
) => {
  assert(
    client.surface === "browser-cdp",
    "Durable rendered outbox rotation requires the browser shell.",
  );
  assert(
    typeof oldAccountScope === "string" && oldAccountScope.length > 0,
    "Old account scope is required for the rendered rotation fence.",
  );
  assert(
    typeof oldOwnerGeneration === "string" && oldOwnerGeneration.length > 0,
    "Old owner generation is required for the rendered rotation fence.",
  );
  assert(
    typeof stalePrompt === "string" && stalePrompt.trim().length > 0,
    "A stale rendered prompt is required for the rotation fence.",
  );
  assert(
    Number.isSafeInteger(staleCallbackSettleMs) &&
      staleCallbackSettleMs >= 0 &&
      staleCallbackSettleMs <= 5_000,
    "Stale callback settle time must be from 0 through 5000ms.",
  );
  const before = await snapshotRenderedConversation(client);
  const outboxBefore = await snapshotRenderedOutbox(client);
  const telemetryBefore = client.telemetry();
  const activeBefore = telemetryBefore.sockets.filter(
    (socket) =>
      !socket.closed &&
      socket.conversationIdSha256 === before.conversationIdSha256,
  );
  assert(
    activeBefore.length > 0,
    "Generation rotation has no active rendered socket to fence.",
  );
  const oldGenerationSha256 = sha256(oldOwnerGeneration);
  const oldAuthoritySha256 = sha256(
    JSON.stringify([oldAccountScope, oldOwnerGeneration]),
  );
  const stalePromptSha256 = sha256(stalePrompt.trim());
  const identityBeforeRotation = await refreshRenderedClientIdentity(client);
  assert(
    identityBeforeRotation.authenticated === true &&
      identityBeforeRotation.anonymous === false,
    "Generation rotation requires the original signed-in rendered identity.",
  );
  let rotation;
  let barrierReady;
  await installRenderedDispatchBarrier(client);
  try {
    await sendRenderedPrompt(client, { prompt: stalePrompt, timeoutMs });
    const staleReady = await poll(
      async () => ({
        view: await snapshotRenderedConversation(client),
        outbox: await snapshotRenderedOutbox(client),
        barrier: await observeRenderedDispatchBarrier(client),
      }),
      ({ view, outbox, barrier }) =>
        view.userTextHashes.includes(stalePromptSha256) &&
        outbox.count > outboxBefore.count &&
        outbox.ownerGenerationHashes.includes(oldGenerationSha256) &&
        barrier?.ready === true &&
        barrier.released === false &&
        barrier.calls === 1 &&
        barrier.authoritySha256 === oldAuthoritySha256 &&
        barrier.conversationIdSha256 === before.conversationIdSha256 &&
        outbox.keyHashes.includes(barrier.outboxKeySha256),
      {
        timeoutMs,
        intervalMs: 50,
        label: `${client.surface} old-generation durable outbox barrier`,
      },
    );
    barrierReady = staleReady.barrier;
    await onOldGenerationReady(
      Object.freeze({
        surface: client.surface,
        oldGenerationSha256,
        stalePromptSha256,
        stateSha256: sha256(canonicalJson(staleReady.view)),
        outboxSha256: staleReady.outbox.keysSha256,
        barrierSha256: sha256(canonicalJson(staleReady.barrier)),
      }),
    );
    // The driver-triggered reset runs while the same renderer, conversation
    // socket and frozen mutation callback remain mounted behind the dev-only
    // dispatch barrier.
    rotation = await rotateGeneration();
    assert(
      isRecord(rotation) &&
        typeof rotation.ownerGeneration === "string" &&
        rotation.ownerGeneration.length > 0 &&
        typeof rotation.replacementConversationId === "string" &&
        rotation.replacementConversationId.length > 0,
      "Generation rotation must return its new generation and replacement conversation.",
    );
    assert(
      rotation.ownerGeneration !== oldOwnerGeneration,
      "Generation rotation returned the old owner generation.",
    );

    const socketCountBefore = telemetryBefore.sockets.length;
    const newOwnerGenerationSha256 = sha256(rotation.ownerGeneration);
    const newAuthoritySha256 = sha256(
      JSON.stringify([oldAccountScope, rotation.ownerGeneration]),
    );
    const closedBeforeRelease = await poll(
      async () => ({
        telemetry: client.telemetry(),
        barrier: await observeRenderedDispatchBarrier(client),
      }),
      ({ telemetry, barrier }) =>
        activeBefore.every((prior) =>
          telemetry.sockets.some(
            (socket) =>
              socket.requestIdSha256 === prior.requestIdSha256 && socket.closed,
          ),
        ) &&
        !telemetry.sockets.some(
          (socket) =>
            socket.conversationIdSha256 === before.conversationIdSha256 &&
            !socket.closed &&
            !activeBefore.some(
              (prior) => prior.requestIdSha256 === socket.requestIdSha256,
            ),
        ) &&
        barrier?.authorities?.some(
          (authority) =>
            authority.ownerGenerationSha256 === newOwnerGenerationSha256 &&
            authority.authoritySha256 === newAuthoritySha256,
        ),
      {
        timeoutMs,
        intervalMs: 50,
        label: `${client.surface} old-generation socket retirement`,
      },
    );
    const releasedBarrier = await releaseRenderedDispatchBarrier(client);
    const generationRejection = await poll(
      () => observeRenderedDispatchBarrier(client),
      (barrier) =>
        barrier?.outcomes?.some(
          (outcome) =>
            outcome.clientMsgIdSha256 === barrier.clientMsgIdSha256 &&
            outcome.outcome === "owner_generation_rejected" &&
            outcome.errorCodeSha256 === sha256("OWNER_DATA_GENERATION_STALE"),
        ),
      {
        timeoutMs,
        intervalMs: 50,
        label: "rendered stale-generation server rejection",
      },
    );
    const identity = await refreshRenderedClientIdentity(client);
    assert(
      identity.identitySha256 === identityBeforeRotation.identitySha256 &&
        identity.anonymous === false,
      "Generation rotation changed the rendered account identity.",
    );
    const replacementConversationSha256 = sha256(
      rotation.replacementConversationId,
    );
    const viewAfterRotation = await selectRenderedConversation(client, {
      conversationId: rotation.replacementConversationId,
      timeoutMs,
    });
    const afterTelemetry = await poll(
      () => Promise.resolve(client.telemetry()),
      (telemetry) =>
        telemetry.sockets
          .slice(socketCountBefore)
          .some(
            (socket) =>
              socket.conversationIdSha256 === replacementConversationSha256 &&
              !socket.closed &&
              validReadySocket(socket, replacementConversationSha256),
          ) &&
        !telemetry.sockets.some(
          (socket) =>
            socket.conversationIdSha256 === before.conversationIdSha256 &&
            !socket.closed,
        ),
      {
        timeoutMs,
        intervalMs: 100,
        label: `${client.surface} generation-fenced reconnect`,
      },
    );
    const newSocket = afterTelemetry.sockets
      .slice(socketCountBefore)
      .find(
        (socket) =>
          socket.conversationIdSha256 === replacementConversationSha256 &&
          !socket.closed &&
          validReadySocket(socket, replacementConversationSha256),
      );
    assert(newSocket, "Generation rotation opened no replacement socket.");
    const after = await poll(
      async () => ({
        view: await snapshotRenderedConversation(client),
        outbox: await snapshotRenderedOutbox(client),
      }),
      ({ view, outbox }) =>
        view.conversationIdSha256 === replacementConversationSha256 &&
        view.activeConversationIdSha256 === replacementConversationSha256 &&
        view.duplicateRowCount === 0 &&
        !view.rowIdHashes.some((digest) =>
          before.rowIdHashes.includes(digest),
        ) &&
        !view.userTextHashes.includes(stalePromptSha256) &&
        !outbox.ownerGenerationHashes.includes(oldGenerationSha256),
      {
        timeoutMs,
        intervalMs: 100,
        label: `${client.surface} generation-clean render`,
      },
    );
    if (staleCallbackSettleMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, staleCallbackSettleMs),
      );
    }
    const stableView = await snapshotRenderedConversation(client);
    const stableOutbox = await snapshotRenderedOutbox(client);
    assert(
      stableView.conversationIdSha256 === replacementConversationSha256 &&
        !stableView.userTextHashes.includes(stalePromptSha256) &&
        !stableOutbox.ownerGenerationHashes.includes(oldGenerationSha256),
      "A stale generation callback repopulated the new rendered authority.",
    );
    const localFallbackCount = stableView.rowIdHashes.filter((digest) =>
      before.rowIdHashes.includes(digest),
    ).length;
    return Object.freeze({
      outcome: "browser-generation-rotated",
      identitySha256: identity.identitySha256,
      identityRevision: identity.identityRevision,
      oldAuthoritySha256,
      newAuthoritySha256,
      oldOwnerGenerationSha256: oldGenerationSha256,
      newOwnerGenerationSha256,
      stalePromptSha256,
      barrierSha256: sha256(canonicalJson(barrierReady)),
      releasedBarrierSha256: sha256(canonicalJson(releasedBarrier)),
      generationRejectionSha256: sha256(canonicalJson(generationRejection)),
      beforeStateSha256: sha256(canonicalJson(before)),
      afterStateSha256: sha256(canonicalJson(after.view)),
      priorSocketSha256: activeBefore.at(-1)?.requestUrlSha256 ?? null,
      replacementSocketSha256: newSocket.requestUrlSha256,
      oldSocketClosedBeforeStaleRelease: activeBefore.every((prior) =>
        closedBeforeRelease.telemetry.sockets.some(
          (socket) =>
            socket.requestIdSha256 === prior.requestIdSha256 && socket.closed,
        ),
      ),
      postRotationOldSocketCount: afterTelemetry.sockets.filter(
        (socket) =>
          socket.conversationIdSha256 === before.conversationIdSha256 &&
          !socket.closed,
      ).length,
      replacementConversationSha256,
      replacementViewSha256: sha256(canonicalJson(viewAfterRotation)),
      stableViewSha256: sha256(canonicalJson(stableView)),
      stableOutboxSha256: stableOutbox.keysSha256,
      oldGenerationOutboxPurged:
        !stableOutbox.ownerGenerationHashes.includes(oldGenerationSha256),
      staleCallbackDropped:
        !stableView.userTextHashes.includes(stalePromptSha256),
      oldGenerationAckCouldNotRecreate:
        !stableOutbox.ownerGenerationHashes.includes(oldGenerationSha256),
      staleMutationServerRejected: generationRejection.outcomes.some(
        (outcome) =>
          outcome.clientMsgIdSha256 === generationRejection.clientMsgIdSha256 &&
          outcome.outcome === "owner_generation_rejected" &&
          outcome.errorCodeSha256 === sha256("OWNER_DATA_GENERATION_STALE"),
      ),
      localFallbackCount,
      staleRowsRejected:
        stableView.duplicateRowCount === 0 && localFallbackCount === 0,
    });
  } finally {
    await cleanupRenderedDispatchBarrier(client);
  }
};

export const exerciseRenderedElectronGenerationRotation = async (
  client,
  {
    oldAccountScope,
    oldOwnerGeneration,
    rotateGeneration,
    onOldGenerationReady = async () => undefined,
    timeoutMs = UI_SETTLE_TIMEOUT_MS,
  },
) => {
  assert(
    client.surface === "electron-cdp",
    "Electron generation rotation requires electron-cdp.",
  );
  assert(
    typeof oldAccountScope === "string" && oldAccountScope.length > 0,
    "Old Electron account scope is required.",
  );
  assert(
    typeof oldOwnerGeneration === "string" && oldOwnerGeneration.length > 0,
    "Old Electron owner generation is required.",
  );
  const before = await snapshotRenderedConversation(client);
  const identityBeforeRotation = await refreshRenderedClientIdentity(client);
  assert(
    identityBeforeRotation.authenticated === true &&
      identityBeforeRotation.anonymous === false,
    "Electron generation rotation requires the original signed-in identity.",
  );
  const mountSha256 = await markRenderedClientMount(client);
  const telemetryBefore = client.telemetry();
  const activeBefore = telemetryBefore.sockets.filter(
    (socket) =>
      !socket.closed &&
      socket.conversationIdSha256 === before.conversationIdSha256,
  );
  assert(activeBefore.length > 0, "Electron has no active socket to fence.");
  await installRenderedAuthorityObserver(client);
  try {
    await onOldGenerationReady(
      Object.freeze({
        surface: client.surface,
        oldOwnerGenerationSha256: sha256(oldOwnerGeneration),
        mountSha256,
        stateSha256: sha256(canonicalJson(before)),
      }),
    );
    const rotation = await rotateGeneration();
    assert(
      isRecord(rotation) &&
        typeof rotation.ownerGeneration === "string" &&
        rotation.ownerGeneration !== oldOwnerGeneration &&
        typeof rotation.replacementConversationId === "string" &&
        rotation.replacementConversationId.length > 0,
      "Electron generation rotation did not return a replacement authority.",
    );
    const newOwnerGenerationSha256 = sha256(rotation.ownerGeneration);
    const newAuthoritySha256 = sha256(
      JSON.stringify([oldAccountScope, rotation.ownerGeneration]),
    );
    const closed = await poll(
      async () => ({
        telemetry: client.telemetry(),
        authorities: await observeRenderedAuthorities(client),
      }),
      ({ telemetry, authorities }) =>
        activeBefore.every((prior) =>
          telemetry.sockets.some(
            (socket) =>
              socket.requestIdSha256 === prior.requestIdSha256 && socket.closed,
          ),
        ) &&
        authorities.some(
          (authority) =>
            authority.ownerGenerationSha256 === newOwnerGenerationSha256 &&
            authority.authoritySha256 === newAuthoritySha256,
        ),
      {
        timeoutMs,
        intervalMs: 50,
        label: "electron old-generation socket retirement",
      },
    );
    const replacementConversationSha256 = sha256(
      rotation.replacementConversationId,
    );
    const view = await selectRenderedConversation(client, {
      conversationId: rotation.replacementConversationId,
      timeoutMs,
    });
    const connected = await poll(
      () => Promise.resolve(client.telemetry()),
      (telemetry) =>
        telemetry.sockets
          .slice(telemetryBefore.sockets.length)
          .some(
            (socket) =>
              !socket.closed &&
              socket.conversationIdSha256 === replacementConversationSha256 &&
              validReadySocket(socket, replacementConversationSha256),
          ) &&
        !telemetry.sockets.some(
          (socket) =>
            socket.conversationIdSha256 === before.conversationIdSha256 &&
            !socket.closed,
        ),
      {
        timeoutMs,
        intervalMs: 100,
        label: "electron new-generation socket",
      },
    );
    const after = await poll(
      () => snapshotRenderedConversation(client),
      (snapshot) =>
        snapshot.composerMountSha256 === mountSha256 &&
        snapshot.conversationIdSha256 === replacementConversationSha256 &&
        snapshot.duplicateRowCount === 0 &&
        !snapshot.rowIdHashes.some((digest) =>
          before.rowIdHashes.includes(digest),
        ),
      {
        timeoutMs,
        intervalMs: 100,
        label: "electron generation-clean render",
      },
    );
    const localFallbackCount = after.rowIdHashes.filter((digest) =>
      before.rowIdHashes.includes(digest),
    ).length;
    const identityAfterRotation = await refreshRenderedClientIdentity(client);
    assert(
      identityAfterRotation.identitySha256 ===
        identityBeforeRotation.identitySha256 &&
        identityAfterRotation.anonymous === false,
      "Electron generation rotation changed the rendered account identity.",
    );
    return Object.freeze({
      outcome: "electron-generation-rotated",
      oldOwnerGenerationSha256: sha256(oldOwnerGeneration),
      newOwnerGenerationSha256,
      newAuthoritySha256,
      identitySha256: identityAfterRotation.identitySha256,
      mountSha256,
      sameMountedRenderer: after.composerMountSha256 === mountSha256,
      oldSocketClosed: activeBefore.every((prior) =>
        closed.telemetry.sockets.some(
          (socket) =>
            socket.requestIdSha256 === prior.requestIdSha256 && socket.closed,
        ),
      ),
      replacementConversationSha256,
      replacementViewSha256: sha256(canonicalJson(view)),
      connectedTelemetrySha256: sha256(canonicalJson(connected)),
      authorityObservationsSha256: sha256(canonicalJson(closed.authorities)),
      localFallbackCount,
      staleRowsRejected: localFallbackCount === 0,
      outboxApplicable: false,
    });
  } finally {
    await cleanupRenderedAuthorityObserver(client);
  }
};

export const renderedProcessIdentity = ({
  pid,
  processFingerprintSha256: fingerprint,
  profileSha256,
  binarySha256,
  versionSha256,
  cdpBrowserSha256,
  applicationIdentitySha256,
  profileContinuityBeforeLaunchSha256 = null,
}) => {
  assert(
    Number.isSafeInteger(pid) && pid > 0,
    "Rendered process identity requires a valid pid.",
  );
  const processIdSha256 = sha256(String(pid));
  const processFingerprint = requireSha256(
    fingerprint,
    "Rendered process fingerprint",
  );
  const profileContinuity =
    profileContinuityBeforeLaunchSha256 === null
      ? null
      : requireSha256(
          profileContinuityBeforeLaunchSha256,
          "Rendered profile continuity hash",
        );
  return Object.freeze({
    processIdSha256,
    processInstanceSha256: sha256(
      canonicalJson({
        processIdSha256,
        processFingerprintSha256: processFingerprint,
      }),
    ),
    profileSha256: requireSha256(profileSha256, "Rendered profile hash"),
    applicationIdentitySha256: requireSha256(
      applicationIdentitySha256,
      "Rendered application identity hash",
    ),
    browserBuildSha256: sha256(
      canonicalJson({
        binarySha256: requireSha256(binarySha256, "Rendered binary hash"),
        versionSha256: requireSha256(
          versionSha256,
          "Rendered binary version hash",
        ),
        cdpBrowserSha256: requireSha256(
          cdpBrowserSha256,
          "Rendered CDP build hash",
        ),
      }),
    ),
    ...(profileContinuity
      ? { profileContinuityBeforeLaunchSha256: profileContinuity }
      : {}),
  });
};

const assertRenderedProcessIdentity = (identity, label) => {
  const profileContinuity = identity?.profileContinuityBeforeLaunchSha256;
  return Object.freeze({
    processIdSha256: requireSha256(
      identity?.processIdSha256,
      `${label} process id hash`,
    ),
    processInstanceSha256: requireSha256(
      identity?.processInstanceSha256,
      `${label} process instance hash`,
    ),
    profileSha256: requireSha256(
      identity?.profileSha256,
      `${label} profile hash`,
    ),
    browserBuildSha256: requireSha256(
      identity?.browserBuildSha256,
      `${label} browser build hash`,
    ),
    applicationIdentitySha256: requireSha256(
      identity?.applicationIdentitySha256,
      `${label} application identity hash`,
    ),
    ...(profileContinuity === undefined
      ? {}
      : {
          profileContinuityBeforeLaunchSha256: requireSha256(
            profileContinuity,
            `${label} profile continuity hash`,
          ),
        }),
  });
};

const assertCrossProcessProjection = (view, label) => {
  requireSha256(view?.conversationIdSha256, `${label} conversation hash`);
  requireSha256(view?.rowsSha256, `${label} rows hash`);
  assert(
    view.completeHistory === true &&
      view.atNewestTail === true &&
      Number.isSafeInteger(view.rowCount) &&
      view.rowCount >= 1 &&
      Array.isArray(view.rowIdHashes) &&
      view.rowIdHashes.length === view.rowCount &&
      new Set(view.rowIdHashes).size === view.rowIdHashes.length &&
      Array.isArray(view.userTextHashes) &&
      Array.isArray(view.assistantTextHashes),
    `${label} is not a complete rendered projection.`,
  );
  for (const digest of [
    ...view.rowIdHashes,
    ...view.userTextHashes,
    ...view.assistantTextHashes,
  ]) {
    requireSha256(digest, `${label} row hash`);
  }
  return view;
};

const assertPrimaryCrossProcessPhase = (phase, label) => {
  requireSha256(phase?.targetIdSha256, `${label} target hash`);
  const authority = phase?.authority ?? phase?.identity;
  assert(
    authority?.authenticated === true &&
      authority.anonymous === false &&
      authority.identityClass === "non-anonymous" &&
      authority.credentialMaterialReturned === false &&
      Number.isSafeInteger(authority.identityRevision) &&
      authority.identityRevision >= 0,
    `${label} is not a hash-only non-anonymous rendered authority.`,
  );
  for (const [digestLabel, digest] of Object.entries({
    identity: authority.identitySha256,
    session: authority.sessionIdSha256,
    jwt: authority.jwtSha256,
    owner: authority.ownerAccountSha256,
    binding: authority.sessionJwtBindingSha256,
  })) {
    requireSha256(digest, `${label} ${digestLabel} hash`);
  }
  return Object.freeze({
    authority,
    process: assertRenderedProcessIdentity(
      phase.processIdentity,
      `${label} process`,
    ),
    targetIdSha256: phase.targetIdSha256,
    view: assertCrossProcessProjection(phase.view, `${label} view`),
  });
};

const assertSecondaryCrossProcessPhase = (phase, label) => {
  requireSha256(phase?.targetIdSha256, `${label} target hash`);
  const authority = phase?.authority;
  assert(
    authority?.authenticated === true &&
      authority.anonymous === true &&
      authority.identityClass === "anonymous-secondary" &&
      authority.credentialMaterialReturned === false,
    `${label} is not a hash-only anonymous rendered authority.`,
  );
  for (const [digestLabel, digest] of Object.entries({
    identity: authority.identitySha256,
    session: authority.sessionIdSha256,
    jwt: authority.jwtSha256,
    owner: authority.ownerAccountSha256,
    binding: authority.sessionJwtBindingSha256,
  })) {
    requireSha256(digest, `${label} ${digestLabel} hash`);
  }
  return Object.freeze({
    authority,
    process: assertRenderedProcessIdentity(
      phase.processIdentity,
      `${label} process`,
    ),
    targetIdSha256: phase.targetIdSha256,
    view: assertCrossProcessProjection(phase.view, `${label} view`),
  });
};

/**
 * Composes hash-only observations from isolated primary and secondary
 * Electron profiles. B is deliberately never injected into A; the secondary
 * profile is stopped and relaunched to prove persisted anonymous authority.
 */
export const composeRenderedCrossProcessIdentityRoundTrip = ({
  primaryBefore,
  secondaryBefore,
  secondaryStopReceipt,
  secondaryAfter,
  primaryAfter,
  accountACanarySha256,
  accountBCanarySha256,
}) => {
  requireSha256(accountACanarySha256, "Cross-process account A canary hash");
  requireSha256(accountBCanarySha256, "Cross-process account B canary hash");
  assert(
    accountACanarySha256 !== accountBCanarySha256,
    "Cross-process rendered canaries must be distinct.",
  );
  const aBefore = assertPrimaryCrossProcessPhase(
    primaryBefore,
    "Primary before B",
  );
  const bBefore = assertSecondaryCrossProcessPhase(
    secondaryBefore,
    "Secondary before restart",
  );
  const bAfter = assertSecondaryCrossProcessPhase(
    secondaryAfter,
    "Secondary after restart",
  );
  const aAfter = assertPrimaryCrossProcessPhase(
    primaryAfter,
    "Primary after B",
  );
  assert(
    secondaryStopReceipt?.stopped === true &&
      secondaryStopReceipt.processInstanceSha256 ===
        bBefore.process.processInstanceSha256 &&
      secondaryStopReceipt.profileSha256 === bBefore.process.profileSha256 &&
      secondaryStopReceipt.applicationIdentitySha256 ===
        bBefore.process.applicationIdentitySha256,
    "Cross-process secondary restart is not chained to its verified stop.",
  );
  assert(
    aBefore.authority.identitySha256 === aAfter.authority.identitySha256 &&
      aBefore.authority.sessionIdSha256 === aAfter.authority.sessionIdSha256 &&
      aBefore.authority.ownerAccountSha256 ===
        aAfter.authority.ownerAccountSha256 &&
      aAfter.authority.existingProfileContinuityVerified === true &&
      aBefore.authority.identitySha256 !== bBefore.authority.identitySha256 &&
      aBefore.authority.ownerAccountSha256 !==
        bBefore.authority.ownerAccountSha256 &&
      bBefore.authority.identitySha256 === bAfter.authority.identitySha256 &&
      bBefore.authority.sessionIdSha256 === bAfter.authority.sessionIdSha256 &&
      bBefore.authority.ownerAccountSha256 ===
        bAfter.authority.ownerAccountSha256 &&
      bAfter.authority.existingProfileContinuityVerified === true,
    "Cross-process rendered identities did not preserve isolated A/B authority.",
  );
  assert(
    aBefore.process.processInstanceSha256 ===
      aAfter.process.processInstanceSha256 &&
      aBefore.targetIdSha256 === aAfter.targetIdSha256 &&
      bBefore.process.processInstanceSha256 !==
        bAfter.process.processInstanceSha256 &&
      bBefore.targetIdSha256 !== bAfter.targetIdSha256 &&
      bBefore.process.profileSha256 === bAfter.process.profileSha256 &&
      bBefore.process.applicationIdentitySha256 ===
        bAfter.process.applicationIdentitySha256 &&
      aBefore.process.profileSha256 !== bBefore.process.profileSha256 &&
      aBefore.process.applicationIdentitySha256 !==
        bBefore.process.applicationIdentitySha256,
    "Cross-process rendered process/profile isolation is invalid.",
  );
  const aTextHashes = [
    ...aBefore.view.userTextHashes,
    ...aBefore.view.assistantTextHashes,
  ];
  const bTextHashes = [
    ...bBefore.view.userTextHashes,
    ...bBefore.view.assistantTextHashes,
  ];
  assert(
    aBefore.view.conversationIdSha256 === aAfter.view.conversationIdSha256 &&
      aBefore.view.rowsSha256 === aAfter.view.rowsSha256 &&
      bBefore.view.conversationIdSha256 === bAfter.view.conversationIdSha256 &&
      bBefore.view.rowsSha256 === bAfter.view.rowsSha256 &&
      aBefore.view.conversationIdSha256 !== bBefore.view.conversationIdSha256 &&
      !aBefore.view.rowIdHashes.some((digest) =>
        bBefore.view.rowIdHashes.includes(digest),
      ) &&
      aTextHashes.includes(accountACanarySha256) &&
      !aTextHashes.includes(accountBCanarySha256) &&
      bTextHashes.includes(accountBCanarySha256) &&
      !bTextHashes.includes(accountACanarySha256),
    "Cross-process rendered projections did not preserve strict A/B isolation.",
  );
  return Object.freeze({
    outcome: "cross-process-identity-round-trip",
    identityASha256: aBefore.authority.identitySha256,
    identityBSha256: bBefore.authority.identitySha256,
    primarySessionIdSha256: aBefore.authority.sessionIdSha256,
    primaryOwnerAccountSha256: aBefore.authority.ownerAccountSha256,
    primaryJwtBeforeSha256: aBefore.authority.jwtSha256,
    primaryJwtAfterSha256: aAfter.authority.jwtSha256,
    secondarySessionIdSha256: bBefore.authority.sessionIdSha256,
    secondaryOwnerAccountSha256: bBefore.authority.ownerAccountSha256,
    secondaryJwtBeforeSha256: bBefore.authority.jwtSha256,
    secondaryJwtAfterSha256: bAfter.authority.jwtSha256,
    secondaryStopReceiptSha256: sha256(canonicalJson(secondaryStopReceipt)),
    primaryProcessInstanceSha256: aBefore.process.processInstanceSha256,
    secondaryProcessBeforeSha256: bBefore.process.processInstanceSha256,
    secondaryProcessAfterSha256: bAfter.process.processInstanceSha256,
    primaryProfileSha256: aBefore.process.profileSha256,
    secondaryProfileSha256: bBefore.process.profileSha256,
    primaryViewSha256: aBefore.view.rowsSha256,
    secondaryViewSha256: bBefore.view.rowsSha256,
    accountACanarySha256,
    accountBCanarySha256,
    secondaryExistingProfilePreserved: true,
    secondaryRelaunched: true,
    primaryRemainedMounted: true,
    staleContentRejected: true,
    credentialMaterialReturned: false,
  });
};

export const renderedBrowserProcessIdentity = (browser) => {
  assert(
    browser?.surface === "browser-cdp",
    "Rendered browser process identity requires a browser launch.",
  );
  return renderedProcessIdentity({
    pid: browser.pid,
    processFingerprintSha256: browser.processFingerprintSha256,
    profileSha256: browser.profileSha256,
    binarySha256: browser.binarySha256,
    versionSha256: browser.versionSha256,
    cdpBrowserSha256: browser.cdpBrowserSha256,
    applicationIdentitySha256: sha256(`browser:${browser.flavor}`),
    profileContinuityBeforeLaunchSha256:
      browser.profileContinuityBeforeLaunchSha256,
  });
};

export const renderedClientReceipt = ({
  surface,
  operation,
  processIdentity,
  observation,
}) => {
  assert(
    RENDERED_CLIENT_SURFACES.includes(surface),
    "Rendered receipt surface is invalid.",
  );
  assert(
    typeof operation === "string" && /^[a-z0-9._-]{1,80}$/u.test(operation),
    "Rendered receipt operation is invalid.",
  );
  const identity = assertRenderedProcessIdentity(
    processIdentity,
    "Rendered receipt",
  );
  const body = {
    contract: RENDERED_CLIENT_CDP_CONTRACT,
    surface,
    operation,
    outcome: "passed",
    processIdSha256: identity.processIdSha256,
    processInstanceSha256: identity.processInstanceSha256,
    profileSha256: identity.profileSha256,
    browserBuildSha256: identity.browserBuildSha256,
    applicationIdentitySha256: identity.applicationIdentitySha256,
    observationSha256: sha256(canonicalJson(observation)),
  };
  return Object.freeze({
    ...body,
    receiptSha256: sha256(canonicalJson(body)),
  });
};
