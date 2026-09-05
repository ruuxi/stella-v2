import type { AgentHome } from "./agent-home.js";
import type { OwnerHomeContext } from "./owner-home-context.js";

export type PreparedHomeContent = {
  memoryPreference: OwnerHomeContext["memory"]["preference"];
  memoryDocuments: Awaited<ReturnType<AgentHome["readDocuments"]>>;
  personalityOverride: Awaited<ReturnType<AgentHome["readPersonality"]>>;
  skillCatalog: OwnerHomeContext["skills"];
};
export type ConversationHomeSnapshot = { key: string; content: PreparedHomeContent };
export const CONVERSATION_HOME_CACHE_KEY = "conversationHome:content:v1";

/** Only a copy of versioned prompt inputs. Authority still comes from OwnerGate
 * on every admission and immediately before each model request. */
export class ConversationHomeCache {
  private resident?: ConversationHomeSnapshot;
  constructor(private readonly durable: {
    read(): ConversationHomeSnapshot | undefined;
    write(snapshot: ConversationHomeSnapshot): void;
    clear(): void;
    purged(): boolean;
  }) {}

  async load(args: {
    ownerId: string;
    metadata: OwnerHomeContext;
    readContent(): Promise<PreparedHomeContent>;
  }): Promise<PreparedHomeContent> {
    if (this.durable.purged()) throw new Error("Conversation was purged.");
    const key = JSON.stringify([args.ownerId, args.metadata.memory, args.metadata.skills.entries]);
    const cached = this.resident ?? this.durable.read();
    if (cached?.key === key) {
      this.resident = cached;
      return cached.content;
    }
    // Drop the previous generation/policy/content before any asynchronous read.
    this.resident = undefined;
    this.durable.clear();
    const content = await args.readContent();
    if (this.durable.purged()) throw new Error("Conversation was purged.");
    const snapshot = { key, content };
    // SQLite KV caps values at 128 KiB. Large catalogs still work in memory.
    // Synchronous persistence cannot race a purge between the check and write.
    if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength < 100_000) {
      this.durable.write(snapshot);
    }
    this.resident = snapshot;
    return content;
  }
}
