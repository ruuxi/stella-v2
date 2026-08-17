import type { ComponentType } from "react";
import type { CompactActivitySummary } from "@/features/chat/lib/event-transforms";

export type CompactChildStateProps = {
  summary: CompactActivitySummary;
  prioritizeFailure: boolean;
  /** Thread start time; drives the live elapsed-running label. */
  startedAtMs?: number;
  /** Only show the elapsed label while the owner thread is running. */
  running?: boolean;
};

export declare const CompactChildState: ComponentType<CompactChildStateProps>;
