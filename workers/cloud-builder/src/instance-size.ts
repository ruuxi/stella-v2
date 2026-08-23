/**
 * Right-sizing for agent sandboxes.
 *
 * A container's instance type is a deploy-time property of its class in
 * wrangler.jsonc — `ContainerStartupOptions` has no size field, so a single
 * class cannot be sized per turn. The ladder is therefore expressed as two
 * container classes over the same image: `SandboxSmall` for the default turn
 * and the existing `Sandbox` for heavy work and OOM retries. When the small
 * binding is missing (a deployment that has not added it yet) everything
 * falls back to the large class, which is the behavior that shipped before.
 */

export type InstanceSize = "small" | "large";

export const INSTANCE_TIERS: Record<
  InstanceSize,
  {
    binding: string;
    instanceType: string;
    vCpu: number;
    memoryBytes: number;
    diskBytes: number;
  }
> = {
  small: {
    binding: "SANDBOX_SMALL",
    instanceType: "standard-2",
    vCpu: 1,
    memoryBytes: 6 * 1024 ** 3,
    diskBytes: 12 * 1024 ** 3,
  },
  large: {
    binding: "Sandbox",
    instanceType: "standard-4",
    vCpu: 4,
    memoryBytes: 12 * 1024 ** 3,
    diskBytes: 20 * 1024 ** 3,
  },
};

// Stacks that reliably need more than 6 GiB or more than one core: native
// toolchains, browser automation, media transcoding, ML. Cheap to be wrong in
// the conservative direction — a mis-sized turn that OOMs is retried larger.
const HEAVY_STACK_PATTERN =
  /\b(docker|kubernetes|ffmpeg|transcod\w*|puppeteer|playwright|chromium|headless browser|webpack|next\s?build|gradle|maven|xcode|cargo build|rustc|cmake|\.tar\.gz|torch|pytorch|tensorflow|cuda|llama\.cpp|pandas|numpy|monorepo|npm install|bun install|pnpm install|yarn install|type ?check the (whole|entire)|build the (whole|entire))\b/i;

/**
 * Where a turn starts on the ladder. A cold repository has to clone and
 * install its dependencies, which is the expensive part of project work, so it
 * starts large; once the workspace is checkpointed the turn is ordinary work
 * again and is sized by what it was asked to do. Everything else starts small
 * and escalates only if it actually runs out of memory.
 */
export const initialInstanceSize = (args: {
  workspaceKind: string;
  prompt: string;
  /** A checkpoint exists, so this turn restores instead of cloning. */
  restored?: boolean;
}): InstanceSize => {
  if (
    !args.restored &&
    (args.workspaceKind === "project" || args.workspaceKind === "stella")
  ) {
    return "large";
  }
  return HEAVY_STACK_PATTERN.test(args.prompt) ? "large" : "small";
};

/** A remembered size from KV or Convex; anything else means "not learned yet". */
export const asInstanceSize = (
  value: string | null | undefined,
): InstanceSize | undefined => {
  const size = value?.trim();
  return size === "small" || size === "large" ? size : undefined;
};

// 137 = 128 + SIGKILL, which is what the kernel OOM killer leaves behind;
// the rest are the messages bun, node, and the container runtime print on
// the way down.
const OOM_PATTERN =
  /(out of memory|oom[- ]?kill|OOMKilled|JavaScript heap out of memory|ENOMEM|Cannot allocate memory|signal 9|SIGKILL|exit(ed)? (with )?(code )?137)/i;

export const isOutOfMemoryFailure = (args: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  message?: string;
}): boolean => {
  if (args.exitCode === 137) return true;
  const haystack = [args.stderr, args.stdout, args.message]
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .slice(-8_000);
  return OOM_PATTERN.test(haystack);
};
