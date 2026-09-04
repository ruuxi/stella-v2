import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { formatConnectCode } from "../cloud_projects";
import { constantTimeEqual, hmacSha256Hex } from "../lib/crypto_utils";
import { assertOwnerDataAccessActive } from "../owner_lifecycle";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const serviceAuthorized = (request: Request): boolean => {
  const secret = process.env.BUILDER_SERVICE_SECRET?.trim();
  return Boolean(
    secret && request.headers.get("authorization") === `Bearer ${secret}`,
  );
};

// C2: every project mounts at the same path in the sandbox.

type ProjectRow = {
  projectId: string;
  ownerId: string;
  slug: string;
  name: string;
  remoteUrl?: string;
  provider: string;
  installationId?: string;
  defaultBranch: string;
  setupScript?: string;
  lastCheckpointAt?: number;
  status: string;
};

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );

const page = (title: string, detail: string, status = 200, extra = "") =>
  new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${title}</title>` +
      `<body style="font-family:system-ui,-apple-system,sans-serif;max-width:34rem;margin:18vh auto;padding:0 1.5rem;line-height:1.5">` +
      `<h1 style="font-size:1.25rem;margin:0 0 .5rem">${title}</h1>` +
      `<p style="margin:0;color:#555">${detail}</p>${extra}</body>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );

export function registerCloudProjectRoutes(http: HttpRouter) {
  // Turn-start credential fetch. The builder worker calls this with the
  // service secret and gets a repository-scoped installation token that
  // expires in about an hour — nothing long-lived ever leaves Convex.
  http.route({
    path: "/api/cloud/projects/credentials",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request))
        return json({ error: "Unauthorized" }, 401);
      const body = (await request.json()) as {
        ownerId?: string;
        ownerGeneration?: string;
        projectId?: string;
        slug?: string;
      };
      if (!body.ownerId || !body.ownerGeneration?.trim()) {
        return json({ error: "ownerId and ownerGeneration required" }, 400);
      }
      try {
        const current = await assertOwnerDataAccessActive(ctx, body.ownerId);
        if (current.generation !== body.ownerGeneration.trim()) {
          return json({ error: "Owner data generation is stale" }, 409);
        }
      } catch {
        return json({ error: "Owner data is unavailable" }, 409);
      }
      const project = (await ctx.runQuery(
        internal.cloud_projects.resolveProjectInternal,
        {
          ownerId: body.ownerId,
          projectId: body.projectId,
          slug: body.slug,
        },
      )) as ProjectRow | null;
      if (!project) return json({ error: "Project not found." }, 404);

      const base = {
        projectId: project.projectId,
        slug: project.slug,
        name: project.name,
        provider: project.provider,
        defaultBranch: project.defaultBranch,
        setupScript: project.setupScript,
        lastCheckpointAt: project.lastCheckpointAt,
      };
      if (project.provider !== "github" || !project.remoteUrl) {
        // Stella-hosted: the restored directory is the git home, no remote.
        return json({ ...base, remoteUrl: null, token: null });
      }
      try {
        const credential = (await ctx.runAction(
          internal.cloud_projects.mintInstallationTokenInternal,
          {
            ownerId: body.ownerId,
            ownerGeneration: body.ownerGeneration.trim(),
            projectId: project.projectId,
          },
        )) as {
          token: string;
          expiresAt: number;
          remoteUrl: string;
          authorName?: string;
          authorEmail?: string;
        };
        return json({
          ...base,
          remoteUrl: credential.remoteUrl,
          token: credential.token,
          tokenExpiresAt: credential.expiresAt,
          // git wants the token as the password of the x-access-token user.
          tokenUsername: "x-access-token",
          // Commit identity for the project clone; absent until the owner's
          // connect handshake has proven a GitHub user.
          ...(credential.authorName && credential.authorEmail
            ? {
                authorName: credential.authorName,
                authorEmail: credential.authorEmail,
              }
            : {}),
        });
      } catch (error) {
        const message =
          error && typeof error === "object" && "data" in error
            ? String((error as { data: unknown }).data)
            : "Could not obtain a GitHub credential for this project.";
        return json(
          { ...base, remoteUrl: project.remoteUrl, error: message },
          502,
        );
      }
    }),
  });

  // First-run setup the builder inferred (install script, instance size) plus
  // checkpoint bookkeeping, so later spawns restore instead of re-installing.
  http.route({
    path: "/api/cloud/projects/setup",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (!serviceAuthorized(request))
        return json({ error: "Unauthorized" }, 401);
      const body = (await request.json()) as {
        ownerId?: string;
        ownerGeneration?: string;
        projectId?: string;
        slug?: string;
        setupScript?: string;
        checkpointedAt?: number;
        status?: string;
      };
      if (!body.ownerId || !body.ownerGeneration?.trim()) {
        return json({ error: "ownerId and ownerGeneration required" }, 400);
      }
      const project = (await ctx.runQuery(
        internal.cloud_projects.resolveProjectInternal,
        {
          ownerId: body.ownerId,
          projectId: body.projectId,
          slug: body.slug,
        },
      )) as ProjectRow | null;
      if (!project) return json({ error: "Project not found." }, 404);
      const result = await ctx.runMutation(
        internal.cloud_projects.recordProjectSetupInternal,
        {
          ownerId: body.ownerId,
          ownerGeneration: body.ownerGeneration.trim(),
          projectId: project.projectId,
          setupScript:
            typeof body.setupScript === "string" ? body.setupScript : undefined,
          lastCheckpointAt:
            typeof body.checkpointedAt === "number"
              ? body.checkpointedAt
              : undefined,
          status: typeof body.status === "string" ? body.status : undefined,
          now: Date.now(),
        },
      );
      return json(result, result.ok ? 200 : 400);
    }),
  });

  // GitHub App "Setup URL" and OAuth "Callback URL" — one path, two legs.
  //
  // Leg 1 carries `installation_id` + our `state`. The installation id is
  // whatever the query string says, so it authorizes nothing: the leg only
  // records the claim and sends the browser to /login/oauth/authorize.
  // Leg 2 comes back with `code` + the verification state, which is where the
  // connecting GitHub user is identified and checked against the installation.
  // (If the App has "request user authorization during installation" enabled,
  // GitHub sends `code` on leg 1 and both legs collapse into one request —
  // handled below without a second round trip.)
  //
  // Neither leg binds anything. This route is unauthenticated by construction —
  // a top-level redirect from github.com carries no Convex credentials — so it
  // can prove which GitHub user is connecting but not which Stella user asked.
  // It ends by handing the browser a connect code; the bind happens in
  // cloud_projects:finishGithubConnect, which runs with a Stella session.
  http.route({
    path: "/api/cloud/projects/github/callback",
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const url = new URL(request.url);
      const stateId = url.searchParams.get("state")?.trim();
      const installationId = url.searchParams.get("installation_id")?.trim();
      const code = url.searchParams.get("code")?.trim();
      const setupAction = url.searchParams.get("setup_action")?.trim();
      const redirectUri =
        process.env.GITHUB_APP_OAUTH_REDIRECT_URL?.trim() ||
        `${url.origin}${url.pathname}`;

      if (setupAction === "request" && !installationId) {
        return page(
          "Install request sent",
          "GitHub asked an owner of that account to approve the Stella app. Connect again from Stella once they have.",
        );
      }
      if (!stateId || (!installationId && !code)) {
        return page(
          "Couldn't finish connecting GitHub",
          "That link was missing its installation details. Start the connection again from Stella.",
          400,
        );
      }

      let verifyStateId = stateId;
      if (installationId) {
        const begun = (await ctx.runMutation(
          internal.cloud_projects.beginGithubVerificationInternal,
          { stateId, installationId, now: Date.now() },
        )) as { ok: boolean; verifyStateId: string };
        if (begun.ok) {
          if (!code) {
            const clientId = process.env.GITHUB_APP_CLIENT_ID?.trim();
            if (!clientId) {
              return page(
                "GitHub isn't fully configured",
                "This deployment can't verify GitHub accounts yet. Ask the operator to finish the GitHub app setup.",
                503,
              );
            }
            const authorize = new URL(
              "https://github.com/login/oauth/authorize",
            );
            authorize.searchParams.set("client_id", clientId);
            authorize.searchParams.set("state", begun.verifyStateId);
            authorize.searchParams.set("redirect_uri", redirectUri);
            return Response.redirect(authorize.toString(), 302);
          }
          verifyStateId = begun.verifyStateId;
        } else if (!code) {
          return page(
            "That connection link expired",
            "Start the GitHub connection again from Stella — links are single-use and last 15 minutes.",
            400,
          );
        }
        // Otherwise `state` is already a verification state and GitHub simply
        // echoed installation_id back on the identity leg: fall through and let
        // the stored state — not the query string — name the installation.
      }

      const result = (await ctx.runAction(
        internal.cloud_projects.completeGithubConnectInternal,
        { verifyStateId, code: code!, redirectUri },
      )) as {
        ok: boolean;
        accountLogin: string;
        connectCode?: string;
        reason?: string;
      };
      if (!result.ok || !result.connectCode) {
        return page(
          "Couldn't finish connecting GitHub",
          escapeHtml(
            result.reason ??
              "Start the GitHub connection again from Stella — links are single-use and last 15 minutes.",
          ),
          400,
        );
      }
      // The code is shown, never redirected with. This handler has no Stella
      // session to check, so it cannot be the thing that binds the
      // installation; carrying the code back into Stella by hand is what
      // supplies the missing half of the proof. Auto-forwarding it into a
      // client that submits on load would hand that half back to whoever
      // crafted the link.
      const back = process.env.CLOUD_PROJECTS_CONNECT_REDIRECT_URL?.trim();
      return page(
        "One step left",
        `Enter this code in Stella to finish connecting ${escapeHtml(result.accountLogin) || "GitHub"}. ` +
          `It works once, only in the Stella account that started this connection, and expires in 10 minutes.`,
        200,
        `<p style="margin:1.25rem 0 0;font:600 1.6rem/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;user-select:all">` +
          `${escapeHtml(formatConnectCode(result.connectCode))}</p>` +
          (back
            ? `<p style="margin:1.25rem 0 0"><a href="${escapeHtml(back)}">Back to Stella</a></p>`
            : ""),
      );
    }),
  });

  // Installation lifecycle. Without this a revoked installation stays listed
  // and fails only at clone time.
  http.route({
    path: "/api/cloud/projects/github/webhook",
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      const secret = process.env.GITHUB_APP_WEBHOOK_SECRET?.trim();
      if (!secret) return json({ error: "Not configured" }, 503);
      const raw = await request.text();
      if (raw.length > 1_000_000)
        return json({ error: "Payload too large" }, 413);
      const signature = request.headers.get("x-hub-signature-256") ?? "";
      const expected = `sha256=${await hmacSha256Hex(secret, raw)}`;
      if (!constantTimeEqual(signature, expected)) {
        return json({ error: "Unauthorized" }, 401);
      }
      const event = request.headers.get("x-github-event") ?? "";
      if (event !== "installation") return json({ ok: true, ignored: event });
      const body = JSON.parse(raw) as {
        action?: string;
        installation?: { id?: number };
      };
      const installationId = body.installation?.id;
      if (typeof installationId !== "number") {
        return json({ ok: true, ignored: "no installation id" });
      }
      const status =
        body.action === "deleted"
          ? "deleted"
          : body.action === "suspend"
            ? "suspended"
            : body.action === "unsuspend"
              ? "active"
              : null;
      if (!status) return json({ ok: true, ignored: body.action ?? "" });
      await ctx.runMutation(
        internal.cloud_projects.setInstallationStatusInternal,
        { installationId: String(installationId), status, now: Date.now() },
      );
      return json({ ok: true });
    }),
  });
}
