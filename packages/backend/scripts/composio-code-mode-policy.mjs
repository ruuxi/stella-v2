/**
 * Stella-reviewed Code Mode allowlist for connected actions.
 *
 * This file is an administrative policy artifact, not a classifier. Adding an
 * entry means a Stella reviewer has checked the exact action contract and
 * judged it safe to execute without a human approval prompt. Composio tags,
 * tool names, descriptions, scopes, and HTTP verbs must never add entries.
 *
 * GMAIL_GET_PROFILE is a genuine Composio action that reads mailbox profile
 * counters and the authenticated email address. The backend still requires
 * Composio's independent readOnlyHint and destructiveHint=false at admission.
 */
const REVIEWED_CODE_MODE_ACTIONS = Object.freeze({
  "gmail:GMAIL_GET_PROFILE": Object.freeze({
    effect: "read",
    requiresApproval: false,
    policyVersion: "2026-08-26.gmail-get-profile.v1",
    // Dated Composio toolkit contract reviewed independently of the provider's
    // mutable `latest` alias. A version change requires a new Stella review.
    toolkitVersion: "20260817_00",
    reviewedInputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        user_id: Object.freeze({
          type: "string",
          minLength: 1,
          maxLength: 320,
        }),
      }),
      additionalProperties: false,
    }),
    source: "stella_admin",
  }),
});

export const codeModePolicyForAction = (integrationId, action) =>
  REVIEWED_CODE_MODE_ACTIONS[`${integrationId}:${action}`];

export const reviewedCodeModeActionKeys = () =>
  Object.keys(REVIEWED_CODE_MODE_ACTIONS);
