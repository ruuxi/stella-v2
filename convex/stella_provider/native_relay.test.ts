import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  cloudTurnTokenFromRequest,
  connectedCredentialForwardHeaders,
  connectedCredentialUpstreamUrl,
  isInternalRelayRequestHeader,
  nativeCredentialBody,
} from "./native_relay";
import type { AuthorizedStellaRequest } from "./shared";

const authorizedRequest = (
  provider: "anthropic" | "openai-codex",
): AuthorizedStellaRequest => ({
  ownerId: "owner",
  agentType: "general",
  relayProvider: provider === "anthropic" ? "anthropic" : "openai",
  requestJson:
    provider === "anthropic"
      ? {
          model: "claude-opus-4-6",
          system: [{ type: "text", text: "native prompt" }],
          messages: [{ role: "user", content: "hello" }],
          stream: true,
          output_config: { effort: "high" },
          thinking: { type: "adaptive" },
        }
      : {
          model: "gpt-5.6-sol",
          input: [{ role: "user", content: "hello" }],
          reasoning: { effort: "high", summary: "auto" },
          stream: true,
          stream_options: {
            reasoning_summary_delivery: "sequential_cutoff",
          },
          store: false,
        },
  requestedModel: provider === "anthropic" ? "claude-opus-4-6" : "gpt-5.6-sol",
  resolvedModel:
    provider === "anthropic" ? "anthropic/claude-opus-4-6" : "gpt-5.6-sol",
  upstreamModel: provider === "anthropic" ? "claude-opus-4-6" : "gpt-5.6-sol",
  apiKey: "",
  tokenEstimate: { inputTokens: 1, outputTokens: 1 },
  userCredential:
    provider === "anthropic"
      ? { provider, accessToken: "anthropic-oauth" }
      : {
          provider,
          accessToken: "codex-oauth",
          accountId: "account-123",
        },
});

describe("native connected-engine relay", () => {
  test("accepts matching native bearer and explicit turn credentials", () => {
    const request = new Request("https://example.test/api/stella/relay", {
      headers: {
        authorization: "Bearer scoped-turn-token",
        "x-stella-turn-token": "scoped-turn-token",
      },
    });
    assert.deepEqual(cloudTurnTokenFromRequest(request), {
      ok: true,
      token: "scoped-turn-token",
    });

    const conflicting = new Request("https://example.test/api/stella/relay", {
      headers: {
        authorization: "Bearer one-token",
        "x-stella-turn-token": "other-token",
      },
    });
    assert.deepEqual(cloudTurnTokenFromRequest(conflicting), { ok: false });
  });

  test("strips Stella capabilities and network-edge identity", () => {
    for (const header of [
      "authorization",
      "x-stella-turn-token",
      "x-stella-llm-credential",
      "x-stella-future-internal",
      "chatgpt-account-id",
      "cf-connecting-ip",
      "x-forwarded-for",
      "cookie",
    ]) {
      assert.equal(isInternalRelayRequestHeader(header), true, header);
    }
    assert.equal(isInternalRelayRequestHeader("anthropic-beta"), false);
    assert.equal(isInternalRelayRequestHeader("originator"), false);
  });

  test("injects Claude OAuth while preserving native identity and beta headers", () => {
    const request = new Request(
      "https://example.test/api/stella/relay/v1/messages",
      {
        method: "POST",
        headers: {
          authorization: "Bearer scoped-turn-token",
          "x-stella-turn-token": "scoped-turn-token",
          "x-stella-llm-credential": "anthropic",
          "anthropic-beta": "effort-2025-11-24",
          "anthropic-version": "2023-06-01",
          "user-agent": "claude-cli/current",
          "x-app": "cli",
          "cf-connecting-ip": "192.0.2.1",
        },
      },
    );
    const headers = connectedCredentialForwardHeaders(
      request,
      authorizedRequest("anthropic").userCredential!,
    );
    assert.equal(headers.get("authorization"), "Bearer anthropic-oauth");
    assert.equal(headers.get("x-stella-turn-token"), null);
    assert.equal(headers.get("cf-connecting-ip"), null);
    assert.equal(headers.get("user-agent"), "claude-cli/current");
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    const betas = new Set(
      headers
        .get("anthropic-beta")!
        .split(",")
        .map((value) => value.trim()),
    );
    assert.equal(betas.has("effort-2025-11-24"), true);
    assert.equal(betas.has("claude-code-20250219"), true);
    assert.equal(betas.has("oauth-2025-04-20"), true);
  });

  test("injects Codex OAuth/account identity and preserves native client headers", () => {
    const request = new Request(
      "https://example.test/api/stella/relay/responses",
      {
        method: "POST",
        headers: {
          authorization: "Bearer scoped-turn-token",
          "x-stella-turn-token": "scoped-turn-token",
          "x-stella-llm-credential": "openai-codex",
          "chatgpt-account-id": "sandbox-supplied-account",
          originator: "chatgpt_cca",
          "user-agent": "chatgpt_cca/current (Linux)",
          "x-client-request-id": "request-123",
        },
      },
    );
    const headers = connectedCredentialForwardHeaders(
      request,
      authorizedRequest("openai-codex").userCredential!,
    );
    assert.equal(headers.get("authorization"), "Bearer codex-oauth");
    assert.equal(headers.get("chatgpt-account-id"), "account-123");
    assert.equal(headers.get("originator"), "chatgpt_cca");
    assert.equal(headers.get("user-agent"), "chatgpt_cca/current (Linux)");
    assert.equal(headers.get("x-client-request-id"), "request-123");
    assert.equal(headers.get("x-stella-llm-credential"), null);
  });

  test("preserves native bodies and routes Codex/Claude utility paths", () => {
    const claude = authorizedRequest("anthropic");
    const claudeBody = JSON.parse(nativeCredentialBody(claude)) as {
      system: Array<{ text: string }>;
      output_config: { effort: string };
      thinking: { type: string };
    };
    assert.equal(claudeBody.system[0]?.text, "native prompt");
    assert.equal(claudeBody.output_config.effort, "high");
    assert.equal(claudeBody.thinking.type, "adaptive");
    assert.equal(
      connectedCredentialUpstreamUrl(
        claude,
        new Request(
          "https://example.test/api/stella/relay/v1/messages/count_tokens",
        ),
        "https://api.anthropic.com/v1",
      ),
      "https://api.anthropic.com/v1/messages/count_tokens",
    );

    const codex = authorizedRequest("openai-codex");
    const codexBody = JSON.parse(nativeCredentialBody(codex)) as {
      stream_options: { reasoning_summary_delivery: string };
      store: boolean;
    };
    assert.equal(
      codexBody.stream_options.reasoning_summary_delivery,
      "sequential_cutoff",
    );
    assert.equal(codexBody.store, false);
    assert.equal(
      connectedCredentialUpstreamUrl(
        codex,
        new Request("https://example.test/api/stella/relay/responses/compact"),
        "https://api.anthropic.com/v1",
      ),
      "https://chatgpt.com/backend-api/codex/responses/compact",
    );
  });

  test("adds the Claude Code identity only for legacy Stella-shaped bodies", () => {
    const legacy = authorizedRequest("anthropic");
    legacy.userCredential = {
      ...legacy.userCredential!,
      injectClaudeCodeIdentity: true,
    };
    const body = JSON.parse(nativeCredentialBody(legacy)) as {
      system: Array<{ text: string }>;
    };
    assert.equal(
      body.system[0]?.text,
      "You are Claude Code, Anthropic's official CLI for Claude.",
    );
    assert.equal(body.system[1]?.text, "native prompt");
  });
});
