/**
 * Every backend call and view, by name. Each domain declares its own map in
 * this directory and adds it to the intersections below; the server registry
 * and the clients are both typed against these, so a renamed function or a
 * changed argument fails to compile on both sides.
 */

import type { AgentThreadCalls, AgentThreadViews } from "./agent-threads.js";
import type { AppSourceCalls } from "./app-source.js";
import type { BillingCalls, BillingViews } from "./billing.js";
import type { DeviceCalls, DeviceViews } from "./devices.js";
import type { ConversationCalls, ConversationViews } from "./conversations.js";
import type { HomeCalls, HomeViews } from "./home.js";
import type { DriveCalls, DriveViews } from "./drive.js";
import type { ScheduleCalls, ScheduleViews } from "./schedules.js";
import type { PreferenceCalls, PreferenceViews } from "./preferences.js";
import type { AccountCalls } from "./account.js";
import type { ShareCalls, ShareViews } from "./shares.js";
import type { SearchCalls } from "./search.js";
import type { MediaCalls, MediaViews } from "./media.js";
import type { VoiceCalls } from "./voice.js";
import type { IntegrationCalls, IntegrationViews } from "./integrations.js";

type SystemCalls = {
  /** Round trip through the caller's owner object. */
  "system.ping": { args: Record<string, never>; result: { now: number } };
};

export type BackendCalls = SystemCalls &
  ConversationCalls &
  AgentThreadCalls &
  BillingCalls &
  DeviceCalls &
  AppSourceCalls &
  HomeCalls &
  DriveCalls &
  ScheduleCalls &
  PreferenceCalls &
  AccountCalls &
  ShareCalls &
  SearchCalls &
  MediaCalls &
  VoiceCalls &
  IntegrationCalls;
export type BackendViews = ConversationViews &
  AgentThreadViews &
  BillingViews &
  DeviceViews &
  HomeViews &
  DriveViews &
  ScheduleViews &
  PreferenceViews &
  ShareViews &
  MediaViews &
  IntegrationViews;

export type CallName = keyof BackendCalls & string;
export type ViewName = keyof BackendViews & string;

type ArgsOf<T> = T extends { args: infer A } ? A : never;
type ResultOf<T> = T extends { result: infer R } ? R : never;

export type CallArgs<K extends CallName> = ArgsOf<BackendCalls[K]>;
export type CallResult<K extends CallName> = ResultOf<BackendCalls[K]>;
export type ViewArgs<K extends ViewName> = ArgsOf<BackendViews[K]>;
export type ViewResult<K extends ViewName> = ResultOf<BackendViews[K]>;
