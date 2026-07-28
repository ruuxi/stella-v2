import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Cloud projects: the persistent code workspace behind `project:<slug>`.
 * A project is a mount slug, a git home (a GitHub remote or a Stella-hosted
 * one), and whatever setup the builder inferred on its first run so later
 * spawns restore instead of re-installing.
 *
 * GitHub access is brokered, never stored. Only the App installation id lives
 * here; short-lived installation tokens are minted server-side per turn from
 * GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY and are never persisted.
 */
export const cloudProjectsSchema = {
  cloud_projects: defineTable({
    projectId: v.string(),
    ownerId: v.string(),
    // Workspace identity: the `<slug>` in `project:<slug>`. Immutable, because
    // the sandbox checkpoint key is derived from it.
    slug: v.string(),
    name: v.string(),
    // Normalized https clone URL. Absent for provider "stella".
    remoteUrl: v.optional(v.string()),
    // "github" (brokered remote) | "stella" (R2-backed git home, no remote).
    provider: v.string(),
    // GitHub App installation id, as a string. Never a token.
    installationId: v.optional(v.string()),
    defaultBranch: v.string(),
    // Setup state the builder infers on a first run and replays afterwards.
    setupScript: v.optional(v.string()),
    instanceSize: v.optional(v.string()),
    lastCheckpointAt: v.optional(v.number()),
    // "active" | "archived" | builder-reported states ("ready", "error").
    status: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_projectId", ["projectId"])
    .index("by_ownerId_and_slug", ["ownerId", "slug"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),

  // One row per GitHub App installation an owner has granted. The installation
  // id is a capability handle, not a credential: it is worthless without the
  // App private key, which only the deployment holds.
  cloud_github_installations: defineTable({
    installationId: v.string(),
    ownerId: v.string(),
    accountLogin: v.string(),
    // "User" | "Organization" as reported by GitHub.
    accountType: v.string(),
    // "active" | "suspended".
    status: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_installationId", ["installationId"])
    .index("by_ownerId_and_updatedAt", ["ownerId", "updatedAt"]),

  // Pending App-install handshakes, in three phases. `stateId` is whatever
  // handle the next hop presents, and every row is single-use.
  //
  //   "install" — `stateId` is the state in the install URL. GitHub has not
  //               named an installation yet.
  //   "verify"  — GitHub named an installation; `stateId` is the OAuth state
  //               carrying the browser through /login/oauth/authorize so the
  //               connecting GitHub user can be identified.
  //   "claim"   — the GitHub identity checked out against the installation;
  //               `stateId` is the connect code shown to that browser.
  //
  // Nothing in this table binds an installation on its own. The setup
  // callback's installation id is attacker-controllable and its `state` travels
  // in a URL, so a bind needs BOTH halves of the claim row: the connect code
  // (only the browser that finished the install ever sees it) and a Stella
  // session for `ownerId` (only the account that started the handshake has
  // one). See finishGithubConnect.
  cloud_github_install_states: defineTable({
    stateId: v.string(),
    ownerId: v.string(),
    // Optional so rows minted before the claim leg existed still validate;
    // absent means the phase is read off `installationId`.
    phase: v.optional(v.string()),
    installationId: v.optional(v.string()),
    // Set on a "claim" row: the GitHub account the identity leg verified, so
    // the bind needs no further round trip to GitHub.
    accountLogin: v.optional(v.string()),
    accountType: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_stateId", ["stateId"])
    .index("by_expiresAt", ["expiresAt"])
    // Account deletion drains by owner: a half-finished handshake names the
    // owner and the installation it was about to bind, and expiry is a floor
    // on how long that survives, never a deletion path.
    .index("by_ownerId", ["ownerId"]),
};
