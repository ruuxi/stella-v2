# Apps

Apps is Stella's library for cloud-backed user apps. The surface can be loading, empty, populated, or unavailable.

## Sub-features

- `apps-open` enters the library from New tab.
- `apps-library` opens populated app cards in the sidebar.
- `apps-empty` hands a create-app request into chat.
- `apps-cloud` opens a cloud app in its retained sidebar frame.

## How to get to it (user POV)

- Choose **New tab**, then **Apps**.
- Choose an app card to open it.
- On an empty library, choose the create-app action.

## Driving it with control-stella

Preconditions:

- The verifier is healthy and signed in. The library loads cloud apps for the signed-in account.
- A populated test needs an existing cloud app. Do not create one merely to make the state non-empty unless that mutation is in scope.

- **Open.** Run `node .agents/skills/verify-stella/control-stella.mjs apps open`.
- **Observe.** Run `node .agents/skills/verify-stella/control-stella.mjs apps state`. Read the returned surface text and inspect the visible content to assess loading, empty, populated, or error behavior. The helper does not infer readiness from absent error text.
- **Empty handoff.** Only in an empty state, run `node .agents/skills/verify-stella/control-stella.mjs apps ask`. Require a create-app draft in the real composer. Do not send it unless generation is in scope.
- **Populated library.** Inspect a named card in the sidebar, open it, and capture the selected app tab.

## Gotchas

- `No apps yet` is the empty state, not the entire feature.
- A signed-out or cloud-disabled session shows no library at all.
