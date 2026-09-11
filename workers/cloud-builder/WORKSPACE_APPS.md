# Workspace apps

Cloud agents discover `create-stella-cloud-app` as a built-in skill. They publish
using ordinary file tools: write an immutable revision under
`/workspace/world/apps/<slug>/revisions/<revision>/`, then update
`stella.app.json` with its name, slug, and revision. No dedicated app tool or
manual deployment command is required.

WorldStore reconciles manifests after shared file-tool writes, sandbox world
pushes, workspace merges, and app-list requests. It bundles source using
Cloudflare worker-bundler. Static assets are served directly; an optional
`App extends DurableObject` server runs in an isolated Dynamic Worker facet.
Each owner's app has durable state that survives new source revisions. Failed
updates leave the last successful revision available. Agents can read
`build-status.json` for the attempted build's result.

Apps are private. The authenticated list/session routes verify the account's
current lifecycle generation. The session grants one hour of access to one
owner's app. The separate apps-host origin forwards only app requests and
strips account credentials. App code receives no host bindings or outbound
network access. Browser responses enforce an opaque-origin CSP sandbox; apps
cannot set cookies or relax that policy. Store persistent data in the app's
Durable Object, not browser localStorage.

The desktop and browser Apps sidebar discovers these apps through the same
owner-scoped API. Desktop keeps local app processes alongside cloud app frames.
Mobile's Apps screen uses the same API and an isolated WebView.

The previous sandbox app-build executor, baked app template, apps SDK, registry
publication/storage/operation endpoints, and trusted app-host bridge are retired.
Legacy schema and purge/retirement code remain only to clean up existing data;
deployed Durable Object class identities are retained to avoid deleting data
implicitly during a rollout. No active route creates legacy builds or registry
entries. The historical canonical verifier's old app-host step explicitly
reports retirement instead of claiming acceptance for the replacement.

## Verification

- `workers/cloud-builder/tests/workspace-apps-workerd.test.ts`: real Workerd
  publication, owner isolation, state persistence, successful updates, and
  preservation of the last good revision after a failed update.
- `workspace-app-access.test.ts` and the apps-host proxy test: signed access,
  credential stripping, enforced browser isolation, and account reset fencing.
- Desktop discovery/navigation tests cover colliding local and cloud names.

Development acceptance created Daily Counter through a real cloud agent and
verified its sidebar interaction on Electron and the browser website build,
including shared persisted count. A local app was also opened alongside it.
The iOS bundle exports successfully. With local Simulator verification
authorized, the same app appeared in mobile Apps, loaded the shared count, and
saved an increment through its native WebView, and retained it after reopening.

A follow-up cloud-agent edit published revision 2, replacing blocked native
browser confirmation with an in-page Reset confirmation. The web flow was
verified through Cancel and Confirm reset; mobile displayed the confirmation
and reopened with the saved value. The skill now requires in-page dialogs.

Only development Workers and Convex were deployed for this acceptance. No
production release or container-image rollout was performed.
