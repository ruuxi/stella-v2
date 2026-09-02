import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { MANAGED_GATEWAY } from "../agent/model";
import type { ActionCtx } from "../_generated/server";
import { resolveModelConfig } from "../agent/model_resolver";
import {
  buildCategoryAnalysisUserMessage,
  buildCoreSynthesisUserMessage,
  buildOnboardingStartersPrompt,
  buildWelcomeHtmlPrompt,
  buildWelcomeMessagePrompt,
} from "../prompts/index";
import {
  errorResponse,
  handleCorsRequest,
  jsonResponse,
  registerCorsOptions,
  withCors,
} from "../http_shared/cors";
import {
  consumeWebhookRateLimit,
  rateLimitResponse,
} from "../http_shared/webhook_controls";
import { getAnonDeviceId } from "../http_shared/anon_device";
import { getClientAddressKey } from "../lib/http_utils";
import {
  assertManagedUsageDispatchAllowed,
  createManagedUsageDispatchGuard,
  resolveManagedModelAccess,
} from "../lib/managed_billing";
import {
  createManagedDispatchRequestFingerprint,
  estimateManagedModelFallbackCostMicroCents,
} from "../lib/managed_dispatch";
import {
  assistantText,
  completeManagedChat,
  type ManagedModelConfig,
  type ManagedModelBillingContext,
} from "../runtime_ai/managed";

type SynthesizeRequest = {
  /** @deprecated Use formattedSections instead */
  formattedSignals?: string;
  formattedSections?: Record<string, string>;
  /** Per-category system prompts keyed by category ID */
  categoryAnalysisSystemPrompts?: Record<string, string>;
  categoryAnalysisUserPromptTemplate?: string;
  coreMemorySystemPrompt?: string;
  coreMemoryUserPromptTemplate?: string;
  welcomeMessagePromptTemplate?: string;
  includeWelcomeHtml?: boolean;
  /**
   * Also produce the chat-onboarding finale payload: a few short profile
   * highlights plus personalized starter prompts. Opt-in so the legacy
   * onboarding flow keeps its request shape and model spend unchanged.
   */
  includeStarters?: boolean;
  coreMemory?: string;
};

type OnboardingStarter = { title: string; prompt: string };

type SynthesizeResponse = {
  coreMemory: string;
  welcomeMessage: string;
  welcomeHtml?: string;
  categoryAnalyses?: Record<string, string>;
  profileHighlights?: string[];
  starters?: OnboardingStarter[];
};

type WelcomeHtmlResponse = {
  welcomeHtml: string;
};

const DEFAULT_WELCOME_MESSAGE =
  "Hey! I'm Stella, your AI assistant. What can I help you with today?";

const WELCOME_HTML_MODEL_CONFIG: ManagedModelConfig = {
  model: "google/gemini-3.6-flash",
  managedGatewayProvider: "google",
  maxOutputTokens: 32768,
  providerOptions: {
    gateway: {
      order: ["google"],
    },
  },
  modalitiesInput: ["text"],
};

const stripMarkdownHtmlFence = (value: string): string =>
  value
    .trim()
    .replace(/^```(?:html)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

const normalizeWelcomeHtml = (value: string): string => {
  const stripped = stripMarkdownHtmlFence(value);
  const doctypeIndex = stripped.toLowerCase().indexOf("<!doctype html");
  if (doctypeIndex >= 0) return stripped.slice(doctypeIndex).trim();
  const htmlIndex = stripped.toLowerCase().indexOf("<html");
  if (htmlIndex >= 0)
    return `<!doctype html>\n${stripped.slice(htmlIndex).trim()}`;
  return stripped;
};

const isUsableWelcomeHtml = (value: string): boolean => {
  const lower = value.toLowerCase();
  return (
    lower.includes("<!doctype html") &&
    lower.includes("<html") &&
    lower.includes("</html>") &&
    lower.includes("data-stella-compose")
  );
};

const MAX_PROFILE_HIGHLIGHTS = 5;
const MAX_STARTERS = 4;

const trimToLength = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max).trim() : trimmed;
};

/**
 * Parses the finale JSON the starters prompt asks for. The model is told to
 * return only JSON, but a code fence or a sentence of preamble still slips
 * through now and then; the parser tolerates both and never throws — a bad
 * output simply means the finale falls back to its generic starters.
 */
const parseOnboardingStartersOutput = (
  raw: string,
): { profileHighlights: string[]; starters: OnboardingStarter[] } | null => {
  const stripped = stripMarkdownHtmlFence(raw)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const profileHighlights = Array.isArray(record.highlights)
    ? record.highlights
        .map((entry) => trimToLength(entry, 48))
        .filter((entry): entry is string => Boolean(entry))
        .slice(0, MAX_PROFILE_HIGHLIGHTS)
    : [];
  const starters = Array.isArray(record.starters)
    ? record.starters
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const item = entry as Record<string, unknown>;
          const title = trimToLength(item.title, 60);
          const prompt = trimToLength(item.prompt, 280);
          return title && prompt ? { title, prompt } : null;
        })
        .filter((entry): entry is OnboardingStarter => Boolean(entry))
        .slice(0, MAX_STARTERS)
    : [];
  if (profileHighlights.length === 0 && starters.length === 0) return null;
  return { profileHighlights, starters };
};

const createSynthesisDispatchGuard = (
  ctx: Pick<ActionCtx, "runMutation">,
  fence: { ownerId: string; ownerGeneration: string },
) =>
  createManagedUsageDispatchGuard(ctx, {
    ownerId: fence.ownerId,
    ownerGeneration: fence.ownerGeneration,
  });

const conservativeTextInputTokens = (...parts: string[]): number =>
  Math.max(1, new TextEncoder().encode(parts.join("\n")).byteLength);

const createSynthesisModelBilling = async (args: {
  namespace: string;
  stableRequestKey: string;
  agentType: string;
  config: ManagedModelConfig;
  inputParts: string[];
}): Promise<ManagedModelBillingContext> => ({
  requestFingerprint: await createManagedDispatchRequestFingerprint(
    args.namespace,
    args.stableRequestKey,
  ),
  agentType: args.agentType,
  fallbackCostMicroCents: estimateManagedModelFallbackCostMicroCents({
    model: args.config.model,
    inputTokens: conservativeTextInputTokens(...args.inputParts),
    maxOutputTokens: args.config.maxOutputTokens ?? 32_768,
  }),
});

const generateWelcomeHtml = async (
  ctx: Pick<ActionCtx, "runMutation">,
  coreMemory: string,
  fence: {
    ownerId: string;
    ownerGeneration: string;
  },
): Promise<{ welcomeHtml: string; durationMs: number }> => {
  const welcomeHtmlStartedAt = Date.now();
  await assertManagedUsageDispatchAllowed(ctx, {
    ownerId: fence.ownerId,
    ownerGeneration: fence.ownerGeneration,
  });
  const systemPrompt = [
    "You generate final HTML documents.",
    "Return only the final HTML document.",
    "Do not include reasoning, analysis, summaries, markdown, or commentary.",
    "The first output characters must be <!doctype html>.",
  ].join(" ");
  const userPrompt = buildWelcomeHtmlPrompt(coreMemory);
  const welcomeHtmlResult = await completeManagedChat({
    config: WELCOME_HTML_MODEL_CONFIG,
    dispatchGuard: createSynthesisDispatchGuard(ctx, fence),
    billing: await createSynthesisModelBilling({
      namespace: "synthesis-welcome-html",
      stableRequestKey: `${fence.ownerId}\0${fence.ownerGeneration}\0${coreMemory}`,
      agentType: "service:synthesis:welcome_html",
      config: WELCOME_HTML_MODEL_CONFIG,
      inputParts: [systemPrompt, userPrompt],
    }),
    context: {
      systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: userPrompt,
            },
          ],
          timestamp: Date.now(),
        },
      ],
    },
  });
  const durationMs = Date.now() - welcomeHtmlStartedAt;

  const welcomeHtml = normalizeWelcomeHtml(assistantText(welcomeHtmlResult));
  if (!isUsableWelcomeHtml(welcomeHtml)) {
    throw new Error("Welcome HTML output was not usable.");
  }

  return { welcomeHtml, durationMs };
};
/**
 * Anonymous onboarding synthesis is allowed before sign-in so Stella can build
 * first-run memory, the welcome message, and app recommendations.
 */
const ANON_SYNTHESIS_RATE_LIMIT = 6;
const ANON_SYNTHESIS_RATE_WINDOW_MS = 60 * 60_000;
/**
 * Per-authenticated-owner cap on the same endpoint. Same rationale —
 * synthesis is one of the most expensive LLM endpoints in the stack, so
 * even a paid user shouldn't be able to fire dozens of jobs in a minute.
 */
const SYNTHESIS_OWNER_RATE_LIMIT = 10;
const SYNTHESIS_OWNER_RATE_WINDOW_MS = 60_000;

const buildAnonymousSynthesisRateKey = (
  identity: { tokenIdentifier?: string } | null,
  anonDeviceId: string | null,
  request: Request,
) =>
  [
    identity?.tokenIdentifier ?? anonDeviceId ?? "anon",
    getClientAddressKey(request) ?? "unknown",
  ].join(":");

export const registerSynthesisRoutes = (http: HttpRouter) => {
  registerCorsOptions(http, [
    "/api/synthesize",
    "/api/synthesize/welcome-html",
  ]);

  http.route({
    path: "/api/synthesize",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        const anonDeviceId = getAnonDeviceId(request);
        // A device header is only telemetry/rate-limit context. Managed model
        // spend requires a real principal so lifecycle generation and durable
        // provider-attempt authority can be enforced.
        if (!identity) {
          return errorResponse(401, "Unauthorized", origin);
        }

        let body: SynthesizeRequest | null = null;
        try {
          body = (await request.json()) as SynthesizeRequest;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const hasFormattedSections =
          body?.formattedSections &&
          typeof body.formattedSections === "object" &&
          Object.keys(body.formattedSections).length > 0;
        const hasFormattedSignals =
          body?.formattedSignals && typeof body.formattedSignals === "string";

        if (!hasFormattedSections && !hasFormattedSignals) {
          return errorResponse(
            400,
            "formattedSections or formattedSignals is required",
            origin,
          );
        }

        const coreMemorySystemPrompt = body.coreMemorySystemPrompt?.trim();
        const coreMemoryUserPromptTemplate =
          body.coreMemoryUserPromptTemplate?.trim();
        const welcomeMessagePromptTemplate =
          body.welcomeMessagePromptTemplate?.trim();
        if (
          !coreMemorySystemPrompt ||
          !coreMemoryUserPromptTemplate ||
          !welcomeMessagePromptTemplate
        ) {
          return errorResponse(400, "Missing synthesis prompt payload", origin);
        }

        const categoryAnalysisSystemPrompts =
          body.categoryAnalysisSystemPrompts;
        const categoryAnalysisUserPromptTemplate =
          body.categoryAnalysisUserPromptTemplate?.trim();

        const apiKey = process.env[MANAGED_GATEWAY.apiKeyEnvVar];
        if (!apiKey) {
          console.error(
            `[synthesize] Missing ${MANAGED_GATEWAY.apiKeyEnvVar} environment variable`,
          );
          return errorResponse(500, "Server configuration error", origin);
        }

        try {
          const ownerId = identity.tokenIdentifier;
          const isAnonymousIdentity =
            (identity as Record<string, unknown>).isAnonymous === true;
          const modelAccess = await resolveManagedModelAccess(ctx, ownerId, {
            isAnonymous: isAnonymousIdentity,
          });

          if (isAnonymousIdentity) {
            const rateLimit = await consumeWebhookRateLimit(ctx, {
              scope: "synthesize_anonymous",
              key: buildAnonymousSynthesisRateKey(
                identity,
                anonDeviceId,
                request,
              ),
              limit: ANON_SYNTHESIS_RATE_LIMIT,
              windowMs: ANON_SYNTHESIS_RATE_WINDOW_MS,
              blockMs: ANON_SYNTHESIS_RATE_WINDOW_MS,
            });
            if (!rateLimit.allowed) {
              return withCors(
                rateLimitResponse(rateLimit.retryAfterMs),
                origin,
              );
            }
          }

          const usageBlocked = !modelAccess.allowed && !modelAccess.unlimited;
          if (usageBlocked) {
            return errorResponse(429, modelAccess.message, origin);
          }

          if (!isAnonymousIdentity && !modelAccess.unlimited) {
            const rateLimit = await consumeWebhookRateLimit(ctx, {
              scope: "synthesize_owner",
              key: ownerId,
              limit: SYNTHESIS_OWNER_RATE_LIMIT,
              windowMs: SYNTHESIS_OWNER_RATE_WINDOW_MS,
              blockMs: SYNTHESIS_OWNER_RATE_WINDOW_MS,
            });
            if (!rateLimit.allowed) {
              return withCors(
                rateLimitResponse(rateLimit.retryAfterMs),
                origin,
              );
            }
          }

          // Better Auth anonymous users still have a real owner/generation and
          // consume Stella-paid managed capacity. Keep anonymous model routing
          // separate from billing attribution; every authenticated principal
          // receives an exact-attempt usage receipt.
          const modelOwnerId = !isAnonymousIdentity ? ownerId : undefined;
          const dispatchFence = {
            ownerId,
            ownerGeneration: modelAccess.ownerGeneration,
          };
          const assertDispatch = async () => {
            await assertManagedUsageDispatchAllowed(ctx, dispatchFence);
          };
          const synthesisConfig = await resolveModelConfig(
            ctx,
            "synthesis",
            modelOwnerId,
            {
              access: modelAccess,
              audience: isAnonymousIdentity ? "anonymous" : undefined,
            },
          );

          let synthesisInput: string;
          const categoryAnalysesMap: Record<string, string> = {};

          if (
            hasFormattedSections &&
            categoryAnalysisSystemPrompts &&
            Object.keys(categoryAnalysisSystemPrompts).length > 0 &&
            categoryAnalysisUserPromptTemplate
          ) {
            const sections = body.formattedSections!;
            const categoryKeys = Object.keys(sections).filter(
              (key) => sections[key] && sections[key].trim().length > 0,
            );

            console.log(
              `[synthesize] Running category analysis for ${categoryKeys.length} categories:`,
              categoryKeys,
            );

            const analysisResults = await Promise.all(
              categoryKeys.map(async (category) => {
                const systemPrompt = categoryAnalysisSystemPrompts[category];
                if (!systemPrompt) {
                  return {
                    category,
                    analysis: sections[category],
                    durationMs: 0,
                    usage: undefined,
                    generated: false,
                  };
                }

                const userPrompt = buildCategoryAnalysisUserMessage(
                  category,
                  sections[category],
                  categoryAnalysisUserPromptTemplate,
                );
                await assertDispatch();
                const categoryConfig = {
                  ...synthesisConfig,
                  maxOutputTokens: 30000,
                };
                const message = await completeManagedChat({
                  config: categoryConfig,
                  dispatchGuard: createSynthesisDispatchGuard(
                    ctx,
                    dispatchFence,
                  ),
                  billing: await createSynthesisModelBilling({
                    namespace: "synthesis-category",
                    stableRequestKey: `${ownerId}\0${modelAccess.ownerGeneration}\0${category}\0${systemPrompt}\0${userPrompt}`,
                    agentType: "service:synthesis:category_analysis",
                    config: categoryConfig,
                    inputParts: [systemPrompt, userPrompt],
                  }),
                  context: {
                    systemPrompt,
                    messages: [
                      {
                        role: "user",
                        content: [
                          {
                            type: "text",
                            text: userPrompt,
                          },
                        ],
                        timestamp: Date.now(),
                      },
                    ],
                  },
                });
                const analysis = assistantText(message);

                return {
                  category,
                  analysis,
                  generated: true,
                };
              }),
            );

            const filteredResults = analysisResults.filter(
              (result) => result.analysis.length > 0,
            );

            synthesisInput = filteredResults
              .map((result) => result.analysis)
              .join("\n\n");

            for (const result of filteredResults) {
              categoryAnalysesMap[result.category] = result.analysis;
            }

            console.log(
              `[synthesize] Category analyses complete. Combined length: ${synthesisInput.length} chars`,
            );
          } else {
            synthesisInput = body.formattedSignals!;
          }

          console.log(
            `[synthesize] Core memory synthesis starting. Input length: ${synthesisInput.length} chars`,
          );
          const coreSynthesisStartedAt = Date.now();
          const coreUserPrompt = buildCoreSynthesisUserMessage(
            synthesisInput,
            coreMemoryUserPromptTemplate,
          );
          await assertDispatch();
          const synthesisMessage = await completeManagedChat({
            config: synthesisConfig,
            dispatchGuard: createSynthesisDispatchGuard(ctx, dispatchFence),
            billing: await createSynthesisModelBilling({
              namespace: "synthesis-core-memory",
              stableRequestKey: `${ownerId}\0${modelAccess.ownerGeneration}\0${coreMemorySystemPrompt}\0${coreUserPrompt}`,
              agentType: "service:synthesis:core_memory",
              config: synthesisConfig,
              inputParts: [coreMemorySystemPrompt, coreUserPrompt],
            }),
            context: {
              systemPrompt: coreMemorySystemPrompt,
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: coreUserPrompt,
                    },
                  ],
                  timestamp: Date.now(),
                },
              ],
            },
          });

          const coreMemory = assistantText(synthesisMessage);
          if (!coreMemory) {
            return errorResponse(
              500,
              "Failed to synthesize core memory",
              origin,
            );
          }
          console.log(
            `[synthesize] Core memory synthesis complete in ${Date.now() - coreSynthesisStartedAt}ms. Output length: ${coreMemory.length} chars`,
          );

          const welcomeConfig = await resolveModelConfig(
            ctx,
            "welcome",
            modelOwnerId,
            {
              access: modelAccess,
              audience: isAnonymousIdentity ? "anonymous" : undefined,
            },
          );
          const includeWelcomeHtml = body.includeWelcomeHtml !== false;
          console.log(
            includeWelcomeHtml
              ? "[synthesize] Welcome message and HTML starting"
              : "[synthesize] Welcome message starting",
          );
          const welcomeStartedAt = Date.now();
          const welcomeUserPrompt = buildWelcomeMessagePrompt(
            coreMemory,
            welcomeMessagePromptTemplate,
          );
          const welcomePromise = (async () => {
            await assertDispatch();
            const result = await completeManagedChat({
              config: welcomeConfig,
              dispatchGuard: createSynthesisDispatchGuard(ctx, dispatchFence),
              billing: await createSynthesisModelBilling({
                namespace: "synthesis-welcome-message",
                stableRequestKey: `${ownerId}\0${modelAccess.ownerGeneration}\0${welcomeUserPrompt}`,
                agentType: "service:synthesis:welcome_message",
                config: welcomeConfig,
                inputParts: [welcomeUserPrompt],
              }),
              context: {
                messages: [
                  {
                    role: "user",
                    content: [
                      {
                        type: "text",
                        text: welcomeUserPrompt,
                      },
                    ],
                    timestamp: Date.now(),
                  },
                ],
              },
            });
            return {
              result,
              durationMs: Date.now() - welcomeStartedAt,
            };
          })();
          // The finale payload is best-effort: a failed or malformed starters
          // call never fails synthesis, because core memory and the welcome
          // greeting are the part the rest of the app depends on.
          const includeStarters = body.includeStarters === true;
          const startersPromise = includeStarters
            ? (async () => {
                const startersStartedAt = Date.now();
                try {
                  await assertDispatch();
                  const startersPrompt = buildOnboardingStartersPrompt(coreMemory);
                  const result = await completeManagedChat({
                    config: welcomeConfig,
                    dispatchGuard: createSynthesisDispatchGuard(
                      ctx,
                      dispatchFence,
                    ),
                    billing: await createSynthesisModelBilling({
                      namespace: "synthesis-onboarding-starters",
                      stableRequestKey: `${ownerId}\0${modelAccess.ownerGeneration}\0${startersPrompt}`,
                      agentType: "service:synthesis:onboarding_starters",
                      config: welcomeConfig,
                      inputParts: [startersPrompt],
                    }),
                    context: {
                      messages: [
                        {
                          role: "user",
                          content: [{ type: "text", text: startersPrompt }],
                          timestamp: Date.now(),
                        },
                      ],
                    },
                  });
                  const parsed = parseOnboardingStartersOutput(
                    assistantText(result),
                  );
                  console.log(
                    `[synthesize] Onboarding starters ${parsed ? "complete" : "unusable"} in ${Date.now() - startersStartedAt}ms`,
                  );
                  return parsed;
                } catch (error) {
                  console.error("[synthesize] Onboarding starters failed.", error);
                  return null;
                }
              })()
            : Promise.resolve(null);
          const [welcomeResult, welcomeHtmlResult, startersResult] =
            await Promise.all([
              welcomePromise,
              includeWelcomeHtml
                ? generateWelcomeHtml(ctx, coreMemory, dispatchFence).catch(
                    (error) => {
                      console.error(
                        "[synthesize] Welcome HTML output was not usable.",
                        error,
                      );
                      throw error;
                    },
                  )
                : Promise.resolve(null),
              startersPromise,
            ]);
          console.log(
            includeWelcomeHtml && welcomeHtmlResult
              ? `[synthesize] Welcome message / HTML complete. welcome: ${welcomeResult.durationMs}ms, html: ${welcomeHtmlResult.durationMs}ms`
              : `[synthesize] Welcome message complete in ${welcomeResult.durationMs}ms`,
          );

          const response: SynthesizeResponse = {
            coreMemory,
            welcomeMessage:
              assistantText(welcomeResult.result) || DEFAULT_WELCOME_MESSAGE,
            ...(welcomeHtmlResult
              ? { welcomeHtml: welcomeHtmlResult.welcomeHtml }
              : {}),
            ...(Object.keys(categoryAnalysesMap).length > 0
              ? { categoryAnalyses: categoryAnalysesMap }
              : {}),
            ...(startersResult
              ? {
                  profileHighlights: startersResult.profileHighlights,
                  starters: startersResult.starters,
                }
              : {}),
          };

          return jsonResponse(response, 200, origin);
        } catch (error) {
          console.error("[synthesize] Error:", error);
          return errorResponse(500, "Synthesis failed", origin);
        }
      }),
    ),
  });

  http.route({
    path: "/api/synthesize/welcome-html",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        const anonDeviceId = getAnonDeviceId(request);
        // Keep the legacy device header non-authoritative: no principal means
        // no managed provider request.
        if (!identity) {
          return errorResponse(401, "Unauthorized", origin);
        }

        let body: SynthesizeRequest | null = null;
        try {
          body = (await request.json()) as SynthesizeRequest;
        } catch {
          return errorResponse(400, "Invalid JSON body", origin);
        }

        const coreMemory = body.coreMemory?.trim();
        if (!coreMemory) {
          return errorResponse(400, "coreMemory is required", origin);
        }

        try {
          const ownerId = identity.tokenIdentifier;
          const isAnonymousIdentity =
            (identity as Record<string, unknown>).isAnonymous === true;
          const modelAccess = await resolveManagedModelAccess(ctx, ownerId, {
            isAnonymous: isAnonymousIdentity,
          });

          if (isAnonymousIdentity) {
            const rateLimit = await consumeWebhookRateLimit(ctx, {
              scope: "synthesize_anonymous",
              key: buildAnonymousSynthesisRateKey(
                identity,
                anonDeviceId,
                request,
              ),
              limit: ANON_SYNTHESIS_RATE_LIMIT,
              windowMs: ANON_SYNTHESIS_RATE_WINDOW_MS,
              blockMs: ANON_SYNTHESIS_RATE_WINDOW_MS,
            });
            if (!rateLimit.allowed) {
              return withCors(
                rateLimitResponse(rateLimit.retryAfterMs),
                origin,
              );
            }
          }

          if (!modelAccess.allowed && !modelAccess.unlimited) {
            return errorResponse(429, modelAccess.message, origin);
          }

          if (!isAnonymousIdentity && !modelAccess.unlimited) {
            const rateLimit = await consumeWebhookRateLimit(ctx, {
              scope: "synthesize_owner",
              key: ownerId,
              limit: SYNTHESIS_OWNER_RATE_LIMIT,
              windowMs: SYNTHESIS_OWNER_RATE_WINDOW_MS,
              blockMs: SYNTHESIS_OWNER_RATE_WINDOW_MS,
            });
            if (!rateLimit.allowed) {
              return withCors(
                rateLimitResponse(rateLimit.retryAfterMs),
                origin,
              );
            }
          }

          const dispatchFence = {
            ownerId,
            ownerGeneration: modelAccess.ownerGeneration,
          };
          const result = await generateWelcomeHtml(
            ctx,
            coreMemory,
            dispatchFence,
          );
          console.log(
            `[synthesize] Welcome HTML complete in ${result.durationMs}ms`,
          );
          const response: WelcomeHtmlResponse = {
            welcomeHtml: result.welcomeHtml,
          };
          return jsonResponse(response, 200, origin);
        } catch (error) {
          console.error("[synthesize] Welcome HTML error:", error);
          return errorResponse(
            500,
            "Failed to synthesize welcome HTML",
            origin,
          );
        }
      }),
    ),
  });
};
