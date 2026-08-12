import type { ComponentType } from "react";
import type { CompactActivitySummary } from "@/features/chat/lib/event-transforms";

export type CompactChildStateProps = {
  summary: CompactActivitySummary;
  prioritizeFailure: boolean;
};

export declare const CompactChildState: ComponentType<CompactChildStateProps>;
