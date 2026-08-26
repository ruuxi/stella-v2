---
name: stella-computer
description: Control macOS desktop apps through Stella's persistent Computer Use runtime.
---

# Stella Computer for macOS

Use `node_repl` for desktop-app work. The persistent JavaScript runtime is already initialized and exposes a frozen `sky` client. Bindings and delivered app instructions persist for this agent session.

## Observe

Start each desktop-app turn with fresh state for the named app:

```js
var state = await sky.get_app_state({
  app: "Spotify",
  screenshot_policy: "auto",
});
nodeRepl.write(state.text);
if (state.screenshot) await nodeRepl.emitImage(state.screenshot.url);
```

Every state includes an opaque semantic `state_id`, an immutable compound `observation_id`, `is_diff`, and, for a diff, `base_state_id`. A captured screenshot also has an independent `visual_state_id`; screenshot capture settings do not change `state_id`, while a different visual or resource generation changes `observation_id`. Treat a diff as valid only when its `base_state_id` matches the full state you are building on. Pass `disable_diff: true` whenever the base is unavailable or mismatched.

Use the app name directly. Call `await sky.list_apps()` only when the requested app cannot be resolved.
Call `await sky.list_windows()` when window titles or native window IDs are needed to disambiguate several top-level windows.

The default state is an accessibility-tree diff when that is sufficient. A screenshot is returned only when visual context is needed. Prefer the accessibility text and numbered `element_index` values; inspect the screenshot when the tree is sparse or the visible control is absent.

Pass `disable_diff: true` only when you need a complete recovery tree.

## Act

Actions return a receipt after dispatch without rebuilding state or capturing a screenshot. Every action requires the `state_id` from the fresh state it was derived from, including element clicks, secondary actions, scrolling, selection, value/focus actions, coordinates, drags, and keyboard input. Missing or stale provenance is rejected before native dispatch instead of targeting changed UI:

```js
await sky.click({
  app: "Spotify",
  element_index: 42,
  state_id: state.state_id,
});
await sky.set_value({
  app: "Spotify",
  element_index: 18,
  value: "Daft Punk",
  state_id: state.state_id,
});
await sky.perform_secondary_action({
  app: "Spotify",
  element_index: 9,
  action: "Show Menu",
  state_id: state.state_id,
});
await sky.scroll({
  app: "Spotify",
  element_index: 55,
  direction: "down",
  pages: 1,
  state_id: state.state_id,
});
await sky.drag({
  app: "Spotify",
  from_x: 420,
  from_y: 310,
  to_x: 720,
  to_y: 310,
  state_id: state.state_id,
  observation_id: state.observation_id,
});
await sky.press_key({
  app: "Spotify",
  key: "Return",
  state_id: state.state_id,
});
await sky.type_text({
  app: "Spotify",
  text: "hello",
  state_id: state.state_id,
});
```

`drag` also accepts `path: [{ x, y }, ...]` with at least two points. Drag
coordinates must come from the latest screenshot; observe again after the drag.

Perform one or more actions in one `node_repl` call only when no intermediate result is needed. Then fetch settled state once:

```js
await sky.click({
  app: "Spotify",
  element_index: 18,
  state_id: state.state_id,
});
var nextState = await sky.wait_for_change({
  app: "Spotify",
  after_state_id: state.state_id,
  ...(state.visual_state_id
    ? { after_visual_state_id: state.visual_state_id }
    : {}),
  timeout_ms: 10000,
  screenshot_policy: "auto",
});
nodeRepl.write(nextState.text);
if (nextState.screenshot) await nodeRepl.emitImage(nextState.screenshot.url);
```

For a data-driven sequence, `sky.batch([...])` first validates every action against its supplied observation, then executes the actions in order. A stale action rejects the entire batch before any action is dispatched. Give every item the `state_id` from the same fresh starting state when they target the same app. Do not batch across a decision point, permission prompt, navigation-policy boundary, or any step whose result determines the next action.

Use `wait_for_change` when the next step depends on a mutation becoming observable. It polls without advancing the saved diff baseline and returns a final diff anchored exactly to `after_state_id`. Pass `after_visual_state_id` when screenshot-only changes matter; omit it to wait only for semantic accessibility changes. Use `get_app_state` directly when no prior state is available or a change is not required. Always re-derive element indices from the latest state.

## Text Selection

Use semantic selection instead of repeated arrow-key commands:

```js
await sky.select_text({
  app: "TextEdit",
  element_index: 7,
  text: "matching text",
  prefix: "optional text before",
  suffix: "optional text after",
  selection_type: "text",
  state_id: state.state_id,
});
```

`selection_type` may be `text`, `cursor-before`, or `cursor-after`. Prefix and suffix disambiguate repeated matches.

## Coordinates And Input

Use accessibility elements whenever possible. For a visible control missing from the tree, use screenshot pixel coordinates from the latest attached screenshot:

```js
await sky.click({
  app: "Spotify",
  x: 620,
  y: 412,
  state_id: state.state_id,
  observation_id: state.observation_id,
});
```

Coordinates are screenshot pixels, not macOS screen points. They require a state captured with `screenshot_policy: "always"`, its semantic `state_id`, and its immutable `observation_id`. Never reuse coordinates with a later observation, even when its semantic `state_id` is unchanged. Coordinate and keyboard actions may affect the active input path. Use them only when the semantic accessibility route is unavailable, and verify with one final state read.

Spotify and other Chromium/Electron apps can expose sparse state briefly. Do not add sleeps; `get_app_state` performs adaptive settling and waits longer only while the app continues changing.

Do not use AppleScript, `osascript`, `open -a`, app-bundle internals, or shell commands to drive desktop apps. Use `exec_command` only to diagnose the Computer Use runtime itself.
