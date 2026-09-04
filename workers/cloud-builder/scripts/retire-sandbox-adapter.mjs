#!/usr/bin/env node
// The adapter `retire-sandbox-instances.mjs --apply --adapter <this file>`
// invokes once per exact instance. It receives one JSON argument naming the
// instance's exact tuple and posts it to the deployed Worker's operator route.
// Wrangler cannot stop one container instance and only the sandbox
// Durable Object holds the container handle, so this is the only stop path.
//
// Environment:
//   CLOUD_BUILDER_URL        the Worker origin for the deployment being reaped
//   BUILDER_SERVICE_SECRET   the Worker's service bearer (never printed)
//
// Exits non-zero when the Worker does not confirm the retirement, so the
// calling script stops before the next instance rather than reporting a
// mutation it did not achieve.

const [rawArgument] = process.argv.slice(2);
if (!rawArgument) {
  console.error("retire-sandbox-adapter: one JSON argument is required.");
  process.exit(2);
}

let selected;
try {
  selected = JSON.parse(rawArgument);
} catch {
  console.error("retire-sandbox-adapter: the argument is not JSON.");
  process.exit(2);
}
if (
  !selected ||
  typeof selected !== "object" ||
  selected.schemaVersion !== 1 ||
  typeof selected.sandboxId !== "string" ||
  typeof selected.size !== "string" ||
  typeof selected.workload !== "string"
) {
  console.error("retire-sandbox-adapter: the argument is not a retire plan.");
  process.exit(2);
}

// A durable export can supply the exact workload when an old platform record
// lacks the SDK-visible sandbox id. An empty candidate list remains unresolved.
const EXACT_WORKLOADS = new Set(["app-build", "world"]);
const resolveWorkload = (plan) => {
  if (EXACT_WORKLOADS.has(plan.workload)) return plan.workload;
  const candidates = Array.isArray(plan.workloadCandidates)
    ? plan.workloadCandidates.filter((entry) => EXACT_WORKLOADS.has(entry))
    : [];
  if (candidates.length !== 1) {
    return null;
  }
  return candidates[0];
};
const workload = resolveWorkload(selected);
if (workload === null) {
  console.error(
    `retire-sandbox-adapter: cannot resolve workload ${JSON.stringify(selected.workload)} to an exact target.`,
  );
  process.exit(2);
}

const builderUrl = process.env.CLOUD_BUILDER_URL;
const serviceSecret = process.env.BUILDER_SERVICE_SECRET;
if (!builderUrl || !serviceSecret) {
  console.error(
    "retire-sandbox-adapter: CLOUD_BUILDER_URL and BUILDER_SERVICE_SECRET are required.",
  );
  process.exit(2);
}

const response = await fetch(
  new URL("/internal/sandboxes/retire", builderUrl),
  {
    method: "POST",
    headers: {
      authorization: `Bearer ${serviceSecret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      sandboxId: selected.sandboxId,
      size: selected.size,
      workload,
    }),
  },
);
const text = await response.text();
let result = null;
try {
  result = JSON.parse(text);
} catch {
  result = null;
}
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    environment: selected.environment,
    instanceId: selected.instanceId,
    sandboxId: selected.sandboxId,
    size: selected.size,
    workload,
    classification: selected.workload,
    status: response.status,
    result,
  })}\n`,
);
if (!response.ok || result?.ok !== true) {
  process.exit(1);
}
