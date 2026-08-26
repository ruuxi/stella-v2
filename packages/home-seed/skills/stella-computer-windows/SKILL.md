---
name: stella-computer
description: Control Windows desktop apps through Stella's persistent Computer Use runtime.
---

# Stella Computer for Windows

Use `node_repl` for desktop-app work. The persistent JavaScript runtime is already initialized and exposes a frozen `sky` client. Bindings and delivered app instructions persist for this agent session.

## Observe

Start each desktop-app turn with fresh state:

```js
var state = await sky.get_app_state({
  app: "Spotify",
  screenshot_policy: "auto",
});
nodeRepl.write(state.text);
if (state.screenshot) await nodeRepl.emitImage(state.screenshot.url);
```

Every state includes an opaque semantic `state_id`, an immutable compound `observation_id`, `is_diff`, and, for a diff, `base_state_id`. A captured screenshot also has an independent `visual_state_id`; screenshot capture settings do not change `state_id`, while a different visual or resource generation changes `observation_id`. Treat a diff as valid only when its `base_state_id` matches the full state you are building on. Pass `disable_diff: true` whenever the base is unavailable or mismatched.

Use `await sky.list_apps()` only when an app name cannot be resolved. Use `await sky.list_windows()` when the app has multiple top-level windows, then pass `window_id` instead of `app` to state and action calls.

The default state is a UI Automation diff when sufficient. A screenshot is returned only when visual context is needed. Prefer numbered `element_index` values over coordinates.

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
  action: "Invoke",
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

After any action attempt, observe again before sending another standalone action; a failed or interrupted dispatch may still have changed the app, so its prior observation is invalidated. When several ordered actions need the same starting observation and no intermediate result is needed, send them together with `sky.batch([...])`. When the next step depends on a mutation becoming observable, call:

```js
var nextState = await sky.wait_for_change({
  app: "Spotify",
  after_state_id: state.state_id,
  ...(state.visual_state_id
    ? { after_visual_state_id: state.visual_state_id }
    : {}),
  timeout_ms: 10000,
  screenshot_policy: "auto",
});
```

It polls without advancing the saved diff baseline and returns a final diff anchored exactly to `after_state_id`. Pass `after_visual_state_id` when screenshot-only changes matter; omit it to wait only for semantic UI Automation changes. Then re-derive fresh indices. `sky.batch([...])` validates every action at the native dispatch boundary, then executes ordered actions. A stale action rejects the entire batch before command 0 is dispatched. Give every item the `state_id` from the same fresh starting state when they target the same app; do not batch across decision points, permission prompts, or navigation-policy boundaries. After any failed or partially completed batch, discard its starting state and observe again.

## Text Selection

Use semantic selection when the target exposes a UI Automation text range:

```js
await sky.select_text({
  app: "Notepad",
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

For a visible control missing from the tree, use screenshot pixel coordinates from the latest attached screenshot:

```js
await sky.click({
  window_id: 123456,
  x: 620,
  y: 412,
  state_id: state.state_id,
  observation_id: state.observation_id,
});
```

Coordinates are screenshot pixels and require a state captured with `screenshot_policy: "always"`, its semantic `state_id`, and its immutable `observation_id`. Never reuse coordinates with a later observation, even when its semantic `state_id` is unchanged. Windows background input varies by framework. Prefer UI Automation elements first. Coordinate and keyboard delivery may briefly require foreground dispatch; verify the result with one final settled state.

Do not add sleeps. `get_app_state` performs adaptive settling and extends its wait only while UI Automation events indicate continued changes.

Do not use PowerShell, registry edits, app-bundle paths, or app-specific scripting to drive desktop apps. Use `exec_command` only to diagnose the Computer Use runtime itself.
