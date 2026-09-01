# Connector program documentation

- [First-party connector handoff](composio-native-connectors-handoff-2026-08-31.html) — architecture, implementation lineage, production state, provider blockers, and rollout plan for the first 59 connector targets.
- [Machine-readable connector matrix](composio-native-connectors-handoff-2026-08-31.json) — the same authoritative 59-connector inventory and readiness metadata as JSON.
- [Connector execution core](../README.md) — implementation modules, security invariants, environment variable names, and provider integration notes.

The handoff distinguishes implementation readiness from provider configuration, account connection, representative-call verification, and production routing. Composio remains available until each connector independently passes those gates.
