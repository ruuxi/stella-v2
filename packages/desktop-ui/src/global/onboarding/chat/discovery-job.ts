/**
 * The discovery job: collect local signals, synthesize the core memory,
 * write it to disk, and park the greeting + finale payload for the chat.
 *
 * A module-level store rather than component state so the job survives
 * the onboarding surface unmounting: a user who types straight into the
 * composer and skips to chat still ends up with a profile a few seconds
 * later. IPC calls cannot be aborted, so a generation counter makes an
 * older run's results inert instead of racing a newer one.
 *
 * Unlike the legacy flow this does not wait for a conversation id — the
 * greeting is parked (see `pending-handoff.ts`) and appended by the chat
 * surface once the root layout has selected a conversation.
 */
import { useSyncExternalStore } from "react";
import type { DiscoveryCategory } from "@stella/contracts/discovery";
import type { OnboardingStarter } from "@stella/contracts/desktop/onboarding";
import { synthesizeCoreMemory } from "@/global/onboarding/services/synthesis";
import { setPendingDiscoveryWelcome } from "./pending-handoff";

export type DiscoveryJobStatus =
  | "idle"
  | "collecting"
  | "synthesizing"
  | "saving"
  | "done"
  | "failed";

export type DiscoveryJobResult = {
  coreMemory: string;
  welcomeMessage: string;
  profileHighlights: string[];
  starters: OnboardingStarter[];
};

export type DiscoveryJobSnapshot = {
  status: DiscoveryJobStatus;
  result: DiscoveryJobResult | null;
  /** Developer-facing reason; the card shows friendly copy instead. */
  error: string | null;
};

export type DiscoveryJobInput = {
  categories: DiscoveryCategory[];
  selectedBrowser?: string;
  selectedProfile?: string;
  includeAuth: boolean;
};

const IDLE: DiscoveryJobSnapshot = { status: "idle", result: null, error: null };

let snapshot: DiscoveryJobSnapshot = IDLE;
let generation = 0;
const listeners = new Set<() => void>();

const publish = (next: DiscoveryJobSnapshot) => {
  snapshot = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getDiscoveryJobSnapshot = () => snapshot;

export function useDiscoveryJob(): DiscoveryJobSnapshot {
  return useSyncExternalStore(subscribe, getDiscoveryJobSnapshot, () => IDLE);
}

export const resetDiscoveryJob = () => {
  generation += 1;
  publish(IDLE);
};

const fail = (jobGeneration: number, error: string, details?: unknown) => {
  if (jobGeneration !== generation) return;
  console.error("[onboarding-chat] Discovery failed:", error, details ?? "");
  publish({ status: "failed", result: null, error });
};

/**
 * Starts (or restarts) the job. Safe to call again after a failure; a
 * second call while a run is in flight supersedes it.
 */
export const startDiscoveryJob = (input: DiscoveryJobInput) => {
  generation += 1;
  const jobGeneration = generation;
  const isCurrent = () => jobGeneration === generation;
  publish({ status: "collecting", result: null, error: null });

  void (async () => {
    try {
      const discovery = window.electronAPI?.discovery;
      if (!discovery?.collectAllSignals) {
        fail(jobGeneration, "Discovery IPC is unavailable.");
        return;
      }

      const collected = await discovery.collectAllSignals({
        categories: input.categories,
        selectedBrowser: input.selectedBrowser,
        selectedProfile: input.selectedProfile,
      });
      if (!isCurrent()) return;
      if (!collected) {
        fail(jobGeneration, "Signal collection returned no result.");
        return;
      }
      if (collected.error) {
        fail(jobGeneration, "Signal collection failed.", collected.error);
        return;
      }
      const formattedSections = collected.formattedSections;
      if (!formattedSections || Object.keys(formattedSections).length === 0) {
        fail(
          jobGeneration,
          "Signal collection returned no usable discovery data.",
          collected,
        );
        return;
      }

      publish({ status: "synthesizing", result: null, error: null });
      const synthesis = await synthesizeCoreMemory(formattedSections, {
        includeAuth: input.includeAuth,
        includeWelcomeHtml: false,
        includeStarters: true,
      });
      if (!isCurrent()) return;
      if (!synthesis.coreMemory) {
        fail(
          jobGeneration,
          "Core memory synthesis returned an empty result.",
          synthesis,
        );
        return;
      }

      publish({ status: "saving", result: null, error: null });
      // Location is only resolved (and stored in core-memory.md) when the
      // user opted into a category that already implies their physical
      // location — browsing history or apps/system signals.
      const includeLocation =
        input.categories.includes("browsing_bookmarks") ||
        input.categories.includes("apps_system");
      const [coreMemoryWrite, knowledgeWrite] = await Promise.all([
        discovery.writeCoreMemory
          ? discovery.writeCoreMemory(synthesis.coreMemory, { includeLocation })
          : Promise.resolve({
              ok: false as const,
              error: "Core memory write IPC is unavailable.",
            }),
        discovery.writeKnowledge
          ? discovery.writeKnowledge({
              coreMemory: synthesis.coreMemory,
              formattedSections,
              ...(synthesis.categoryAnalyses
                ? {
                    categoryAnalyses: synthesis.categoryAnalyses as Partial<
                      Record<DiscoveryCategory, string>
                    >,
                  }
                : {}),
            })
          : Promise.resolve({
              ok: false as const,
              error: "Knowledge write IPC is unavailable.",
            }),
      ]);
      if (!isCurrent()) return;
      if (!coreMemoryWrite?.ok || !knowledgeWrite?.ok) {
        fail(jobGeneration, "Failed to save discovery memory.", {
          coreMemoryWrite,
          knowledgeWrite,
        });
        return;
      }

      if (synthesis.welcomeMessage) {
        setPendingDiscoveryWelcome(synthesis.welcomeMessage);
      }

      publish({
        status: "done",
        error: null,
        result: {
          coreMemory: synthesis.coreMemory,
          welcomeMessage: synthesis.welcomeMessage,
          profileHighlights: synthesis.profileHighlights ?? [],
          starters: synthesis.starters ?? [],
        },
      });
    } catch (error) {
      fail(jobGeneration, "Discovery failed unexpectedly.", error);
    }
  })();
};
