import type { CallArgs } from "@stella/contracts/backend/api";
import { backendClient } from "@/platform/backend/backend-client";
import { useBackendValue } from "@/platform/backend/use-backend-view";

export type {
  CloudProject,
  GithubConnection,
} from "@stella/contracts/backend/projects";

/** The owner's cloud projects, newest first; undefined while loading. */
export const useCloudProjects = () => useBackendValue("projects.list", {});

/** Whether GitHub is configured, and the owner's App installations. */
export const useGithubConnections = () => useBackendValue("projects.github", {});

export const createCloudProject = (args: CallArgs<"projects.create">) =>
  backendClient.call("projects.create", args);

export const startGithubInstall = () =>
  backendClient.call("projects.startGithubInstall", {});

/**
 * The second half of the GitHub handshake: the redirect from github.com
 * proves an installation, this authenticated call proves which Stella account
 * asked for it. The code is typed in by hand on purpose; a client that
 * submits a code it found in a URL is the CSRF the handshake closes.
 */
export const finishGithubConnect = (connectCode: string) =>
  backendClient.call("projects.finishGithubConnect", { connectCode });
