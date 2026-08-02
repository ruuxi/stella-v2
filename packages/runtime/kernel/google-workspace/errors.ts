/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Schema } from "effect";

/**
 * Tagged failures for the Google Workspace auth adapter. The plain-Promise
 * facades in `AuthManager.ts` rethrow these across the Effect boundary, so
 * every escaping message is byte-identical to the string the pre-Effect
 * code threw. Do not reword them.
 */

export class GoogleWorkspaceProjectRootError extends Schema.TaggedErrorClass<GoogleWorkspaceProjectRootError>()(
  "@stella/runtime/google-workspace/GoogleWorkspaceProjectRootError",
  {},
) {
  override get message() {
    return "Google Workspace project root is not under Stella state.";
  }
}

export class GoogleWorkspaceNotConnectedError extends Schema.TaggedErrorClass<GoogleWorkspaceNotConnectedError>()(
  "@stella/runtime/google-workspace/GoogleWorkspaceNotConnectedError",
  {},
) {
  override get message() {
    return "Google Workspace is not connected.";
  }
}

export class GoogleWorkspaceReconnectRequiredError extends Schema.TaggedErrorClass<GoogleWorkspaceReconnectRequiredError>()(
  "@stella/runtime/google-workspace/GoogleWorkspaceReconnectRequiredError",
  {},
) {
  override get message() {
    return "Google Workspace needs to be reconnected.";
  }
}
