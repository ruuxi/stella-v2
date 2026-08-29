/**
 * Resolve the OTA target from what the stores actually serve, not from the
 * newest EAS build.
 *
 * An `eas update` on a channel reaches every installed binary whose runtime
 * fingerprint matches, so publishing against the newest build silently ships
 * JS to a public app whose native side is older. This asks App Store Connect
 * for the live iOS version and Google Play for the completed production
 * release, walks each back to the EAS build and submission that produced it,
 * and refuses to continue unless that build carries the expected channel and a
 * runtime fingerprint identical to the local one.
 *
 * Usage: bun scripts/resolve-public-mobile-builds.ts
 *          [--platform ios|android|all] [--channel <channel>]
 *          [--google-play-key <path>] [--verify-local-fingerprint]
 */
import { execFile } from "node:child_process";
import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

type JsonRecord = Record<string, unknown>;

type EasBuild = {
  id: string;
  status: string;
  appVersion: string;
  appBuildVersion: string;
  gitCommitHash: string;
  updateChannel?: { name?: string } | null;
  runtime?: { version?: string } | null;
  fingerprint?: { hash?: string } | null;
};

type EasSubmission = {
  id: string;
  status: string;
  androidConfig?: { track?: string; releaseStatus?: string } | null;
  submittedBuild?: EasBuild | null;
};

type PlayRelease = {
  name?: string;
  status?: string;
  versionCodes?: string[];
};

type PlayTrack = {
  track?: string;
  releases?: PlayRelease[];
};

type PublicMobileTarget = {
  platform: "ios" | "android";
  storeStatus: string;
  appVersion: string;
  buildNumber: string;
  easBuildId: string;
  easSubmissionId: string;
  channel: string;
  runtimeVersion: string;
  fingerprintHash: string;
  gitCommitHash: string;
  localFingerprint?: string;
};

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const androidPackage = "com.fromyou.stella";
const execFileAsync = promisify(execFile);

export const parseJsonOutput = <T>(output: string): T => {
  const objectIndex = output.indexOf("{");
  const arrayIndex = output.indexOf("[");
  const candidates = [objectIndex, arrayIndex].filter((index) => index >= 0);
  if (candidates.length === 0) throw new Error("Command returned no JSON.");
  return JSON.parse(output.slice(Math.min(...candidates))) as T;
};

export const selectIosLive = (status: JsonRecord): JsonRecord => {
  const ios = status.ios as JsonRecord | undefined;
  const live = ios?.live as JsonRecord | undefined;
  if (!live || live.state !== "READY_FOR_DISTRIBUTION") {
    throw new Error("App Store Connect has no live iOS version ready for distribution.");
  }
  return live;
};

export const selectPlayProductionRelease = (track: PlayTrack): PlayRelease => {
  if (track.track !== "production") {
    throw new Error(`Expected Google Play production track, received ${track.track ?? "unknown"}.`);
  }
  const completed = (track.releases ?? []).filter(
    (release) => release.status?.toLowerCase() === "completed",
  );
  const ranked = completed
    .map((release) => ({
      release,
      versionCode: Math.max(
        ...(release.versionCodes ?? []).map((value) => Number.parseInt(value, 10)),
      ),
    }))
    .filter(({ versionCode }) => Number.isSafeInteger(versionCode))
    .sort((left, right) => right.versionCode - left.versionCode);
  if (ranked.length === 0) {
    throw new Error("Google Play production has no completed release with a version code.");
  }
  return ranked[0].release;
};

export const selectAndroidSubmission = (
  submissions: EasSubmission[],
  versionCode: string,
): EasSubmission => {
  const matches = submissions.filter(
    (submission) =>
      submission.status === "FINISHED" &&
      submission.androidConfig?.track?.toLowerCase() === "production" &&
      submission.androidConfig?.releaseStatus?.toLowerCase() === "completed" &&
      submission.submittedBuild?.status === "FINISHED" &&
      submission.submittedBuild.appBuildVersion === versionCode,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Expected one completed EAS production submission for Google Play version code ${versionCode}, found ${matches.length}.`,
    );
  }
  return matches[0];
};

export const validateEasBuild = (
  build: EasBuild,
  expectedChannel: string,
): { channel: string; runtimeVersion: string; fingerprintHash: string } => {
  const channel = build.updateChannel?.name ?? "";
  const runtimeVersion = build.runtime?.version ?? "";
  const fingerprintHash = build.fingerprint?.hash ?? "";
  if (build.status !== "FINISHED") throw new Error(`EAS build ${build.id} is not finished.`);
  if (channel !== expectedChannel) {
    throw new Error(
      `EAS build ${build.id} targets channel ${channel || "none"}, not ${expectedChannel}.`,
    );
  }
  if (!runtimeVersion || runtimeVersion !== fingerprintHash) {
    throw new Error(`EAS build ${build.id} has inconsistent runtime and fingerprint values.`);
  }
  return { channel, runtimeVersion, fingerprintHash };
};

const runJson = async <T>(args: string[]): Promise<T> => {
  try {
    const { stdout } = await execFileAsync(args[0], args.slice(1), {
      cwd: mobileRoot,
      env: process.env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return parseJsonOutput<T>(stdout);
  } catch (error) {
    const commandError = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `${args.join(" ")} failed: ${commandError.stderr?.trim() || commandError.stdout?.trim() || commandError.message}`,
    );
  }
};

const easJson = <T>(args: string[], nonInteractive = true): Promise<T> =>
  runJson<T>([
    "bun",
    "x",
    "eas-cli",
    ...args,
    "--json",
    ...(nonInteractive ? ["--non-interactive"] : []),
  ]);

const base64Url = (value: string | Uint8Array): string =>
  Buffer.from(value).toString("base64url");

const getGoogleAccessToken = async (account: ServiceAccount): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: account.token_uri ?? "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${base64Url(signer.sign(account.private_key))}`;
  const response = await fetch(account.token_uri ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const body = (await response.json()) as { access_token?: string; error?: string };
  if (!response.ok || !body.access_token) {
    throw new Error(`Google service account authentication failed: ${body.error ?? response.status}.`);
  }
  return body.access_token;
};

const fetchPlayProductionTrack = async (keyPath: string): Promise<PlayTrack> => {
  if (!existsSync(keyPath)) {
    throw new Error(
      `Google Play service account key not found at ${keyPath}. Set GOOGLE_PLAY_SERVICE_ACCOUNT_KEY_PATH.`,
    );
  }
  const account = JSON.parse(readFileSync(keyPath, "utf8")) as ServiceAccount;
  const token = await getGoogleAccessToken(account);
  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${androidPackage}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const editResponse = await fetch(`${base}/edits`, {
    method: "POST",
    headers,
    body: JSON.stringify({}),
  });
  const edit = (await editResponse.json()) as { id?: string; error?: { message?: string } };
  if (!editResponse.ok || !edit.id) {
    throw new Error(`Unable to open a Google Play edit: ${edit.error?.message ?? editResponse.status}.`);
  }
  try {
    const trackResponse = await fetch(`${base}/edits/${edit.id}/tracks/production`, { headers });
    const track = (await trackResponse.json()) as PlayTrack & { error?: { message?: string } };
    if (!trackResponse.ok) {
      throw new Error(
        `Unable to read Google Play production: ${track.error?.message ?? trackResponse.status}.`,
      );
    }
    return track;
  } finally {
    await fetch(`${base}/edits/${edit.id}`, { method: "DELETE", headers });
  }
};

const resolveIosTarget = async (expectedChannel: string): Promise<PublicMobileTarget> => {
  const status = await easJson<JsonRecord>(["submit:status", "--platform", "ios"]);
  const live = selectIosLive(status);
  const easBuildId = String(live.easBuildId ?? "");
  const easSubmissionId = String(live.easSubmissionId ?? "");
  if (!easBuildId || !easSubmissionId) {
    throw new Error("The live App Store version is not linked to an EAS build and submission.");
  }
  const build = await easJson<EasBuild>(["build:view", easBuildId], false);
  const validated = validateEasBuild(build, expectedChannel);
  const appVersion = String(live.versionString ?? "");
  const buildNumber = String(live.buildNumber ?? "");
  if (build.appVersion !== appVersion || build.appBuildVersion !== buildNumber) {
    throw new Error(`App Store live version ${appVersion} (${buildNumber}) does not match EAS build ${easBuildId}.`);
  }
  return {
    platform: "ios",
    storeStatus: String(live.state),
    appVersion,
    buildNumber,
    easBuildId,
    easSubmissionId,
    ...validated,
    gitCommitHash: build.gitCommitHash,
  };
};

const listAndroidSubmissions = async (): Promise<EasSubmission[]> => {
  const submissions: EasSubmission[] = [];
  for (let offset = 0; offset < 500; offset += 50) {
    const page = await easJson<EasSubmission[]>([
      "submit:list",
      "--platform",
      "android",
      "--limit",
      "50",
      "--offset",
      String(offset),
    ]);
    submissions.push(...page);
    if (page.length < 50) break;
  }
  return submissions;
};

const resolveAndroidTarget = async (
  expectedChannel: string,
  keyPath: string,
): Promise<PublicMobileTarget> => {
  const track = await fetchPlayProductionTrack(keyPath);
  const release = selectPlayProductionRelease(track);
  const versionCode = String(
    Math.max(...(release.versionCodes ?? []).map((value) => Number.parseInt(value, 10))),
  );
  const submission = selectAndroidSubmission(await listAndroidSubmissions(), versionCode);
  const build = submission.submittedBuild as EasBuild;
  const validated = validateEasBuild(build, expectedChannel);
  return {
    platform: "android",
    storeStatus: String(release.status),
    appVersion: build.appVersion,
    buildNumber: build.appBuildVersion,
    easBuildId: build.id,
    easSubmissionId: submission.id,
    ...validated,
    gitCommitHash: build.gitCommitHash,
  };
};

const localFingerprint = async (platform: "ios" | "android"): Promise<string> => {
  const result = await runJson<{ hash?: string }>([
    "bun",
    "x",
    "@expo/fingerprint",
    "fingerprint:generate",
    "--platform",
    platform,
  ]);
  if (!result.hash) throw new Error(`Unable to compute the local ${platform} fingerprint.`);
  return result.hash;
};

const readArg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const main = async () => {
  const platform = readArg("--platform") ?? "all";
  const expectedChannel = readArg("--channel") ?? "preview";
  const verifyFingerprint = process.argv.includes("--verify-local-fingerprint");
  if (!new Set(["ios", "android", "all"]).has(platform)) {
    throw new Error("--platform must be ios, android, or all.");
  }
  const keyPath = resolve(
    readArg("--google-play-key") ??
      process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_KEY_PATH ??
      join(homedir(), ".stella", "google-play", "stella-google-play-eas-submit.json"),
  );
  const targets: PublicMobileTarget[] = [];
  if (platform === "ios" || platform === "all") {
    targets.push(await resolveIosTarget(expectedChannel));
  }
  if (platform === "android" || platform === "all") {
    targets.push(await resolveAndroidTarget(expectedChannel, keyPath));
  }
  if (verifyFingerprint) {
    for (const target of targets) {
      target.localFingerprint = await localFingerprint(target.platform);
      if (target.localFingerprint !== target.runtimeVersion) {
        throw new Error(
          `${target.platform} local fingerprint ${target.localFingerprint} does not match public ${target.appVersion} (${target.buildNumber}) runtime ${target.runtimeVersion}.`,
        );
      }
    }
  }
  console.log(JSON.stringify({ source: "public-store-status", targets }, null, 2));
};

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
