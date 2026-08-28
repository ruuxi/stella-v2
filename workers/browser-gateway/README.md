# Stella Browser Gateway

This package is Stella Cloud's private Browser Run boundary. It is reachable
through a Cloudflare service binding even though `workers_dev` and preview URLs
are disabled. It is not an authenticated public HTTP API.

Only this Worker owns the Browser binding, the browser-profile R2 bucket, and
the `BROWSER_PROFILE_KEK_V1` secret. The secret is a base64url-encoded 32-byte
AES key and must be installed with Wrangler for each deployment; it is
deliberately not represented as a `vars` entry in `wrangler.jsonc`.

## Private routes

`POST /internal/turn/command` accepts the exact Builder envelope:

```json
{
  "schemaVersion": 1,
  "authority": {
    "ownerId": "...",
    "ownerGeneration": "...",
    "conversationId": "...",
    "threadId": "...",
    "turnId": "...",
    "attemptGeneration": 1
  },
  "command": {
    "schemaVersion": 1,
    "requestId": "uuid",
    "action": "browser.observe",
    "params": {}
  }
}
```

The gateway owns the sole profile ID (`default`) and its epoch. Turn commands
cannot choose either value. The action allowlist is:

- `browser.open`: `{allowedOrigins, startUrl?}`
- `browser.navigate`: `{url}`
- `browser.observe`: `{}`
- `browser.click`: `{selector}`
- `browser.fill`: `{selector, value, sensitivity:"non_secret"}`
- `browser.press`: `{selector, key}`
- `browser.select`: `{selector, value}`
- `browser.wait`: `{selector, timeoutMs?}`
- `browser.tabs`: `{}`
- `browser.focus_tab`: `{tabId}`
- `browser.checkpoint`: `{}`
- `browser.login_takeover`:
  `{allowedOrigins, displayOrigin, startUrl?, displayTitle?, expiresInMs?, verification:{resumeUrl, expectedOrigin, authenticatedSelector, loggedOutSelector}}`
- `browser.close`: `{}`
- `device_code.fixture_start`: `{expiresInMs?:300000}`

There is no evaluate, arbitrary CDP, cookie, storage, request-interception, or
file-system command. `browser.fill` rejects credential-shaped controls and is
disabled while the profile is under human control.

The `toolCallId` field required by the shared suspension/receipt wire shape is
filled with the neutral command request ID. It is never treated as the outer
tool-call authority, and neither takeover command accepts a caller-supplied
tool-call ID. Convex validates interaction ID plus request digest and constructs
the resume receipt with its own authoritative outer tool-call ID.

Authenticated control-plane callers use:

- `POST /internal/interactions/status`
- `POST /internal/interactions/live-view`
- `POST /internal/interactions/decision`

Their common body is
`{schemaVersion, authority, profileId:"default", profileEpoch, interactionId, interactionRevision}`;
decision adds `decision:"done"|"cancel"`. Live View URLs are minted only by the
Live View route, returned with `no-store`, and never persisted or logged.

Reset is `POST /internal/owners/profile/reset` with
`{schemaVersion:1, authority:{ownerId,ownerGeneration}, requestId, profileId:"default"}`.
The gateway atomically increments its epoch and returns the new value. Permanent
owner deletion is generation-independent:
`POST /internal/owners/purge` accepts exactly
`{schemaVersion:1, ownerId, requestId}` and removes every stored epoch for the
owner's fixed profile.

## Device-code fixture

The controlled protocol fixture suspends independently of Browser Run. Status
returns only `verificationUri`, `verificationUriComplete`, and `userCode` in
addition to the ordinary interaction summary. The bn118 gateway calls the
separate fixture Worker's named `DeviceCodeFixtureService` RPC entrypoint;
authorize, status, and consume are not HTTP routes. The 256-bit `deviceCode`
travels only over that private service binding and is AES-GCM encrypted in the
Gateway interaction record with owner/profile/epoch authenticated data. It is
removed when the interaction reaches any terminal state.

A user `done` decision first requires provider status `approved`, then consumes
the grant for the exact Gateway interaction ID. An exact retry recovers the
same approval if the first service-binding response was lost; a different
consumer fails closed. Pending stays pending, denial becomes canceled, expiry
becomes expired, and an invalid grant fails closed. Device-code waits hold the
durable profile interaction lock and an expiry alarm removes abandoned
ciphertext. No device, access, refresh, or polling token is returned to Builder,
Convex, the model transcript, the client, logs, or evidence.

## Profile persistence

`BrowserProfileSession` is a SQLite Durable Object named with a SHA-256 digest
of owner plus profile. Browser storage state is captured with
`storageState({indexedDB:true})`, encrypted with a random AES-GCM data key, and
stored as an immutable R2 envelope. The data key is wrapped with
`BROWSER_PROFILE_KEK_V1`; owner/profile/epoch/revision are authenticated data.
R2 keys and metadata contain digests and revisions only.

Login completion requires trusted verification before checkpointing, closes
the credential-bearing Browser Run session, launches a fresh session from the
encrypted snapshot, navigates to the bounded resume URL, and verifies again
before returning an approved resume receipt. Reset and purge terminate the
session and delete all encrypted bytes.
