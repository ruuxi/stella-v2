# Stella Cloud Browser Run implementation handoff

Status: frozen phase-2 design contract
Written: 2026-08-26
Implementation order: complete and prove the final Effect + cloud integration first, then implement this browser plan
Primary backend: Cloudflare Browser Run, behind a provider-neutral Stella Browser Gateway

## Purpose

This document preserves the complete implementation intent for adding a ChatGPT Work-like hosted-browser experience to Stella Cloud after the Effect + cloud integration is complete.

The target experience is:

- a cloud agent can use a real hosted browser;
- when a password, passkey, MFA challenge, CAPTCHA, SSO step, device-code approval, or consequential action requires a human, Stella pauses safely and asks the owner;
- the owner completes the step in an isolated surface that the model cannot inspect;
- the task resumes automatically from durable state;
- reusable website session state is encrypted and restored in later browser runs;
- website authentication, OAuth credentials, and action permissions remain separate and independently revocable;
- clearing or revoking browser data destroys the remote state, not merely the Convex metadata;
- no model, sandbox, transcript, log, trace, recording, or notification receives plaintext credentials, cookies, refresh tokens, one-time codes, or reusable Live View URLs.

Cloudflare supplies browser execution, CDP, Live View, and structured human handoff. Stella must supply the security boundary, durable state machine, encrypted identity storage, permissions, notifications, UX, purge semantics, and real-world validation.

## Phase gate

Do not start browser implementation until the final cloud plane has all of the following:

- one working Durable Object orchestrator per cloud-authoritative conversation;
- durable suspension and continuation semantics, or an agreed extension point for them;
- canonical DO journal sequencing, reconnect, recovery, and Convex projection;
- authenticated, owner-bound turn tokens and service-to-service authorization;
- the modern shared Stella desktop/web/mobile chat shell restored;
- explicit cloud failure behavior with no silent local-canonical fallback;
- working account reset and external-object purge semantics;
- real development deployment and dev-harness proof.

The browser work depends on these primitives. It must extend the final architecture rather than revive the historical standalone cloud UI or bypass Effect supervision.

When this phase begins, create its implementation branch from the exact final verified Effect + cloud commit, not from f08756803 or an earlier browser research worktree. Two research-only worktrees existed when this handoff was written:

- /Users/rahulnanda/projects/worktrees/stella-v2-cloud-browser-run on feat/cloud-browser-run, based on f08756803;
- the standalone-cloud browser worktree on feat/cloud-browser-run, based on imported standalone commit 3488af8b5.

Both were clean and contained no browser implementation. They are reference checkouts only and must not be merged as implementation sources. Re-audit all file paths and ownership after the Effect + cloud integration because the recovered cloud modules will move several seams.

Hard prerequisites:

- [ ] Effect-native runtime is green.
- [ ] Cloud conversation DO, journal, R2, and projection are proven.
- [ ] Cloud-authoritative hydration on a clean client is proven.
- [ ] Automatic execution placement is proven.
- [ ] Orchestrated-only behavior has landed.
- [ ] Cloud code mode and real MCP/tool discovery are proven.
- [ ] Cloud memory, Dream, and skills are proven.
- [ ] Final integration and development deployment identifiers are recorded.
- [ ] A fresh browser worktree exists at that exact commit.

## Evidence and certainty

### Directly observed ChatGPT Work behavior

The linked ChatGPT Work demonstration showed this product sequence:

1. the agent starts a task in a separate hosted browser;
2. it reaches an authentication boundary and asks the user to sign in;
3. the user can continue on web or mobile;
4. iOS presents a password-manager credential choice;
5. credentials and OTP are entered in a secure sign-in surface associated with the target website;
6. the agent later asks for an explicit consequential-action confirmation before accepting identity-sensitive terms.

OpenAI's product description also says the hosted browser can retain its own website session data for later Work tasks, while the model does not receive the username or password.

This is product-behavior evidence, not evidence of OpenAI's internal service topology.

### Shipped and documented Cloudflare capabilities

Current first-party Cloudflare documentation establishes:

- Browser Run supports Playwright, Puppeteer, CDP, Live View, and reusable sessions.
- The Playwright package supports exporting cookies, localStorage, and IndexedDB through storage state.
- Human in the Loop exposes Cloudflare.getLiveView, Cloudflare.handoff, Cloudflare.handoffComplete, and Cloudflare.getHandoffState over CDP.
- Human handoff requires tab mode. The Live View URL is a bearer capability and can be short lived.
- Browser sessions are ephemeral and can close, crash, or be released; durable reuse therefore requires exported application-managed state.
- Browser Run traffic is identifiable as bot traffic, including during human control.
- Cloudflare Workflows can durably sleep, retry, and wait for events without keeping a browser or agent process alive.

These facts should be rechecked immediately before implementation because packages, limits, pricing, and beta APIs can change.

### Inferences and Stella-owned design

The Browser Gateway, BrowserProfileSession Durable Object, Convex tables, suspension protocol, permission model, client cards, native mobile isolation, profile encryption, and purge machinery below are Stella design decisions. They are the recommended recreation path, not claims about OpenAI internals.

## Non-negotiable security and product rules

1. The model never receives passwords, passkeys, MFA values, OTPs, cookies, localStorage values, IndexedDB contents, OAuth refresh tokens, or reusable Live View URLs.
2. A sandbox never receives the account-wide Cloudflare Browser binding or a credential capable of enumerating another user's sessions.
3. Browser website state and OAuth refresh tokens use different storage systems and revocation paths.
4. A saved website login never grants a remembered consequential-action permission.
5. Permissions use exact normalized origins and bounded actions. No wildcard domains and no blanket "everything on this site" scope.
6. Human takeover is exclusive. Agent browser commands are rejected while the owner controls the tab.
7. Live View capabilities are minted just in time, owner bound, session/challenge bound, short lived, memory only, and never journaled or logged.
8. A waiting interaction suspends the turn durably and releases unnecessary compute. It is not an open Promise held in a Worker, sandbox, or in-memory agent.
9. Every state transition is revisioned, idempotent, and safe under duplicate delivery, retry, Durable Object eviction, reconnect, or ambiguous network failure.
10. Browser profile writes use one logical writer per profile plus epoch and revision compare-and-swap fencing.
11. Revocation fences new work first, deletes remote sessions and encrypted bytes second, then removes or tombstones metadata.
12. Credential-entry intervals are excluded from screenshots, DOM capture, model observations, audit recording, console/network logging, and session recordings.
13. User-facing copy promises reuse until the website expires or revokes the session, never "signed in forever."
14. The implementation remains provider neutral so Stella can add a different hosted provider or user-local fallback for sites that block bot-identified Browser Run traffic.

## Target topology

```
Modern Stella desktop, hosted web, or mobile shell
    |
    | owner-authenticated challenge decisions and JIT takeover requests
    v
Convex control plane
    - owner authentication and revocation
    - safe profile, interaction, and permission metadata
    - idempotent decision CAS
    - account/reset purge registry
    |
    | owner- and turn-bound internal calls
    v
Conversation Orchestrator Durable Object
    - per-conversation serialized turn
    - journal and resumable continuation
    - running / waiting_for_user / resuming / terminal state
    |
    | narrowly scoped browser commands
    v
Cloud executor or local executor
    |
    v
Stella Browser Gateway Worker
    - service authorization
    - exact-origin and action policy
    - safe command surface and response redaction
    - no account-wide credential leaves this service
    |
    v
BrowserProfileSession Durable Object
    - one logical owner + browser profile
    - exclusive browser lease
    - command idempotency
    - Cloudflare session reconnect/relaunch
    - profile epoch, generation, and revision
    - pending handoff and checkpoint state
    |                       |
    v                       v
Cloudflare Browser Run     Encrypted snapshot objects in R2
Playwright / CDP           cookies + localStorage + IndexedDB
```

Cloudflare Workflows are optional for long device-code polling, expiry/retry reconciliation, and other waits that do not require a live browser.

Browser Run is a sibling of the Stella general-agent Sandbox. Do not install and manage Chromium inside the general sandbox as the primary design.

## Authority and ownership

| State                              | Authority                                    | Notes                                                            |
| ---------------------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| Conversation and turn continuation | Conversation Orchestrator DO journal         | Must survive eviction and reconnect                              |
| Live Browser Run lease             | BrowserProfileSession DO                     | Exclusive profile writer                                         |
| Encrypted browser snapshot bytes   | Browser Worker R2 namespace                  | Owner-addressable prefix; application encryption                 |
| Safe profile snapshot metadata     | Convex                                       | Epoch, generation, hash, size, key version, R2 key               |
| Pending human interaction          | Orchestrator DO plus Convex owner projection | DO owns continuation; Convex makes it discoverable on any device |
| Website action permission          | Convex                                       | Exact owner, profile epoch, origin, action, expiry               |
| OAuth refresh/access credentials   | Existing scoped credential vault             | Never browser storage-state tables                               |
| JIT Live View capability           | Browser Gateway response only                | Memory only; never durable                                       |
| Browser activity and errors        | Redacted structured events                   | No secret payloads or raw DOM during auth                        |

## Core state machines

### Browser profile

```
active
  -> revoking
  -> revoked

active
  -> error
  -> active after verified recovery

reset:
  increment credentialEpoch
  fence old leases and writes
  cancel open interactions
  terminate Browser Run session
  delete encrypted R2 objects
  finalize new empty active profile or revoked tombstone
```

An old epoch can never commit a snapshot or resume a challenge after reset.

### Human interaction

```
requested
  -> presented
  -> claimed
  -> approved | denied | canceled | expired | superseded
  -> consumed exactly once
  -> completed
```

Decision writes compare interactionId plus revision. Retries return the prior result. A second device cannot approve a stale revision.

### Suspended turn

```
running
  -> suspending
  -> waiting_for_user
  -> resuming
  -> running
  -> completed | failed | canceled
```

Entering waiting_for_user must:

- journal the safe challenge descriptor and continuation identity;
- persist turn ID, tool-call ID, request digest, profile epoch, interaction revision, expiry, and continuation metadata;
- stop model/browser command ownership;
- checkpoint and, when appropriate, destroy the general sandbox;
- release the normal running-turn watchdog and replace it with challenge-expiry reconciliation;
- keep conversation queue ordering intact;
- prevent transcript repair from synthesizing a failure for the intentionally unanswered browser tool.

Resumption must:

- atomically consume the matching approved or completed interaction revision;
- revalidate owner, profile epoch, origin, and browser lease;
- append one safe tool result;
- mint a fresh short-lived turn token;
- rebuild history from the canonical journal;
- restore or reconnect the browser profile;
- continue the Effect-supervised agent exactly once.

Cancellation, expiry, profile reset, account revocation, and conversation deletion must terminate the suspended continuation exactly once.

## Convex data model

Use four browser-specific tables. Reuse existing turn, turn-token, engine refresh-lease, and conversation-projection tables rather than duplicating them.

### cloud_browser_profiles

Safe profile identity and lifecycle:

- profileId
- ownerId
- label
- status: active, revoking, revoked, error
- credentialEpoch
- createdAt, updatedAt, lastUsedAt, revokedAt

Required indexes:

- by_profileId
- by_owner_updated
- by_owner_status_updated

### cloud_browser_profile_snapshots

One current mutable metadata row per profile. Ciphertext remains in Browser Worker R2.

- ownerId, profileId, credentialEpoch
- generation and revision
- r2Key
- ciphertext hash and byte length
- wrapped-DEK metadata and key version
- source turn ID
- createdAt, updatedAt

Required behavior:

- validate the R2 key prefix against the owner/profile namespace;
- compare-and-swap epoch plus generation;
- reject stale writers;
- never expose r2Key or encryption metadata through public APIs.

Required indexes:

- by_profileId
- by_owner_updated
- by_owner_profile

### cloud_browser_interactions

Safe metadata for login takeover, device code, and action approval:

- interactionId, ownerId, profileId, credentialEpoch
- conversationId, turnId
- requestKey and requestDigest
- kind and state
- normalized origin and bounded action
- safe display title, hostname, icon metadata
- optional verification URI and user-facing device code only when policy permits
- decision, decision revision, expiry, createdAt, updatedAt, completedAt

Never place passwords, OTPs, cookies, bearer tokens, raw DOM, reusable Live View URLs, or raw browser observations here.

Required indexes:

- by_interactionId
- by_turn_requestKey
- by_turn_state_created
- by_owner_state_created
- by_owner_profile_state_created
- by_expiresAt

### cloud_browser_permissions

- ownerId, profileId, credentialEpoch
- exact normalized origin
- bounded action identifier
- decision: allow or deny
- status and version
- optional expiry
- createdAt, updatedAt

Absence means ask. A remembered allow can only be created atomically from an approved interaction. Do not expose a generic public mutation that can manufacture an allow.

Required indexes:

- by_owner_profile_epoch_origin_action
- by_owner_updated
- by_owner_profile_status_updated
- by_expiresAt

### Public and internal APIs

Owner-authenticated public functions:

- listMyBrowserProfiles
- createMyBrowserProfile
- renameMyBrowserProfile
- listMyPendingBrowserChallenges
- getMyBrowserChallengeDetail
- resolveMyBrowserChallenge
- getMyBrowserTakeoverCapability
- listMyBrowserPermissions
- revokeMyBrowserSite
- resetMyBrowserProfile
- resetAllMyBrowserProfiles
- endMyActiveBrowserSession

Internal worker functions:

- getBrowserRestorePlan
- commitBrowserSnapshot
- touchBrowserProfile
- requestBrowserInteraction
- consumeBrowserInteractionDecision
- completeBrowserInteraction
- expireBrowserInteractions
- beginBrowserProfileRevocation
- finishBrowserProfileRevocation
- buildOwnerBrowserPurgeManifest
- deleteOwnerBrowserMetadataBatch

All sensitive public functions must compose both connected-account authentication and JWT-revocation enforcement. Internal mutations that take ownerId must enforce owner-migration write fencing.

The worker HTTP routes derive owner, conversation, and turn identity from the short-lived turn token. Callers do not submit an authoritative owner ID.

## BrowserProfileSession Durable Object

Key each DO by a non-reversible hash of owner ID plus browser profile ID.

Responsibilities:

- hold one exclusive mutable profile lease;
- deduplicate commands by stable command ID;
- launch, acquire, or reconnect a Browser Run session;
- import the latest decrypted storage state into a fresh context;
- track profile epoch, generation, revision, and active context identity;
- classify browser-close reasons and decide reconnect versus fresh restore;
- reject commands during owner handoff;
- request and reconcile Human in the Loop handoff;
- export storageState with IndexedDB enabled after meaningful authenticated mutations and at safe checkpoints;
- envelope-encrypt before writing R2;
- commit safe snapshot metadata to Convex with CAS;
- persist pending handoff and resume descriptors;
- expose purge and force-terminate operations;
- reconcile orphaned sessions and expired handoffs using alarms or Workflows.

Do not rely only on an in-memory completion listener. DO eviction or Worker restart must not strand a turn.

### Snapshot encryption

Use application envelope encryption:

- generate a data-encryption key per snapshot payload;
- encrypt with authenticated encryption such as AES-GCM;
- wrap the DEK under a versioned environment key;
- bind AAD to owner hash, profile ID, credential epoch, generation, and schema version;
- store ciphertext in an owner-addressable R2 prefix;
- store only safe hash/size/key-version metadata in Convex;
- support key rotation and stale-epoch deletion.

Do not put browser state into the generic small secrets table.

## Browser Gateway and agent contract

The Browser Gateway is the only holder of the Cloudflare Browser binding and browser object credentials.

It exposes a restricted, typed surface:

- create or restore profile session
- navigate
- inspect a redacted page snapshot
- click, type non-secret values, select, scroll, wait
- list or focus tabs within the leased profile
- upload approved task files
- request login handoff
- request consequential-action approval
- checkpoint profile
- close or release session

It must enforce:

- owner/turn/service authentication;
- exact-origin navigation policy and public-URL/SSRF checks;
- command idempotency;
- profile lease and epoch;
- permission checks for consequential actions;
- output size limits and secret/credential redaction;
- blocked access to Cloudflare account/session enumeration;
- no arbitrary CDP passthrough to model-generated code;
- re-observation after any ambiguous mutating outcome.

Navigation enforcement includes:

- allowlisted schemes only;
- rejection of loopback, RFC1918, link-local, cloud-metadata, internal DNS, file, data, javascript, and credential-bearing URLs;
- DNS resolution and rebinding defenses;
- validation again after redirects;
- canonical IDNA/punycode origin handling and phishing/lookalike warnings;
- bounded upload/download sizes, scoped artifact storage, and malware scanning where files cross trust boundaries;
- disabled clipboard and agent observation while human takeover is active.

Use a provider-neutral browser interface so a local Stella browser or another hosted browser can implement the same high-level operations later.

## Runtime integration

Reuse Stella's current browser-use protocol through the existing code-execution host instead of adding a second model-visible browser tool family.

Expected seams after the Effect + cloud reconciliation:

- packages/runtime/kernel/browser-use/client.ts
- packages/runtime/kernel/browser-use/worker-api.ts
- packages/runtime/kernel/tools/types.ts
- packages/runtime/kernel/tools/host.ts
- packages/runtime/kernel/tools/defs/node-repl.ts or its final code-mode successor
- packages/executor-cloud/src/agent-turn.ts
- workers/cloud-builder/src/orchestrator-session.ts
- workers/cloud-builder/src/journal.ts

Implementation direction:

- add an HTTP BrowserSessionClient for cloud execution;
- inject a provider-neutral browserSessionFactory into the tool host;
- forward the browser session into code mode / Node REPL as the existing browser-use API expects;
- keep local desktop browser behavior on the local implementation;
- remove the current cloud prompt claim that a signed-in browser is unavailable;
- add browser capability only to engines that can actually receive the Stella tool host.

Engine parity must be explicit. If Claude receives private Stella MCP tools while Codex does not, Codex cannot be advertised as browser-capable until it receives the same safe contract or browser work is deliberately routed to a capable engine.

The executor result protocol must gain a durable suspension outcome before terminal success/failure handling. A suspended browser tool is not a failed tool and must not be closed by transcript repair.

## Human-login flow

1. The agent reaches a login wall or the Browser Gateway recognizes an authentication boundary.
2. The gateway creates an idempotent login interaction for owner, conversation, turn, profile epoch, and exact origin.
3. The orchestrator journals a safe marker and enters waiting_for_user.
4. The executor checkpoints and releases unnecessary compute.
5. Stella surfaces "Sign in to example.com to continue" on the active client and in the owner's pending-attention list.
6. The owner requests takeover; an authenticated endpoint mints a new short-lived, tab-only Live View capability.
7. The owner enters password/passkey/MFA/CAPTCHA directly into the isolated browser surface.
8. Agent control remains locked during takeover.
9. The owner selects Done or Cancel.
10. The gateway verifies expected post-login state without exposing credentials or raw auth DOM to the model.
11. The BrowserProfileSession exports and encrypts storage state.
12. The interaction completes, the orchestrator consumes it, and the task resumes exactly once.

Initial implementation should use direct tab-only Live View. A later native secure credential sheet can improve password-manager integration, but it must inject credentials directly into the target session without passing through the transcript or model.

Never expose unrestricted DevTools mode to ordinary users.

## Device-code flow

Device-code OAuth does not require a live browser:

1. a tool initiates the provider's device authorization request;
2. Stella persists a device_code interaction with the verification URI, safe display code, polling interval, and expiry;
3. the turn enters waiting_for_user and releases its sandbox/browser;
4. the shared challenge card shows Copy code, Open verification page, expiry, and Cancel;
5. a Workflow or equivalent durable job polls at the provider-required cadence;
6. slow_down, authorization_pending, expiry, denial, and provider errors are handled according to the provider protocol;
7. the refresh token is encrypted in the scoped credential vault;
8. only a safe success result reaches the orchestrator;
9. the turn resumes exactly once.

Do not persist the provider device authorization secret in conversation records. Do not store resulting OAuth credentials in browser profile state.

Prefer keeping the provider's secret device_code in protected Workflow or vault state and returning the human-facing user_code just in time. If cross-device UX requires short-lived user-code persistence, encrypt it, enforce its expiry, and keep it out of transcripts, push payloads, and analytics.

## Consequential-action approval

Authentication is not authorization to act.

Before a meaningful external side effect, evaluate exact origin plus bounded action. Examples:

- submit a government form;
- accept legal or identity terms;
- make a purchase or transfer;
- publish or send externally;
- delete remote data;
- change account security;
- disclose sensitive information.

The card offers:

- Allow once
- Always allow this bounded action on this exact origin, when policy permits
- Deny

High-risk actions can be forced to ask every time regardless of a remembered preference. A remembered permission is revisioned, profile-epoch bound, expirable, and separately revocable.

## Shared client and protocol

The modern desktop UI package is the shared product surface for desktop, hosted web, and the mobile interior. Implement one shared CloudBrowserInterventionCard and render it:

- as a chronological safe conversation marker where protocol-compatible;
- pinned above the composer while unresolved;
- in a global owner-scoped Needs you activity list for challenges in inactive conversations.

Safe DTOs belong in a shared contract module such as packages/contracts/cloud-browser.ts:

- BrowserChallengeSummary
- BrowserChallengeDetail
- BrowserChallengeDecision
- BrowserProfileSummary
- BrowserPermissionSummary

Unknown durable conversation records must advance socket sequence before any new card type ships. The historical client decoder dropped unknown cards without advancing sequence, which can create a gap/backfill loop. Roll out compatibility in this order:

1. make unknown durable records safely advance sequence;
2. expose pending interactions through owner-scoped Convex projection;
3. ship authenticated decision endpoints;
4. ship UI support;
5. only then emit the new durable browser card, or bump the protocol with an explicit compatibility path.

Do not send decision secrets over an ad hoc socket verb. Resolve decisions through authenticated Convex or HTTP APIs with revision CAS.

Conversation cards need a unique interaction/request key in addition to source turn ID and card type; one turn can request more than one handoff.

### Desktop and hosted web takeover

Use a dedicated workspace-display browser tab keyed by session/challenge. Do not reuse a generic URL tab that exposes arbitrary URL editing, title propagation, external-open controls, or navigation history.

The takeover component:

- fetches a fresh capability just in time;
- keeps it only in component memory;
- uses a strict expected Live View host;
- sets no-referrer behavior;
- offers Done, Cancel, and End session;
- does not expose copy URL or open externally;
- discards the capability on unmount and mints a new one on remount.

### Mobile isolation

Never navigate the main mobile WebView to Live View or a target login. The main WebView contains the Stella Convex JWT and native bridge.

Use a separate native modal WebView:

- no Stella JWT injection;
- no Stella native bridge;
- strict Cloudflare Live View host allowlist;
- no arbitrary external navigation;
- ephemeral data store where supported;
- Done and Cancel controls owned by native Stella UI.

Open device-code verification pages through the system browser. Extend the native bridge only with narrowly typed actions such as openTakeover, closeTakeover, openExternal, and copyText, and version the capability/ABI list.

Mobile push notifications may say action required and carry only conversation/challenge identifiers. They must not carry codes, URLs, page titles containing secrets, or session capabilities.

## Settings and lifecycle

Add a Connected websites or Cloud browser data section to the modern account/settings surface:

- profile label and state;
- exact connected sites derived from safe metadata;
- last-used time;
- active session status;
- revoke one site;
- end active session;
- reset one profile;
- clear all cloud browser data.

Semantics:

- sign-out ends active takeover capabilities and sessions; retaining encrypted profile data is allowed only if clearly disclosed and protected by account reauthentication;
- revoke site fences the profile/site, terminates the matching remote session, deletes relevant encrypted state, then updates metadata;
- reset profile increments epoch and destroys all remote profile state;
- account deletion destroys Browser Run sessions, R2 objects, DO state, interactions, permissions, and Convex metadata;
- account linking must not silently transfer browser identity without an explicit, secure ownership policy.

Remote-object deletion comes before final metadata deletion so purge can be retried from an authoritative manifest.

The existing account reset path must be hardened before browser state depends on it: a revoked JWT must not erase its own revocation tombstone, and external cloud purge needs a durable retry path instead of an unfinished best-effort call.

## Observability and secret hygiene

Record safe structured fields:

- request/interaction/command IDs;
- owner hash, profile ID, epoch, generation, and revision;
- conversation and turn IDs;
- normalized origin hostname;
- safe action identifier;
- state transition and latency;
- Browser Run session close reason;
- restore/checkpoint outcome, bytes, and hash;
- retry and dedupe outcome;
- redacted error class.

Never record:

- passwords, passkeys, MFA or OTP values;
- cookies, storage-state JSON, refresh/access tokens;
- device authorization secrets;
- reusable Live View URLs;
- raw Authorization or Cookie headers;
- auth-page DOM, screenshots, console, or network bodies;
- text typed while a handoff is active.

Session recording remains disabled by default. If recording is ever enabled, pause or segment it before auth begins, verify that credentials cannot be reconstructed, document retention, and give the owner control to delete it.

## Failure behavior

| Failure                                 | Required behavior                                                         |
| --------------------------------------- | ------------------------------------------------------------------------- |
| Browser Run session disappeared         | reconnect if valid; otherwise launch fresh and restore encrypted snapshot |
| Snapshot commit races reset             | old epoch loses CAS and ciphertext is deleted                             |
| Mutating command times out              | re-observe state before retry; never blindly repeat                       |
| DO evicted during handoff               | alarm/Workflow and durable descriptor recover state                       |
| Owner approves twice                    | revision CAS returns the single prior outcome                             |
| Website expires session                 | surface sign-in request again; do not claim persistent connection         |
| Site blocks bot traffic                 | explicit unsupported/blocked result and provider-neutral fallback path    |
| Live View capability leaks into history | treat as security defect; revoke/terminate capability and redact          |
| User cancels or interaction expires     | exactly-once canceled tool result and safe task continuation/failure      |
| Profile is revoked during execution     | fence immediately, stop browser, cancel pending interactions              |
| Convex or gateway unavailable           | explicit resumable failure; never silently switch identity or authority   |

## Implementation slices

Complete each slice with focused tests before moving on.

### Slice 0: prerequisites and threat model

- finish the final Effect + cloud plane;
- threat-model browser identities, Live View capabilities, cross-owner access, SSRF, logs, and purge;
- recheck Cloudflare APIs, package version, limits, pricing, and account bindings;
- define the provider-neutral BrowserSession contract.

### Slice 1: compatibility and durable suspension

- unknown-record sequence advancement;
- suspended executor/orchestrator outcome;
- waiting_for_user journal state;
- repair-tail exception;
- challenge expiry alarms;
- fresh-token, exactly-once continuation.

### Slice 2: provider proof of concept

- dev-only provider-neutral Browser Gateway;
- real Browser Run launch and tab-only Live View;
- structured handoff and exclusive control;
- encrypted export, total browser termination, fresh-browser restore;
- controlled test accounts and an early bot-block compatibility sample;
- stop and revise the provider strategy if protected-site results are materially inadequate.

### Slice 3: Convex control plane and purge

- four-table schema;
- connected plus revocation-safe auth helpers;
- owner projection and decision CAS;
- service routes deriving identity from turn token;
- profile reset, account purge manifest, external-first deletion, retry;
- migration/linking residue checks.

### Slice 4: Browser Gateway and BrowserProfileSession

- Cloudflare browser binding and pinned Playwright dependency;
- DO migration/binding and R2 namespace;
- restricted command surface;
- lease, command dedupe, reconnect, close-reason handling;
- storageState import/export with IndexedDB;
- envelope encryption and snapshot CAS;
- purge and orphan reconciliation.

### Slice 5: cloud runtime integration

- HTTP BrowserSessionClient;
- tool-host factory injection;
- code-mode browser API;
- cloud executor capability negotiation;
- engine parity;
- no browser credential in sandbox;
- correct Effect scope shutdown.

### Slice 6: login handoff

- Human in the Loop CDP calls;
- JIT Live View capability;
- exclusive control;
- desktop/web dedicated takeover tab;
- isolated mobile takeover modal;
- verified completion, checkpoint, and resume.

### Slice 7: device code and permissions

- durable device-code workflow;
- challenge card;
- exact-origin bounded approvals;
- remembered permission creation only from approved interaction;
- expiry and revocation.

### Slice 8: settings, activity, and notifications

- pending attention across conversations and devices;
- Needs you state without running shimmer;
- push deep links using opaque IDs;
- connected website/profile management;
- end, revoke, reset, and account purge UX.

### Slice 9: security, load, and real-site proof

- redaction/audit tests;
- concurrency and Browser Run rate limiting;
- restore/cold-start latency;
- cost and session-duration metrics;
- representative target matrix and fallback decisions.

### Slice 10: controlled rollout

- quotas for browser minutes, concurrent profiles, launches, and snapshot size;
- metrics, alerts, kill switch, and provider circuit breaker;
- controlled alpha with authorized test accounts;
- explicit unsupported-site UX;
- security review and gradual rollout;
- no production enablement without separate authorization.

## User-approved initial completion and verification scope (2026-08-27)

The first complete Browser Run product is not gated on the exhaustive hardening
matrix below. Its initial acceptance scope is deliberately narrow and uses only
Stella's managed/default provider:

1. Use one authorized disposable website account on a target that permits
   email/password signup without email confirmation, OTP, payment, or a CAPTCHA.
2. Stella reaches the login boundary and pauses for a direct human Live View
   takeover. The human—not the model, sandbox, or agent tool—enters the email,
   username, and password into the target page.
3. While takeover is active, agent browser commands remain locked. After the
   human finishes, the gateway reports only a bounded completion/result state;
   it never returns the credential-field values or auth-page DOM to the model.
4. The original Stella turn resumes and completes one observable post-login
   task on that site.
5. Persist the encrypted browser profile, terminate the Browser Run session,
   create a genuinely fresh session, restore the profile, and verify that the
   same disposable account remains signed in. This is the proof of reusable
   authentication; an in-memory reconnect does not count.
6. Search the model-visible tool results and retained Stella/Worker evidence for
   the exact disposable email, username, and password. All must be absent. Raw
   browser secrets and credential-field contents are never intentionally
   collected merely to perform this assertion.
7. Reset the disposable browser profile and verify that a subsequent fresh
   session no longer restores the signed-in state.

A normal password login cannot prove device-code behavior, so device-code
support gets one additional controlled fixture or authorized disposable-provider
proof: Stella displays only the user-facing verification URI/code, suspends the
turn without holding an executor open, and resumes after approval without the
provider's device secret or resulting OAuth credentials entering model-visible
state.

Passing those two representative flows is the initial product completion bar.
The broad site matrix, long-tail CAPTCHA/passkey/SSO coverage, alternate-engine
parity, large crash matrix, cost soak, and adversarial lifecycle certification
below are deferred hardening work to perform only when separately requested.
They must not block shipping the complete core Stella Browser Run experience.

## Automated verification

### Protocol and orchestration

- old clients advance over unknown browser records;
- protocol encoders/decoders stay in parity;
- one turn can hold multiple distinct interactions;
- waiting survives Worker restart and DO eviction;
- waits longer than the prior watchdog and turn-token lifetime resume correctly;
- transcript repair does not close an intentionally suspended tool;
- decision, cancel, expiry, reset, and delete are exactly once;
- duplicate delivery cannot duplicate a journal event or action;
- other-device approval resumes the original conversation.

### Data and security

- anonymous, revoked, and cross-owner access is denied;
- internal routes cannot trust caller-supplied owner IDs;
- profile snapshot CAS rejects stale epochs/generations;
- remembered permission can only originate from a valid approved interaction;
- origin normalization rejects confusable/wildcard/SSRF targets;
- ciphertext and metadata purge in the right order;
- account migration/linking cannot leave orphaned browser state;
- no secrets appear in DTOs, journal, Convex rows, logs, traces, errors, push payloads, or recordings;
- Live View capability is no-store, short lived, and single-purpose.

### Browser session

- launch, reconnect, close-reason recovery, and relaunch;
- exclusive lease and command idempotency;
- browser restore from encrypted cookies/localStorage/IndexedDB;
- browser termination followed by fresh-session authentication reuse;
- reset during checkpoint cannot resurrect state;
- mutation timeout forces observation before retry;
- handoff locks agent commands;
- handoff completion persists before continuation dispatch.

### Client and mobile

- pinned card persists across reload/reconnect;
- resolved/denied/expired/canceled variants are accessible;
- keyboard and screen-reader paths work;
- inactive conversation appears in Needs you;
- deep link opens the right challenge;
- main mobile WebView never receives the Live View origin;
- takeover WebView has no Stella JWT or native bridge;
- strict host allowlist blocks redirect escape;
- capability is discarded on close/background/remount.

### Runtime parity

- local desktop continues to use the local browser;
- cloud execution uses Browser Gateway only;
- browser capability never silently changes execution placement;
- Claude, Codex, and other advertised engines receive the same supported contract or are explicitly excluded;
- interruption and shutdown release browser leases under Effect supervision.

## Real acceptance matrix

Test approximately fifteen representative targets in authorized test accounts:

- Google SSO;
- Microsoft SSO;
- GitHub;
- Shopify administration;
- Stripe test dashboard;
- a government portal;
- a travel booking site;
- one financial or insurance sandbox;
- one CAPTCHA-heavy site;
- one IndexedDB-heavy application;
- one device-code OAuth provider;
- passkey/WebAuthn where Browser Run supports the flow;
- password-manager-assisted mobile handoff;
- an action requiring explicit legal/identity confirmation;
- a site known to restrict bot-identified hosting traffic.

For every target:

1. begin unauthenticated in Stella Cloud;
2. reach a login boundary through real agent browser use;
3. complete handoff without model-visible credentials;
4. verify agent control is locked during takeover;
5. finish the task or approval;
6. export and encrypt browser state;
7. terminate the Browser Run session completely;
8. wait long enough to prove a new session rather than an in-memory lease;
9. restore into a fresh context;
10. verify website authentication or record the site's reauthentication behavior;
11. revoke or reset and prove the session can no longer be restored;
12. inspect model context, journal, Convex, logs, traces, notifications, screenshots, and recordings for secret absence;
13. capture IDs, timestamps, profile epoch/revision, object hash, restore result, and bot-blocking result.

Minimum release bar:

- successful handoff and later-session restoration on representative SSO and ordinary sites;
- explicit and safe failure on bot-blocked targets;
- zero cross-owner or secret-leak findings;
- durable resume after DO/Worker restart;
- remote deletion proven from Browser Run/R2 through Convex metadata;
- realistic concurrency, latency, and cost measurement.

## Cloudflare configuration checklist

Expected worker resources:

- Browser binding named BROWSER;
- BrowserProfileSession Durable Object binding and migration;
- private R2 bucket or prefix for encrypted snapshots;
- service binding from executor/control plane to Browser Gateway;
- application encryption keys with version metadata;
- optional Workflow for device-code and reconciliation;
- nodejs_compat if required by the current Cloudflare Playwright package.

At the time this plan was written, official documentation showed:

- @cloudflare/playwright 1.3.0 based on Playwright 1.58.2;
- a default Browser Run inactivity timeout around 60 seconds and a configurable maximum around 10 minutes;
- Live View expiry configurable up to one hour and human handoff timeout up to roughly thirty minutes;
- paid-plan operational concurrency around 200 with new-instance rate limiting;
- recording as opt-in beta with its own duration/retention constraints;
- Browser Run traffic explicitly identified as bot traffic.

Treat every number above as a dated planning input. Reverify it before coding or cost commitments.

## Open decisions to resolve during Slice 0

- Whether one Stella user has one default profile or multiple named profiles in v1. The schema supports multiple; the UI may initially expose one.
- Whether to use a Workflow for all waits or DO alarms plus Workflows only for provider polling. Prefer the smallest durable mechanism that survives eviction.
- Which consequential actions can ever be remembered versus always ask.
- The first non-Cloudflare provider or local-browser fallback for bot-blocked sites.
- Whether a native secure credential form is needed in v1 or direct Live View is sufficient. Direct Live View is the baseline.
- Exact retention/tombstone period for revoked profile metadata and purge evidence.

These decisions cannot weaken the non-negotiable security rules.

## Source map captured before integration

The complete standalone cloud product at /Users/rahulnanda/projects/stella-cloud, commit 1089d6e0, was used only to map seams. Its current hosted cloud product had no Browser Run, Live View, takeover, or reusable-profile implementation.

Relevant historical seams:

- packages/desktop-ui/src/features/cloud/CloudChatTail.tsx
- packages/desktop-ui/src/features/cloud/cloud-api.ts
- packages/desktop-ui/src/features/cloud/cloud-composer-store.ts
- packages/desktop-ui/src/features/cloud/conversation-protocol.ts
- packages/desktop-ui/src/features/cloud/conversation-socket.ts
- packages/desktop-ui/src/features/cloud/use-cloud-activity.ts
- packages/desktop-ui/src/features/chat/ChatColumn.tsx
- packages/desktop-ui/src/features/chat/ChatSidebar.tsx
- packages/desktop-ui/src/features/workspace-display/types.ts
- packages/desktop-ui/src/features/workspace-display/tab-store.ts
- packages/desktop-ui/src/app/settings/tabs/account/AccountTab.tsx
- packages/shell-mobile/App.tsx
- packages/shell-mobile/src/native-bridge.ts
- convex/schema/cloud_apps.ts
- convex/cloud_apps.ts
- convex/cloud_purge.ts
- convex/auth.ts
- convex/auth_migration.ts
- workers/cloud-builder/src/orchestrator-session.ts
- workers/cloud-builder/src/journal.ts
- packages/executor-cloud/src/agent-turn.ts

After the final Effect + cloud integration, re-resolve every path against the reconciled monorepo. Do not import the old UI wholesale.

## Primary references

- Cloudflare Browser Run overview: https://developers.cloudflare.com/browser-run/
- Cloudflare Playwright: https://developers.cloudflare.com/browser-run/playwright/
- Reuse sessions: https://developers.cloudflare.com/browser-run/features/reuse-sessions/
- Human in the Loop: https://developers.cloudflare.com/browser-run/features/human-in-the-loop/
- Live View: https://developers.cloudflare.com/browser-run/features/live-view/
- Browser Run with Durable Objects: https://developers.cloudflare.com/browser-run/how-to/browser-run-with-do/
- Browser close reasons: https://developers.cloudflare.com/browser-run/reference/browser-close-reasons/
- Limits: https://developers.cloudflare.com/browser-run/limits/
- Pricing: https://developers.cloudflare.com/browser-run/pricing/
- Session recording: https://developers.cloudflare.com/browser-run/features/session-recording/
- Workflow events: https://developers.cloudflare.com/workflows/build/events-and-parameters/
- Workflow sleep and retry: https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/
- Workflow limits: https://developers.cloudflare.com/workflows/reference/limits/
- ChatGPT Work browser behavior: https://learn.chatgpt.com/docs/browser
- ChatGPT Work cloud security: https://learn.chatgpt.com/docs/enterprise/chatgpt-work-cloud-security

## Definition of done

This phase is complete only when:

- cloud and local agents use the provider-neutral browser contract at the correct placement;
- a real hosted browser can complete ordinary automation;
- login, MFA/SSO/CAPTCHA, device code, and consequential approval all suspend and resume durably;
- website session state survives complete browser termination and later restoration;
- model and telemetry secret absence is proven;
- exact-origin permissions, revocation, reset, account deletion, and remote purge are proven;
- desktop, hosted web, and isolated mobile takeover UX work;
- failure is explicit for expired sessions and bot-blocked targets;
- Effect-supervised interruption, cancellation, child completion, and shutdown remain correct;
- automated suites and the representative real-site matrix pass with retained evidence;
- no production deployment, push, release, tag, or installed-app update occurs without separate authorization.
