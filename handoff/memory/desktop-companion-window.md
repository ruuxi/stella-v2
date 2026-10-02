---
name: desktop-companion-window
description: "2026-09-03 floating \"Desktop companion\" window design (resize-based pass-through, full shell as brain, toggle dictation) and local Hyprland/XWayland verification quirks"
metadata: 
  node_type: memory
  type: project
  originSessionId: 34e509a5-a34b-4718-b1d1-aa5273cf810a
  modified: 2026-09-04T05:18:46.772Z
---

Built 2026-09-03: the floating Stella "Desktop companion" (companion.html entry,
`electron/windows/companion-window.ts`, `shell/companion/`). Design decisions:
- Pass-through is done by **resizing the window** between a 128px compact box
  (mark only) and a 400×560 full box, keeping the compact box's screen-border
  edges fixed so the mark never moves; no `setIgnoreMouseEvents` (its `forward`
  option is unsupported on Linux and cursor polling is unreliable on XWayland).
- The full shell renderer is the brain: it publishes `CompanionState` over IPC
  and executes relayed sends; the companion window has no chat runtime.
- Dictation is toggle-based everywhere (push-to-talk and OS-wide paste removed);
  outside the full shell the shortcut summons the companion and sends on stop.

**Why:** user asked for a lightweight always-on-top pet with composer, arc of
buttons on hover (no hover gaps), iMessage bubbles, drag, and agent-count badge.

**How to apply:** keep new companion features inside this split (main owns
geometry/visibility, full shell owns chat). Local verification: the user's
Hyprland runs scale 1.6 with `xwayland:force_zero_scaling`, so Electron sees
scale 1 (DIP == physical px) and `hyprctl clients` sizes are DIP/1.6; harness
windows land on workspace 1 while the user works elsewhere, so drive the
companion via its own CDP page target (see verify-stella features/companion.md)
rather than desktop screenshots. The user's ~/.config/hypr/hyprland.lua has a
catch-all `o.window({ class = ".*" }, { float, center, size 80%, persistent_size })`
rule; on 2026-09-03 I appended an `o.window({ title = "^Stella Overlay$" }, …)` rule
(no_anim, no_blur, border_size 0, rounding 0, opacity 1) so the companion/overlay
windows are exempt. Related: [[cloud-lifecycle-rows-pending]].
