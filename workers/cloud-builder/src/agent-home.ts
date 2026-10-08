/**
 * The cloud agent home: the owner's memory files and mirrored skills.
 *
 * Memory is plain files in the owner's world under `.stella/`, the desktop's
 * `~/.stella` layout (`world-memory.ts`). Only the documents the shared
 * resident registry keeps resident are injected (`readDocuments`), read
 * fresh every turn; every nested `memories/` file is opened on demand.
 * Skills stay in the owner's cloud home (R2 plus the owner object's catalog).
 */

import { RESIDENT_MEMORY_DISPLAY_PATHS } from "@stella/runtime/kernel/agent-runtime/resident-context.js";
import {
  CloudHomeStore,
  type CloudHomeEndpoint,
  type CloudSkillCatalogSnapshot,
} from "./cloud-home-store.js";
import {
  WORLD_PERSONALITY_FILE,
  readWorldStellaText,
  type MemoryWorld,
} from "./world-memory.js";

export type MemoryDocument = {
  name: string;
  displayPath: string;
  content: string;
};

export class AgentHomeUnavailableError extends Error {
  constructor() {
    super("Stella's memory isn't available in this environment yet.");
    this.name = "AgentHomeUnavailableError";
  }
}

const DISPLAY_PREFIX = "~/.stella/";

export class AgentHome {
  private readonly cloud?: CloudHomeStore;

  constructor(
    bucket: R2Bucket | undefined,
    ownerId: string,
    endpoint: Omit<CloudHomeEndpoint, "ownerId">,
    /** The owner's world, where memory lives; absent, there is none. */
    private readonly world?: () => Promise<MemoryWorld>,
  ) {
    if (bucket) {
      this.cloud = new CloudHomeStore(bucket, { ...endpoint, ownerId });
    }
  }

  get available(): boolean {
    return Boolean(this.cloud);
  }

  async loadSkillCatalog(
    agentType: "orchestrator" | "general",
  ): Promise<CloudSkillCatalogSnapshot> {
    if (!this.cloud) throw new AgentHomeUnavailableError();
    return await this.cloud.loadSkillCatalog(agentType);
  }

  cloudStore(): CloudHomeStore {
    if (!this.cloud) throw new AgentHomeUnavailableError();
    return this.cloud;
  }

  /**
   * The owner's resident memory documents (`~/.stella/core-memory.md`,
   * `memories/profile.md`, `memories/index.md`) as raw file text from the
   * world, keyed by the display path the model sees. The shared resident
   * registry shapes them (redaction, caps) exactly as it does on the desktop.
   */
  async readDocuments(): Promise<MemoryDocument[]> {
    if (!this.world) return [];
    const world = await this.world();
    const documents = await Promise.all(
      RESIDENT_MEMORY_DISPLAY_PATHS.map(async (displayPath) => {
        const name = displayPath.slice(DISPLAY_PREFIX.length);
        return {
          name,
          displayPath,
          content: (await readWorldStellaText(world, name)) ?? "",
        };
      }),
    );
    return documents.filter((document) => document.content.trim());
  }

  /**
   * The user's personality override, when their world carries one
   * (`.stella/PERSONALITY.md`); otherwise the caller falls back to the
   * canonical default personality.
   */
  async readPersonality(): Promise<string | null> {
    if (!this.world) return null;
    const content = await readWorldStellaText(
      await this.world(),
      WORLD_PERSONALITY_FILE,
    );
    return content?.trim() ? content : null;
  }
}
