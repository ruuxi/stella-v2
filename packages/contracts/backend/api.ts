/**
 * Every backend call and view, by name. Each domain declares its own map in
 * this directory and adds it to the intersections below; the server registry
 * and the clients are both typed against these, so a renamed function or a
 * changed argument fails to compile on both sides.
 */

import type { AgentThreadCalls, AgentThreadViews } from "./agent-threads.js";
import type { ConversationCalls, ConversationViews } from "./conversations.js";

type SystemCalls = {
  /** Round trip through the caller's owner object. */
  "system.ping": { args: Record<string, never>; result: { now: number } };
};

export type BackendCalls = SystemCalls & ConversationCalls & AgentThreadCalls;
export type BackendViews = ConversationViews & AgentThreadViews;

export type CallName = keyof BackendCalls & string;
export type ViewName = keyof BackendViews & string;

type ArgsOf<T> = T extends { args: infer A } ? A : never;
type ResultOf<T> = T extends { result: infer R } ? R : never;

export type CallArgs<K extends CallName> = ArgsOf<BackendCalls[K]>;
export type CallResult<K extends CallName> = ResultOf<BackendCalls[K]>;
export type ViewArgs<K extends ViewName> = ArgsOf<BackendViews[K]>;
export type ViewResult<K extends ViewName> = ResultOf<BackendViews[K]>;
