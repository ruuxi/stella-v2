# Apps

Apps is Stella's library for locally generated and cloud-backed user apps. The surface can be loading, empty, populated, unavailable, or in a runtime start/stop/error state.

## Sub-features

- `apps-open` enters the library from New tab or its route.
- `apps-library` searches, sorts, and opens populated app cards.
- `apps-empty` hands a create-app request into chat.
- `apps-runtime` starts, stops, retries, or reports a local app runtime.
- `apps-cloud` represents cloud app availability separately from local files.

## How to get to it (user POV)

- Choose **New tab**, then **Apps**.
- Open `/apps` as a secondary route.
- Search or sort the populated library, then choose an app card.
- On an empty library, choose the create-app action.

## Driving it with control-stella

Preconditions:

- The verifier is healthy. Local app discovery requires the Electron user-app bridge.
- A populated-runtime test needs a seeded app. Do not create one merely to make the state non-empty unless that mutation is in scope.

- **Open.** Run `node .agents/skills/verify-stella/control-stella.mjs apps open`.
- **Observe.** Run `node .agents/skills/verify-stella/control-stella.mjs apps state`. Read the returned surface text and inspect the visible content to assess loading, empty, populated, unsupported, or error behavior. The helper does not infer readiness from absent error text.
- **Empty handoff.** Only in an empty state, run `node .agents/skills/verify-stella/control-stella.mjs apps ask`. Require a create-app draft in the real composer. Do not send it unless generation is in scope.
- **Populated library.** Use `inspect components`, `drive fill`, and `drive click` to prove search, sort, and a named card. Capture the selected app tab.
- **Runtime.** For a seeded local app, start it through the visible control, wait with `drive settle`, inspect status, then stop or retry through the user control.

## Gotchas

- `No apps yet` and `Nothing here yet` are empty states, not the entire feature.
- An unsupported state means the Electron bridge is missing or the platform cannot host local apps.
- Starting a generated app may spawn a long-lived process. Record it and clean it up through the app's own stop control.
- Local and cloud app cards can expose different actions and availability.
