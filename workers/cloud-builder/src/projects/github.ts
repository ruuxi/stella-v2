/**
 * Stella's GitHub App: the App JWT, short-lived installation tokens, and the
 * user-identity reads the connect handshake uses. Only an installation id is
 * ever stored; tokens are minted when needed and never persisted.
 *
 * Optional secrets (absent on dev until the App exists):
 *   GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY (PEM, PKCS#1 or PKCS#8),
 *   GITHUB_APP_SLUG, GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET,
 *   GITHUB_WEBHOOK_SECRET.
 */

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_WEB_BASE = "https://github.com";
const USER_AGENT = "stella-cloud";
// GitHub rejects App JWTs that expire more than 10 minutes out.
const APP_JWT_TTL_SECONDS = 540;
// Backdating iat absorbs clock drift ("issued in the future").
const APP_JWT_BACKDATE_SECONDS = 60;
const USER_INSTALLATION_PAGES = 3;

export const INSTALLATION_ID_PATTERN = /^[0-9]{1,20}$/;

/** D1 `github_installations(installation_id, owner_id)`: routes webhooks to an owner. */
export const installationIndex = (env: Cloudflare.Env): D1Database => {
  if (!env.DB) throw new Error("The DB binding is missing.");
  return env.DB;
};

type GithubSecret =
  | "GITHUB_APP_ID"
  | "GITHUB_APP_PRIVATE_KEY"
  | "GITHUB_APP_SLUG"
  | "GITHUB_APP_CLIENT_ID"
  | "GITHUB_APP_CLIENT_SECRET"
  | "GITHUB_WEBHOOK_SECRET";

export const githubSecret = (env: Cloudflare.Env, name: GithubSecret): string | undefined =>
  (env as unknown as Partial<Record<GithubSecret, string>>)[name]?.trim() || undefined;

/** A failure whose message is safe to show the user. */
export class GithubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubError";
  }
}

const NOT_CONFIGURED = "GitHub projects aren't configured on this deployment yet.";

/** Everything the connect handshake needs: minting, identity and the install URL. */
export const githubAppConfigured = (env: Cloudflare.Env): boolean =>
  Boolean(
    githubSecret(env, "GITHUB_APP_ID") &&
      githubSecret(env, "GITHUB_APP_PRIVATE_KEY") &&
      githubSecret(env, "GITHUB_APP_SLUG") &&
      githubSecret(env, "GITHUB_APP_CLIENT_ID") &&
      githubSecret(env, "GITHUB_APP_CLIENT_SECRET"),
  );

// ── App JWT ───────────────────────────────────────────────────────────────

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

const pemBody = (pem: string, label: string): Uint8Array | null => {
  const match = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`).exec(pem);
  if (!match) return null;
  try {
    return Uint8Array.from(atob(match[1]!.replace(/\s+/g, "")), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
};

const derLength = (length: number): number[] => {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let remaining = length; remaining > 0; remaining >>= 8) bytes.unshift(remaining & 0xff);
  return [0x80 | bytes.length, ...bytes];
};

const derTagged = (tag: number, body: Uint8Array): Uint8Array => {
  const header = [tag, ...derLength(body.length)];
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
};

// AlgorithmIdentifier { rsaEncryption, NULL }.
const RSA_ALGORITHM_IDENTIFIER = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
]);

/**
 * GitHub issues App keys as PKCS#1 ("BEGIN RSA PRIVATE KEY"), which WebCrypto
 * cannot import; wrap the same DER in a PKCS#8 envelope.
 */
const pkcs8Der = (pem: string): Uint8Array => {
  const pkcs8 = pemBody(pem, "PRIVATE KEY");
  if (pkcs8) return pkcs8;
  const pkcs1 = pemBody(pem, "RSA PRIVATE KEY");
  if (!pkcs1) throw new GithubError("The GitHub app private key on this deployment couldn't be loaded.");
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const key = derTagged(0x04, pkcs1);
  const body = new Uint8Array(version.length + RSA_ALGORITHM_IDENTIFIER.length + key.length);
  body.set(version, 0);
  body.set(RSA_ALGORITHM_IDENTIFIER, version.length);
  body.set(key, version.length + RSA_ALGORITHM_IDENTIFIER.length);
  return derTagged(0x30, body);
};

const appJwt = async (env: Cloudflare.Env): Promise<string> => {
  const appId = githubSecret(env, "GITHUB_APP_ID");
  const rawKey = githubSecret(env, "GITHUB_APP_PRIVATE_KEY");
  if (!appId || !rawKey) throw new GithubError(NOT_CONFIGURED);
  // Secrets commonly carry the PEM with escaped newlines.
  const pem = rawKey.includes("\\n") ? rawKey.replaceAll("\\n", "\n") : rawKey;
  let key: CryptoKey;
  try {
    const der = pkcs8Der(pem);
    const owned = new Uint8Array(der.byteLength);
    owned.set(der);
    key = await crypto.subtle.importKey(
      "pkcs8",
      owned,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    // Never echo key material into an error.
    throw new GithubError("The GitHub app private key on this deployment couldn't be loaded.");
  }
  const now = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const header = base64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64Url(
    encoder.encode(
      JSON.stringify({ iss: appId, iat: now - APP_JWT_BACKDATE_SECONDS, exp: now + APP_JWT_TTL_SECONDS }),
    ),
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${base64Url(new Uint8Array(signature))}`;
};

const headers = (authorization: string): Record<string, string> => ({
  authorization,
  accept: "application/vnd.github+json",
  "content-type": "application/json",
  "user-agent": USER_AGENT,
  "x-github-api-version": "2022-11-28",
});

const errorText = async (response: Response, fallback: string): Promise<string> => {
  const payload = (await response.json().catch(() => null)) as { message?: string } | null;
  return payload?.message ? `${fallback} (${payload.message})` : fallback;
};

// ── Installations ─────────────────────────────────────────────────────────

/**
 * An installation token, scoped to one repository when `repo` is given so a
 * leaked token can't reach the installation's other repositories.
 */
export const mintInstallationToken = async (
  env: Cloudflare.Env,
  args: { installationId: string; repo?: string },
): Promise<{ token: string; expiresAt: number }> => {
  const response = await fetch(
    `${GITHUB_API_BASE}/app/installations/${encodeURIComponent(args.installationId)}/access_tokens`,
    {
      method: "POST",
      headers: headers(`Bearer ${await appJwt(env)}`),
      body: JSON.stringify(args.repo ? { repositories: [args.repo] } : {}),
    },
  );
  if (!response.ok) {
    throw new GithubError(
      await errorText(
        response,
        response.status === 404
          ? "That GitHub installation is gone. Reconnect GitHub from Settings."
          : "GitHub wouldn't issue an access token for this project.",
      ),
    );
  }
  const payload = (await response.json()) as { token?: string; expires_at?: string };
  if (!payload.token) throw new GithubError("GitHub returned an empty access token.");
  return {
    token: payload.token,
    expiresAt: payload.expires_at ? Date.parse(payload.expires_at) : Date.now() + 3_600_000,
  };
};

/** Uninstall the App from the account. 404 counts as done. */
export const revokeInstallation = async (env: Cloudflare.Env, installationId: string): Promise<void> => {
  if (!INSTALLATION_ID_PATTERN.test(installationId)) return;
  const response = await fetch(`${GITHUB_API_BASE}/app/installations/${encodeURIComponent(installationId)}`, {
    method: "DELETE",
    headers: headers(`Bearer ${await appJwt(env)}`),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 204 || response.status === 404) return;
  throw new Error(await errorText(response, `GitHub installation revocation failed (${response.status})`));
};

export type InstallationAccount = { accountLogin: string; accountType: string; accountId: number };

const EMPTY_ACCOUNT: InstallationAccount = { accountLogin: "", accountType: "", accountId: 0 };

const accountOf = (account?: { login?: string; type?: string; id?: number }): InstallationAccount => ({
  accountLogin: account?.login ?? "",
  accountType: account?.type ?? "",
  accountId: typeof account?.id === "number" ? account.id : 0,
});

/** The App's own view of an installation, or null when GitHub won't say. */
export const fetchInstallationAccount = async (
  env: Cloudflare.Env,
  installationId: string,
): Promise<InstallationAccount | null> => {
  try {
    const response = await fetch(`${GITHUB_API_BASE}/app/installations/${encodeURIComponent(installationId)}`, {
      headers: headers(`Bearer ${await appJwt(env)}`),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { account?: { login?: string; type?: string; id?: number } };
    return accountOf(payload.account);
  } catch {
    return null;
  }
};

// ── The connecting user (handshake identity leg) ──────────────────────────

export const githubAuthorizeUrl = (env: Cloudflare.Env, state: string, redirectUri: string): string => {
  const clientId = githubSecret(env, "GITHUB_APP_CLIENT_ID");
  if (!clientId) throw new GithubError(NOT_CONFIGURED);
  const url = new URL(`${GITHUB_WEB_BASE}/login/oauth/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", redirectUri);
  return url.toString();
};

export const githubInstallUrl = (env: Cloudflare.Env, state: string): string => {
  const slug = githubSecret(env, "GITHUB_APP_SLUG");
  if (!slug) throw new GithubError(NOT_CONFIGURED);
  const url = new URL(`${GITHUB_WEB_BASE}/apps/${encodeURIComponent(slug)}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
};

/**
 * Exchange the browser's `code` for a user-to-server token. The token is used
 * for the identity reads below and dropped; it is never stored or returned.
 */
export const exchangeUserCode = async (
  env: Cloudflare.Env,
  code: string,
  redirectUri: string,
): Promise<string> => {
  const clientId = githubSecret(env, "GITHUB_APP_CLIENT_ID");
  const clientSecret = githubSecret(env, "GITHUB_APP_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new GithubError(NOT_CONFIGURED);
  const response = await fetch(`${GITHUB_WEB_BASE}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
  });
  const payload = (await response.json().catch(() => null)) as {
    access_token?: string;
    error_description?: string;
  } | null;
  if (!response.ok || !payload?.access_token) {
    throw new GithubError(
      payload?.error_description
        ? `GitHub wouldn't confirm who is connecting (${payload.error_description})`
        : "GitHub wouldn't confirm who is connecting.",
    );
  }
  return payload.access_token;
};

export const fetchOAuthUser = async (userToken: string): Promise<{ login: string; id: number }> => {
  const response = await fetch(`${GITHUB_API_BASE}/user`, { headers: headers(`Bearer ${userToken}`) });
  if (!response.ok) throw new GithubError(await errorText(response, "GitHub wouldn't identify that user."));
  const payload = (await response.json()) as { login?: string; id?: number };
  if (!payload.login || typeof payload.id !== "number") {
    throw new GithubError("GitHub wouldn't identify that user.");
  }
  return { login: payload.login, id: payload.id };
};

type UserInstallation = { id: number; account?: { login?: string; type?: string; id?: number } };

const listUserInstallations = async (userToken: string): Promise<UserInstallation[]> => {
  const collected: UserInstallation[] = [];
  for (let page = 1; page <= USER_INSTALLATION_PAGES; page += 1) {
    const response = await fetch(`${GITHUB_API_BASE}/user/installations?per_page=100&page=${page}`, {
      headers: headers(`Bearer ${userToken}`),
    });
    if (!response.ok) {
      throw new GithubError(
        await errorText(response, "GitHub wouldn't list the installations for that account."),
      );
    }
    const batch = ((await response.json()) as { installations?: Array<Partial<UserInstallation>> })
      .installations ?? [];
    for (const item of batch) {
      if (typeof item.id === "number") collected.push({ id: item.id, account: item.account });
    }
    if (batch.length < 100) break;
  }
  return collected;
};

/**
 * Whether the GitHub user behind `userToken` can reach `installationId`. The
 * installation id in the setup redirect is attacker-supplied, so this check
 * is what authorizes it. When the user's own listing is unavailable, the
 * App's view of the installation decides, which is conclusive only for a
 * User-account installation; an org installation that can't be listed is
 * refused.
 */
export const verifyInstallationBelongsToUser = async (
  env: Cloudflare.Env,
  userToken: string,
  installationId: string,
): Promise<{ ok: true; account: InstallationAccount } | { ok: false; reason: string }> => {
  try {
    const match = (await listUserInstallations(userToken)).find(
      (item) => String(item.id) === installationId,
    );
    if (match) return { ok: true, account: accountOf(match.account) };
    return {
      ok: false,
      reason:
        "That GitHub account can't reach the installation the link named. Start the connection again from Stella.",
    };
  } catch {
    const account = await fetchInstallationAccount(env, installationId);
    if (!account) return { ok: false, reason: "GitHub didn't answer for that installation. Try again." };
    const user = await fetchOAuthUser(userToken);
    if (account.accountType === "User" && account.accountId > 0 && account.accountId === user.id) {
      return { ok: true, account };
    }
    return {
      ok: false,
      reason:
        "Stella couldn't confirm that installation belongs to the GitHub account you signed in with. Start the connection again from Stella.",
    };
  }
};

export { EMPTY_ACCOUNT };
