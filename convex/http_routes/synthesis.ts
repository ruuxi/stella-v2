import type { HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { MANAGED_GATEWAY } from "../agent/model";
import type { ActionCtx } from "../_generated/server";
import { resolveModelConfig } from "../agent/model_resolver";
import {
  buildCategoryAnalysisUserMessage,
  buildCoreSynthesisUserMessage,
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
  resolveManagedModelAccess,
  scheduleManagedUsage,
} from "../lib/managed_billing";
import {
  assistantText,
  completeManagedChat,
  type ManagedModelConfig,
  usageSummaryFromAssistant,
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
  coreMemory?: string;
};

type SynthesizeResponse = {
  coreMemory: string;
  welcomeMessage: string;
  welcomeHtml?: string;
  categoryAnalyses?: Record<string, string>;
};

type WelcomeHtmlResponse = {
  welcomeHtml: string;
};

const DEFAULT_WELCOME_MESSAGE =
  "Hey! I'm Stella, your AI assistant. What can I help you with today?";

const WELCOME_HTML_MODEL_CONFIG: ManagedModelConfig = {
  model: "google/gemini-3-flash-preview",
  managedGatewayProvider: "google",
  temperature: 1.0,
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
  if (htmlIndex >= 0) return `<!doctype html>\n${stripped.slice(htmlIndex).trim()}`;
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

const generateWelcomeHtml = async (
  ctx: Pick<ActionCtx, "scheduler">,
  coreMemory: string,
  billingOwnerId?: string,
): Promise<{ welcomeHtml: string; durationMs: number }> => {
  const welcomeHtmlStartedAt = Date.now();
  const welcomeHtmlResult = await completeManagedChat({
    config: WELCOME_HTML_MODEL_CONFIG,
    context: {
      systemPrompt: [
        "You generate final HTML documents.",
        "Return only the final HTML document.",
        "Do not include reasoning, analysis, summaries, markdown, or commentary.",
        "The first output characters must be <!doctype html>.",
      ].join(" "),
      messages: [{
        role: "user",
        content: [{
          type: "text",
          text: buildWelcomeHtmlPrompt(coreMemory),
        }],
        timestamp: Date.now(),
      }],
    },
  });
  const durationMs = Date.now() - welcomeHtmlStartedAt;

  if (billingOwnerId) {
    await scheduleManagedUsage(ctx, {
      ownerId: billingOwnerId,
      agentType: "service:synthesis:welcome_html",
      model: WELCOME_HTML_MODEL_CONFIG.model,
      durationMs,
      success: true,
      usage: usageSummaryFromAssistant(welcomeHtmlResult),
    });
  }

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
) => [
  identity?.tokenIdentifier ?? anonDeviceId ?? "anon",
  getClientAddressKey(request) ?? "unknown",
].join(":");

export const registerSynthesisRoutes = (http: HttpRouter) => {
  registerCorsOptions(http, ["/api/synthesize", "/api/synthesize/welcome-html"]);

  http.route({
    path: "/api/synthesize",
    method: "POST",
    handler: httpAction(async (ctx, request) =>
      handleCorsRequest(request, async (origin) => {
        const identity = await ctx.auth.getUserIdentity();
        const anonDeviceId = getAnonDeviceId(request);
        if (!identity && !anonDeviceId) {
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
          return errorResponse(400, "formattedSections or formattedSignals is required", origin);
        }

        const coreMemorySystemPrompt = body.coreMemorySystemPrompt?.trim();
        const coreMemoryUserPromptTemplate = body.coreMemoryUserPromptTemplate?.trim();
        const welcomeMessagePromptTemplate = body.welcomeMessagePromptTemplate?.trim();
        if (
          !coreMemorySystemPrompt ||
          !coreMemoryUserPromptTemplate ||
          !welcomeMessagePromptTemplate
        ) {
          return errorResponse(400, "Missing synthesis prompt payload", origin);
        }

        const categoryAnalysisSystemPrompts = body.categoryAnalysisSystemPrompts;
        const categoryAnalysisUserPromptTemplate = body.categoryAnalysisUserPromptTemplate?.trim();

        const apiKey = process.env[MANAGED_GATEWAY.apiKeyEnvVar];
        if (!apiKey) {
          console.error(`[synthesize] Missing ${MANAGED_GATEWAY.apiKeyEnvVar} environment variable`);
          return errorResponse(500, "Server configuration error", origin);
        }

        try {
          const ownerId = identity?.tokenIdentifier;
          const isAnonymousIdentity =
            (identity as Record<string, unknown> | null)?.isAnonymous === true;
          const modelAccess = ownerId && !isAnonymousIdentity
            ? await resolveManagedModelAccess(ctx, ownerId, {
              isAnonymous: false,
            })
            : undefined;

          if (isAnonymousIdentity || (!identity && anonDeviceId)) {
            const rateLimit = await consumeWebhookRateLimit(ctx, {
              scope: "synthesize_anonymous",
              key: buildAnonymousSynthesisRateKey(identity, anonDeviceId, request),
              limit: ANON_SYNTHESIS_RATE_LIMIT,
              windowMs: ANON_SYNTHESIS_RATE_WINDOW_MS,
              blockMs: ANON_SYNTHESIS_RATE_WINDOW_MS,
            });
            if (!rateLimit.allowed) {
              return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
            }
          }

          const usageBlocked =
            modelAccess
            && !modelAccess.allowed
            && !modelAccess.unlimited;
          if (usageBlocked) {
            return errorResponse(429, modelAccess.message, origin);
          }

          if (
            ownerId
            && !isAnonymousIdentity
            && modelAccess
            && !modelAccess.unlimited
          ) {
            const rateLimit = await consumeWebhookRateLimit(ctx, {
              scope: "synthesize_owner",
              key: ownerId,
              limit: SYNTHESIS_OWNER_RATE_LIMIT,
              windowMs: SYNTHESIS_OWNER_RATE_WINDOW_MS,
              blockMs: SYNTHESIS_OWNER_RATE_WINDOW_MS,
            });
            if (!rateLimit.allowed) {
              return withCors(rateLimitResponse(rateLimit.retryAfterMs), origin);
            }
          }

          const billingOwnerId = ownerId && !isAnonymousIdentity ? ownerId : undefined;
          const synthesisConfig = await resolveModelConfig(ctx, "synthesis", billingOwnerId, {
            access: modelAccess,
            audience: billingOwnerId ? undefined : "anonymous",
          });

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

                const startedAt = Date.now();
                const message = await completeManagedChat({
                  config: {
                    ...synthesisConfig,
                    maxOutputTokens: 30000,
                  },
                  context: {
                    systemPrompt,
                    messages: [{
                      role: "user",
                      content: [{
                        type: "text",
                        text: buildCategoryAnalysisUserMessage(
                          category,
                          sections[category],
                          categoryAnalysisUserPromptTemplate,
                        ),
                      }],
                      timestamp: Date.now(),
                    }],
                  },
                });
                const analysis = assistantText(message);
                const durationMs = Date.now() - startedAt;

                return {
                  category,
                  analysis,
                  durationMs,
                  usage: usageSummaryFromAssistant(message),
                  generated: true,
                };
              }),
            );

            if (billingOwnerId) {
              await Promise.all(
                analysisResults
                  .filter((result) => result.generated)
                  .map((result) =>
                    scheduleManagedUsage(ctx, {
                      ownerId: billingOwnerId,
                      agentType: "service:synthesis:category_analysis",
                      model: synthesisConfig.model,
                      durationMs: result.durationMs,
                      success: true,
                      usage: result.usage,
                    })),
              );
            }

            const filteredResults = analysisResults
              .filter((result) => result.analysis.length > 0);

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
          const synthesisMessage = await completeManagedChat({
            config: synthesisConfig,
            context: {
              systemPrompt: coreMemorySystemPrompt,
              messages: [{
                role: "user",
                content: [{
                  type: "text",
                  text: buildCoreSynthesisUserMessage(
                    synthesisInput,
                    coreMemoryUserPromptTemplate,
                  ),
                }],
                timestamp: Date.now(),
              }],
            },
          });

          if (billingOwnerId) {
            await scheduleManagedUsage(ctx, {
              ownerId: billingOwnerId,
              agentType: "service:synthesis:core_memory",
              model: synthesisConfig.model,
              durationMs: Date.now() - coreSynthesisStartedAt,
              success: true,
              usage: usageSummaryFromAssistant(synthesisMessage),
            });
          }

          const coreMemory = assistantText(synthesisMessage);
          if (!coreMemory) {
            return errorResponse(500, "Failed to synthesize core memory", origin);
          }
          console.log(
            `[synthesize] Core memory synthesis complete in ${Date.now() - coreSynthesisStartedAt}ms. Output length: ${coreMemory.length} chars`,
          );

          const welcomeConfig = await resolveModelConfig(ctx, "welcome", billingOwnerId, {
            access: modelAccess,
            audience: billingOwnerId ? undefined : "anonymous",
          });
          const includeWelcomeHtml = body.includeWelcomeHtml !== false;
          console.log(
            includeWelcomeHtml
              ? "[synthesize] Welcome message and HTML starting"
              : "[synthesize] Welcome message starting",
          );
          const welcomeStartedAt = Date.now();
          const welcomePromise = completeManagedChat({
            config: welcomeConfig,
            context: {
              messages: [{
                role: "user",
                content: [{
                  type: "text",
                  text: buildWelcomeMessagePrompt(
                    coreMemory,
                    welcomeMessagePromptTemplate,
                  ),
                }],
                timestamp: Date.now(),
              }],
            },
          }).then((result) => ({
            result,
            durationMs: Date.now() - welcomeStartedAt,
          }));
          const [welcomeResult, welcomeHtmlResult] = await Promise.all([
            welcomePromise,
            includeWelcomeHtml
              ? generateWelcomeHtml(ctx, coreMemory, billingOwnerId).catch((error) => {
                console.error("[synthesize] Welcome HTML output was not usable.", error);
                throw error;
              })
              : Promise.resolve(null),
          ]);
          console.log(
            includeWelcomeHtml && welcomeHtmlResult
              ? `[synthesize] Welcome message / HTML complete. welcome: ${welcomeResult.durationMs}ms, html: ${welcomeHtmlResult.durationMs}ms`
              : `[synthesize] Welcome message complete in ${welcomeResult.durationMs}ms`,
          );

          if (billingOwnerId) {
            await scheduleManagedUsage(ctx, {
              ownerId: billingOwnerId,
              agentType: "service:synthesis:welcome_message",
              model: welcomeConfig.model,
              durationMs: welcomeResult.durationMs,
              success: true,
              usage: usageSummaryFromAssistant(welcomeResult.result),
            });

          }

          const response: SynthesizeResponse = {
            coreMemory,
            welcomeMessage: assistantText(welcomeResult.result) || DEFAULT_WELCOME_MESSAGE,
            ...(welcomeHtmlResult ? { welcomeHtml: welcomeHtmlResult.welcomeHtml } : {}),
            ...(Object.keys(categoryAnalysesMap).length > 0
              ? { categoryAnalyses: categoryAnalysesMap }
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
        if (!identity && !anonDeviceId) {
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
          const ownerId = identity?.tokenIdentifier;
          const isAnonymousIdentity =
            (identity as Record<string, unknown> | null)?.isAnonymous === true;
          const billingOwnerId = ownerId && !isAnonymousIdentity ? ownerId : undefined;
          const result = await generateWelcomeHtml(ctx, coreMemory, billingOwnerId);
          console.log(
            `[synthesize] Welcome HTML complete in ${result.durationMs}ms`,
          );
          const response: WelcomeHtmlResponse = {
            welcomeHtml: result.welcomeHtml,
          };
          return jsonResponse(response, 200, origin);
        } catch (error) {
          console.error("[synthesize] Welcome HTML error:", error);
          return errorResponse(500, "Failed to synthesize welcome HTML", origin);
        }
      }),
    ),
  });
};
