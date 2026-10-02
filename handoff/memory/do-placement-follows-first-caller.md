---
name: do-placement-follows-first-caller
description: Never create a per-user Durable Object from Convex (or any server-side push); placement follows the first caller and pins every later hop far from the user
metadata:
  type: project
---

Measured 2026-09-02 on dev: a Convex `onCreate` push that created the per-owner
`OwnerGate` object placed it near Convex's servers. Every later RPC from the
user's conversation object to the gate then cost 70–125 ms instead of ~15 ms,
and warm message begin went from 356 ms to ~470 ms. Removed the push; the
desktop's conversation-socket connect already creates and warms the gate from
the user's edge.

**Why:** Cloudflare places a new Durable Object near whoever makes its first
request. Server-originated creation (Convex actions, crons, pushes) puts
user-facing objects in the wrong region for the life of the object.

**How to apply:** Per-user/per-conversation objects must be first touched by a
request coming from the user's edge (worker on the client's request path, or
another object already placed there). Pushes from Convex may only target
objects that already exist; never use them as pre-warming. See
[[greenfield-two-plane-architecture]] and [[recall-search-in-conversation-do]].
