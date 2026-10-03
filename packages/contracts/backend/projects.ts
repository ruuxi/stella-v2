/**
 * Cloud projects: named directories cloud agents work in, either
 * Stella-hosted or backed by a GitHub repository the owner's installation of
 * Stella's GitHub App can reach.
 *
 * Connecting GitHub is two halves. `projects.startGithubInstall` opens the
 * App install; GitHub's redirect back to the backend proves which GitHub user
 * installed it and shows a one-time connect code. The owner types that code
 * into `projects.finishGithubConnect`, which is the only call that binds an
 * installation to the account.
 */

export type CloudProject = {
  projectId: string;
  slug: string;
  name: string;
  /** `github` (with `remoteUrl`) or `stella`. */
  provider: string;
  remoteUrl?: string;
  githubConnected: boolean;
  defaultBranch: string;
  status: string;
  createdAt: number;
  updatedAt: number;
};

export type GithubConnection = {
  installationId: string;
  accountLogin: string;
  accountType: string;
  /** `active` or `suspended`. */
  status: string;
  updatedAt: number;
};

export type ProjectCalls = {
  /**
   * With `remoteUrl` a GitHub project (it needs a connected installation;
   * with one connection `installationId` may be omitted), otherwise a
   * Stella-hosted one.
   */
  "projects.create": {
    args: {
      name: string;
      slug?: string;
      remoteUrl?: string;
      defaultBranch?: string;
      installationId?: string;
    };
    result: CloudProject;
  };
  /** The GitHub App install URL to open. Its `state` lasts 15 minutes. */
  "projects.startGithubInstall": {
    args: Record<string, never>;
    result: { installUrl: string };
  };
  /** Bind the installation behind a connect code GitHub's redirect showed. */
  "projects.finishGithubConnect": {
    args: { connectCode: string };
    result: { ok: boolean; accountLogin: string; accountType: string; reason?: string };
  };
};

export type ProjectViews = {
  /** Newest first. */
  "projects.list": { args: Record<string, never>; result: CloudProject[] };
  "projects.github": {
    args: Record<string, never>;
    result: { appConfigured: boolean; connections: GithubConnection[] };
  };
};
