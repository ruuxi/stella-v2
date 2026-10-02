---
name: stella-model-defaults-backend-owned
description: "2026-09-10 decision — Stella-provider default model AND reasoning effort are backend-owned; users may pick a Stella model but never its effort; no \"Default\" effort option"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3be9a075-76a0-4130-b72c-b76513688427
  modified: 2026-09-11T02:34:29.080Z
---

Decision on 2026-09-10 for the Stella (managed) provider:

- Default model and reasoning effort live only in `packages/model-catalog/model.ts` on the backend. Changing either must apply to all users with a Convex + gateway deploy, no app release.
- Users may pick a different Stella model (picker already has a "Default" row that reverts to `stella/default`). Users may NOT set reasoning effort for Stella models: hide/disable the control, and the gateway drops any client-sent effort on Stella routes and applies the backend config's effort.
- User explicitly rejected adding a "Default" option to the effort control.
- BYOK/local models and the Codex / Claude Code engines keep their own effort settings.
- Client-side mirrors to delete: hardcoded default-effort computations in `AgentModelPicker.tsx` / `MiniModelPicker.jsx` and `run-shared.ts` (`resolveAgentThinkingLevel` model-name branches), display-name table and preset fallback row in `desktop-ui .../lib/model-catalog.ts`, restricted-audience id list in `desktop-ui/src/global/billing/audience.ts`.
- Implemented 2026-09-10 (uncommitted at the time): gateway strips client effort and applies config effort; runtime sends none on Stella routes; catalog rows carry `api`; effort controls hidden for Stella on desktop and mobile. Remaining server-side hardcode: `REGISTRY_INDEPENDENT_*` upstream ids in `packages/executor-cloud/src/relay-model.ts`.

**Why:** 99% of users never touch the picker; the operator wants to swap models/effort over time without shipping client updates.
**How to apply:** never add client-side model-name hardcodes for Stella models; route new model metadata through `/api/stella/models`. See [[no-users-greenfield-ok]], [[keep-plans-minimal]].
