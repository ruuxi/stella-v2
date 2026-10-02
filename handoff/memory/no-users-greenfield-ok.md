---
name: no-users-greenfield-ok
description: "As of 2026-09-01 Stella has no users on dev or prod, so backwards compatibility, data migrations, and legacy shims are not needed"
metadata: 
  node_type: memory
  type: project
  originSessionId: 42a62454-6f62-4f8d-a4cc-92c1d948e663
  modified: 2026-09-01T19:30:25.087Z
---

As of 2026-09-01 there are no users on the dev or prod deployments. Architectural changes can be greenfield: delete replaced code and tables outright, no migration paths, no compatibility flags, no dual-running old and new paths.

**Why:** the user said so explicitly when authorizing the two-plane re-architecture ([[greenfield-two-plane-architecture]]).
**How to apply:** when replacing a subsystem, remove the old one in the same change instead of strangling it; do not spend effort on migrations or feature flags for old clients.
