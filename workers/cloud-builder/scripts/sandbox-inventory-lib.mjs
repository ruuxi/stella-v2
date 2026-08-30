import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const INVENTORY_SCHEMA_VERSION = 1;
export const DEFAULT_STALE_HOURS = 24;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_ROOT = path.resolve(SCRIPT_DIR, "..");
export const DEFAULT_CONFIG_PATH = path.join(WORKER_ROOT, "wrangler.jsonc");
export const DEFAULT_WRANGLER_PATH = path.join(
  WORKER_ROOT,
  "node_modules",
  ".bin",
  "wrangler",
);

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const requireString = (value, label) => {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
};

const requireInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
  return value;
};

/**
 * Strip JSONC comments without touching comment-like text inside strings, then
 * remove trailing commas. This keeps the operational script dependency-free.
 */
export const parseJsonc = (source) => {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (current === "\n" || current === "\r") {
        lineComment = false;
        output += current;
      } else {
        output += " ";
      }
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        output += "  ";
        index += 1;
      } else {
        output += current === "\n" || current === "\r" ? current : " ";
      }
      continue;
    }
    if (inString) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      output += current;
      continue;
    }
    if (current === "/" && next === "/") {
      lineComment = true;
      output += "  ";
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      blockComment = true;
      output += "  ";
      index += 1;
      continue;
    }
    output += current;
  }

  if (inString || blockComment) {
    throw new SyntaxError("Unterminated JSONC string or block comment.");
  }
  let withoutTrailingCommas = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < output.length; index += 1) {
    const current = output[index];
    if (inString) {
      withoutTrailingCommas += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === '"') inString = false;
      continue;
    }
    if (current === '"') {
      inString = true;
      withoutTrailingCommas += current;
      continue;
    }
    if (current === ",") {
      let lookahead = index + 1;
      while (/\s/.test(output[lookahead] ?? "")) lookahead += 1;
      if (output[lookahead] === "}" || output[lookahead] === "]") continue;
    }
    withoutTrailingCommas += current;
  }
  return JSON.parse(withoutTrailingCommas);
};

const classSize = (className) =>
  className === "SandboxSmall" ? "small" : "large";

const applicationNameFor = ({ workerName, className, environment }) =>
  `${workerName}-${className.toLowerCase()}${
    environment === "dev" ? "" : `-${environment}`
  }`;

export const configuredContainerApplications = (config) => {
  if (!isRecord(config))
    throw new TypeError("Wrangler config must be an object.");
  const environments = [
    {
      environment: "dev",
      workerName: requireString(config.name, "Wrangler name"),
      containers: config.containers,
    },
    {
      environment: "bn118",
      workerName: requireString(config.env?.bn118?.name, "Wrangler bn118 name"),
      containers: config.env?.bn118?.containers,
    },
  ];

  return environments.flatMap(({ environment, workerName, containers }) => {
    if (!Array.isArray(containers)) {
      throw new TypeError(
        `Wrangler ${environment} containers must be an array.`,
      );
    }
    return containers.map((entry, index) => {
      if (!isRecord(entry)) {
        throw new TypeError(
          `Wrangler ${environment} container ${index} must be an object.`,
        );
      }
      const className = requireString(
        entry.class_name,
        `Wrangler ${environment} container ${index} class_name`,
      );
      return {
        environment,
        workerName,
        applicationName: applicationNameFor({
          workerName,
          className,
          environment,
        }),
        className,
        size: classSize(className),
        instanceType: requireString(
          entry.instance_type,
          `Wrangler ${environment} ${className} instance_type`,
        ),
        maxInstances: requireInteger(
          entry.max_instances,
          `Wrangler ${environment} ${className} max_instances`,
        ),
      };
    });
  });
};

export const parseWranglerApplications = (value) => {
  if (!Array.isArray(value)) {
    throw new TypeError("Wrangler containers list output must be an array.");
  }
  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(`Wrangler application ${index} must be an object.`);
    }
    return {
      id: requireString(entry.id, `Wrangler application ${index} id`),
      name: requireString(entry.name, `Wrangler application ${index} name`),
      state: requireString(entry.state, `Wrangler application ${index} state`),
      configuredInstances: requireInteger(
        entry.instances,
        `Wrangler application ${index} instances`,
      ),
      version:
        entry.version === null || entry.version === undefined
          ? null
          : requireInteger(
              entry.version,
              `Wrangler application ${index} version`,
            ),
      createdAt: requireString(
        entry.created_at,
        `Wrangler application ${index} created_at`,
      ),
      updatedAt: requireString(
        entry.updated_at,
        `Wrangler application ${index} updated_at`,
      ),
    };
  });
};

export const parseWranglerInstancesPage = (value) => {
  const instances = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.instances)
      ? value.instances
      : null;
  if (!instances) {
    throw new TypeError("Wrangler instances output has an invalid shape.");
  }
  const nextPageToken =
    isRecord(value) && isRecord(value.result_info)
      ? value.result_info.next_page_token
      : null;
  if (nextPageToken !== null && nextPageToken !== undefined) {
    requireString(nextPageToken, "Wrangler next page token");
  }
  return {
    instances: instances.map((entry, index) => {
      if (!isRecord(entry)) {
        throw new TypeError(`Wrangler instance ${index} must be an object.`);
      }
      const id = requireString(entry.id, `Wrangler instance ${index} id`);
      const name =
        entry.name === null || entry.name === undefined
          ? null
          : requireString(entry.name, `Wrangler instance ${index} name`);
      const created = requireString(
        entry.created,
        `Wrangler instance ${index} created`,
      );
      if (!Number.isFinite(Date.parse(created))) {
        throw new TypeError(`Wrangler instance ${index} created is invalid.`);
      }
      return {
        id,
        name,
        state: requireString(entry.state, `Wrangler instance ${index} state`),
        version:
          entry.version === null || entry.version === undefined
            ? null
            : requireInteger(
                entry.version,
                `Wrangler instance ${index} version`,
              ),
        created,
      };
    }),
    nextPageToken: nextPageToken ?? null,
  };
};

const parseCommandJson = (output, label) => {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`${label} did not return clean JSON.`);
  }
};

export const createWranglerReader = ({
  wranglerPath = DEFAULT_WRANGLER_PATH,
  cwd = WORKER_ROOT,
  execFile = execFileSync,
} = {}) => {
  const invoke = (args) =>
    execFile(wranglerPath, args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  return {
    listApplications() {
      return parseWranglerApplications(
        parseCommandJson(
          invoke(["containers", "list", "--json", "--per-page", "100"]),
          "wrangler containers list",
        ),
      );
    },
    listInstances(applicationId) {
      const all = [];
      let pageToken = null;
      do {
        const args = [
          "containers",
          "instances",
          applicationId,
          "--json",
          "--per-page",
          "100",
        ];
        if (pageToken) args.push("--page-token", pageToken);
        const page = parseWranglerInstancesPage(
          parseCommandJson(invoke(args), "wrangler containers instances"),
        );
        all.push(...page.instances);
        pageToken = page.nextPageToken;
      } while (pageToken);
      return all;
    },
    findExactInstance(applicationId, instanceId) {
      const output = parseCommandJson(
        invoke([
          "containers",
          "instances",
          applicationId,
          "--json",
          "--search",
          instanceId,
        ]),
        "wrangler containers instances --search",
      );
      return parseWranglerInstancesPage(output).instances;
    },
  };
};

export const inferWorkload = (className, name) => {
  if (className === "AppBuildSandbox" || name?.startsWith("m0-")) {
    return {
      classification: "app-build",
      candidates: ["app-build"],
    };
  }
  if (name?.startsWith("agent-")) {
    return {
      classification: "agent-or-resident-attachment",
      candidates: ["agent", "resident-attachment"],
    };
  }
  return { classification: "unknown", candidates: [] };
};

export const classifyAge = (created, nowMs, staleHours) => {
  const ageHours = Math.max(0, (nowMs - Date.parse(created)) / 3_600_000);
  return {
    ageHours: Math.round(ageHours * 100) / 100,
    ageBand:
      ageHours >= staleHours ? "stale" : ageHours >= 1 ? "aging" : "fresh",
  };
};

const isLiveState = (state) => state !== "inactive" && state !== "stopped";

export const parseDurableInventory = (value) => {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.targets)
  ) {
    throw new TypeError(
      "Durable inventory must be { schemaVersion: 1, targets: [...] }.",
    );
  }
  const defaultEnvironment =
    value.environment === undefined
      ? null
      : requireString(value.environment, "Durable inventory environment");
  return value.targets.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new TypeError(`Durable target ${index} must be an object.`);
    }
    const environment =
      entry.environment === undefined
        ? defaultEnvironment
        : requireString(
            entry.environment,
            `Durable target ${index} environment`,
          );
    if (environment !== "dev" && environment !== "bn118") {
      throw new TypeError(`Durable target ${index} environment is invalid.`);
    }
    if (entry.size !== "small" && entry.size !== "large") {
      throw new TypeError(`Durable target ${index} size is invalid.`);
    }
    if (
      entry.workload !== "app-build" &&
      entry.workload !== "agent" &&
      entry.workload !== "resident-attachment"
    ) {
      throw new TypeError(`Durable target ${index} workload is invalid.`);
    }
    if (entry.lifecycle !== "owned" && entry.lifecycle !== "retiring") {
      throw new TypeError(`Durable target ${index} lifecycle is invalid.`);
    }
    return {
      environment,
      sandboxId: requireString(
        entry.sandboxId,
        `Durable target ${index} sandboxId`,
      ),
      size: entry.size,
      workload: entry.workload,
      lifecycle: entry.lifecycle,
    };
  });
};

const durableMatches = (instance, target) =>
  instance.environment === target.environment &&
  instance.name === target.sandboxId &&
  instance.size === target.size &&
  instance.workloadCandidates.includes(target.workload);

export const reconcileOperationalInventory = (instances, durableTargets) => {
  if (durableTargets === null) {
    return {
      authority: "unavailable",
      limitation:
        "Cloudflare does not provide global Durable Object storage enumeration; supply an explicit durable inventory export to classify ownership.",
      ownedLive: [],
      retiringLive: [],
      orphan: [],
      missing: [],
      unverifiedLive: instances.map((instance) => instance.instanceId),
    };
  }
  const matchedTargets = new Set();
  const ownedLive = [];
  const retiringLive = [];
  const orphan = [];
  for (const instance of instances) {
    const targetIndex = durableTargets.findIndex((target, index) => {
      return !matchedTargets.has(index) && durableMatches(instance, target);
    });
    if (targetIndex === -1) {
      orphan.push(instance.instanceId);
      continue;
    }
    matchedTargets.add(targetIndex);
    const target = durableTargets[targetIndex];
    (target.lifecycle === "retiring" ? retiringLive : ownedLive).push(
      instance.instanceId,
    );
  }
  return {
    authority: "explicit-export",
    limitation: null,
    ownedLive,
    retiringLive,
    orphan,
    missing: durableTargets
      .filter(
        (target, index) =>
          target.lifecycle === "owned" && !matchedTargets.has(index),
      )
      .map((target) => ({ ...target })),
    unverifiedLive: [],
  };
};

export const buildInventoryReport = ({
  configured,
  applications,
  instancesByApplication,
  durableTargets = null,
  nowMs = Date.now(),
  staleHours = DEFAULT_STALE_HOURS,
}) => {
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(staleHours) ||
    staleHours <= 0
  ) {
    throw new TypeError("Inventory timestamps and thresholds must be finite.");
  }
  const liveInstances = [];
  const configuredApplications = configured.map((expected) => {
    const deployed = applications.find(
      (application) => application.name === expected.applicationName,
    );
    if (!deployed) {
      return {
        ...expected,
        deployed: false,
        platform: null,
        capacity: {
          instanceType: expected.instanceType,
          maxInstances: expected.maxInstances,
          liveInstances: 0,
          headroom: expected.maxInstances,
          state: "not-deployed",
          configurationDrift: null,
        },
        live: [],
        inactiveRecordCount: 0,
      };
    }
    const records = instancesByApplication.get(deployed.id) ?? [];
    const live = records
      .filter((instance) => isLiveState(instance.state))
      .map((instance) => {
        const workload = inferWorkload(expected.className, instance.name);
        const record = {
          environment: expected.environment,
          applicationId: deployed.id,
          applicationName: deployed.name,
          instanceId: instance.id,
          name: instance.name,
          state: instance.state,
          version: instance.version,
          created: instance.created,
          size: expected.size,
          instanceType: expected.instanceType,
          workload: workload.classification,
          workloadCandidates: workload.candidates,
          ...classifyAge(instance.created, nowMs, staleHours),
        };
        liveInstances.push(record);
        return record;
      });
    return {
      ...expected,
      deployed: true,
      platform: {
        id: deployed.id,
        state: deployed.state,
        configuredInstances: deployed.configuredInstances,
        version: deployed.version,
        createdAt: deployed.createdAt,
        updatedAt: deployed.updatedAt,
      },
      capacity: {
        instanceType: expected.instanceType,
        maxInstances: expected.maxInstances,
        liveInstances: live.length,
        headroom: Math.max(0, expected.maxInstances - live.length),
        state:
          live.length > expected.maxInstances
            ? "over-capacity"
            : live.length === expected.maxInstances
              ? "full"
              : "available",
        configurationDrift:
          deployed.configuredInstances !== expected.maxInstances,
      },
      live,
      inactiveRecordCount: records.length - live.length,
    };
  });

  const reconciliation = reconcileOperationalInventory(
    liveInstances,
    durableTargets,
  );
  return {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    staleAfterHours: staleHours,
    mutation: "none",
    durableEnumeration: "not-supported-by-platform",
    configuredApplications,
    totals: {
      configuredApplications: configuredApplications.length,
      deployedApplications: configuredApplications.filter(
        (entry) => entry.deployed,
      ).length,
      liveInstances: liveInstances.length,
      staleLiveInstances: liveInstances.filter(
        (instance) => instance.ageBand === "stale",
      ).length,
      inactiveRecords: configuredApplications.reduce(
        (sum, entry) => sum + entry.inactiveRecordCount,
        0,
      ),
    },
    reconciliation,
  };
};

export const readDurableInventoryFile = (filePath) =>
  parseDurableInventory(JSON.parse(readFileSync(filePath, "utf8")));

export const collectInventoryReport = ({
  configPath = DEFAULT_CONFIG_PATH,
  durableInventoryPath = null,
  wranglerReader = createWranglerReader(),
  nowMs = Date.now(),
  staleHours = DEFAULT_STALE_HOURS,
} = {}) => {
  const config = parseJsonc(readFileSync(configPath, "utf8"));
  const configured = configuredContainerApplications(config);
  const applications = wranglerReader.listApplications();
  const configuredNames = new Set(
    configured.map((entry) => entry.applicationName),
  );
  const instancesByApplication = new Map();
  for (const application of applications) {
    if (!configuredNames.has(application.name)) continue;
    instancesByApplication.set(
      application.id,
      wranglerReader.listInstances(application.id),
    );
  }
  return buildInventoryReport({
    configured,
    applications,
    instancesByApplication,
    durableTargets: durableInventoryPath
      ? readDurableInventoryFile(durableInventoryPath)
      : null,
    nowMs,
    staleHours,
  });
};

export const parseArguments = (argv) => {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${argument}`);
    }
    const equals = argument.indexOf("=");
    if (equals !== -1) {
      const name = argument.slice(2, equals);
      const value = argument.slice(equals + 1);
      const prior = values.get(name) ?? [];
      prior.push(value);
      values.set(name, prior);
      continue;
    }
    const name = argument.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      const prior = values.get(name) ?? [];
      prior.push(next);
      values.set(name, prior);
      index += 1;
    } else {
      flags.add(name);
    }
  }
  return {
    flag(name) {
      return flags.has(name);
    },
    one(name, fallback = null) {
      const entries = values.get(name) ?? [];
      if (entries.length > 1)
        throw new Error(`--${name} may only be set once.`);
      return entries[0] ?? fallback;
    },
    many(name) {
      return values.get(name) ?? [];
    },
  };
};

export const cleanupConfirmation = (environment, instanceIds) =>
  `RETIRE:${environment}:${[...instanceIds].sort().join(",")}`;

export const planExactCleanup = ({ report, environment, instanceIds }) => {
  if (environment !== "dev" && environment !== "bn118") {
    throw new Error("Cleanup environment must be dev or bn118.");
  }
  if (!Array.isArray(instanceIds) || instanceIds.length === 0) {
    throw new Error("At least one explicit --instance-id is required.");
  }
  if (instanceIds.some((instanceId) => !/^[0-9a-f]{64}$/i.test(instanceId))) {
    throw new Error("Cleanup instance IDs must be exact 64-character hex IDs.");
  }
  if (new Set(instanceIds).size !== instanceIds.length) {
    throw new Error("Cleanup instance IDs must be unique.");
  }
  const live = report.configuredApplications.flatMap(
    (application) => application.live,
  );
  const selected = instanceIds.map((instanceId) => {
    const matches = live.filter(
      (entry) =>
        entry.environment === environment && entry.instanceId === instanceId,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Instance ${instanceId} is not exactly one live ${environment} instance.`,
      );
    }
    return matches[0];
  });
  return {
    schemaVersion: 1,
    environment,
    mutation: "dry-run",
    selected,
    confirmation: cleanupConfirmation(environment, instanceIds),
    warning:
      "Wrangler has no supported per-instance delete command. Apply requires an explicit operator-owned adapter that destroys the exact logical Sandbox Durable Object; deleting the container application is never permitted.",
  };
};

export const authorizeCleanupApply = ({
  apply,
  environment,
  instanceIds,
  confirmation,
  adapter,
}) => {
  if (!apply) return { authorized: false, adapter: null };
  const expected = cleanupConfirmation(environment, instanceIds);
  if (confirmation !== expected) {
    throw new Error(`Refusing mutation: pass --confirm '${expected}' exactly.`);
  }
  if (typeof adapter !== "string" || adapter.length === 0) {
    throw new Error(
      "Refusing mutation: Wrangler has no supported per-instance delete; --adapter is required.",
    );
  }
  return { authorized: true, adapter };
};

export const assertExactInstanceStillLive = (
  wranglerReader,
  selectedInstance,
) => {
  const matches = wranglerReader.findExactInstance(
    selectedInstance.applicationId,
    selectedInstance.instanceId,
  );
  if (
    matches.length !== 1 ||
    matches[0].id !== selectedInstance.instanceId ||
    matches[0].name !== selectedInstance.name ||
    !isLiveState(matches[0].state)
  ) {
    throw new Error(
      `Instance ${selectedInstance.instanceId} changed after the cleanup plan was built.`,
    );
  }
};
