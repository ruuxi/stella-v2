import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { LINK_WALLET_CLIENT_NAME } from "@stella/contracts/link-wallet";

import { linkWalletAuthFile, linkWalletDir } from "./paths.js";
import {
  parseAuthStatus,
  parseJsonObject,
  parseLoginPrompt,
  snapshotFromCli,
} from "./parse.js";
import type { LinkWalletSnapshot } from "@stella/contracts/link-wallet";

export type LinkCliRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type LinkCliRunner = (
  args: string[],
  options: {
    authFile: string;
    signal?: AbortSignal;
    onStdout?: (chunk: string) => void;
  },
) => Promise<LinkCliRunResult>;

const defaultRunner: LinkCliRunner = (args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn("npx", ["--yes", "@stripe/link-cli", ...args], {
      env: {
        ...process.env,
        LINK_AUTH_FILE: options.authFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const onAbort = () => {
      child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });

export const createLinkCli = (options: {
  stellaDataDir: string;
  run?: LinkCliRunner;
}): {
  authFile: string;
  status: () => Promise<LinkWalletSnapshot>;
  login: (
    signal: AbortSignal | undefined,
    onPrompt: (prompt: { verificationUrl?: string; userCode?: string }) => void,
  ) => Promise<LinkWalletSnapshot>;
  logout: () => Promise<void>;
} => {
  const authFile = linkWalletAuthFile(options.stellaDataDir);
  const run = options.run ?? defaultRunner;

  const exec = async (
    args: string[],
    extra?: { signal?: AbortSignal; onStdout?: (chunk: string) => void },
  ) => {
    await fs.mkdir(path.dirname(authFile), { recursive: true });
    const result = await run(
      ["--format", "json", "--auth", authFile, ...args],
      {
        authFile,
        ...(extra?.signal ? { signal: extra.signal } : {}),
        ...(extra?.onStdout ? { onStdout: extra.onStdout } : {}),
      },
    );
    return result;
  };

  const status = async (): Promise<LinkWalletSnapshot> => {
    const auth = await exec(["auth", "status"]);
    const authenticated = parseAuthStatus(parseJsonObject(auth.stdout))
      .authenticated;
    if (!authenticated) return { status: "disconnected" };
    const methods = await exec(["payment-methods", "list"]);
    const transactions = await exec(["transactions", "list"]);
    let spendsJson: unknown = parseJsonObject(transactions.stdout);
    if (transactions.exitCode !== 0) {
      const spends = await exec(["spend-request", "list"]);
      spendsJson = parseJsonObject(spends.stdout);
    }
    return snapshotFromCli({
      authenticated: true,
      paymentMethods: parseJsonObject(methods.stdout),
      spends: spendsJson,
    });
  };

  return {
    authFile,
    status,
    login: async (signal, onPrompt) => {
      await fs.mkdir(linkWalletDir(options.stellaDataDir), { recursive: true });
      let sawPrompt = false;
      await exec(
        [
          "auth",
          "login",
          "--client-name",
          LINK_WALLET_CLIENT_NAME,
          "--interval",
          "2",
          "--timeout",
          "300",
        ],
        {
          signal,
          onStdout: (chunk) => {
            const prompt = parseLoginPrompt(parseJsonObject(chunk));
            if (prompt.verificationUrl || prompt.userCode) {
              sawPrompt = true;
              onPrompt(prompt);
            }
          },
        },
      );
      if (!sawPrompt) {
        const fallback = await exec(["auth", "status"]);
        const prompt = parseLoginPrompt(parseJsonObject(fallback.stdout));
        if (prompt.verificationUrl || prompt.userCode) onPrompt(prompt);
      }
      return status();
    },
    logout: async () => {
      await exec(["auth", "logout"]);
    },
  };
};
