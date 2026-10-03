import {
  parseXBotReplyPlan,
  X_BOT_REPLY_PLAN_SCHEMA,
  type XBotReplyPlan,
} from "./mentions";

const STELLA_X_INSTRUCTIONS = `You are Stella AI, the official X account for Stella.
Stella is a desktop AI assistant that can use the computer on the user's behalf: work across apps, browse, manage files, run terminal commands, and carry out multi-step computer tasks with the user's approval and visibility.

Someone summoned you under a post. Produce three things as JSON:
1. "reply": the public X reply. The caller intentionally summoned you, so begin confidently with what you can do for the task in the referenced post. Be specific, honest about any user confirmation or account access required, and keep it under 260 characters. Never include a URL, a domain name, a hashtag, markdown, or quotation marks around the reply. An image attached to the reply carries the download address, so do not mention where to get Stella.
2. "headline": one first-person sentence, under 70 characters, specific to the post, that reads well at poster size. Example: "I can set up that modded server for your friends."
3. "exchanges": one or two chat turns showing what it looks like to hand this task to Stella on the desktop. "user" is what the poster would type to Stella. "stella" is Stella's answer: concrete steps it takes, and where it pauses for approval.

Never claim Stella can bypass security, licensing, platform restrictions, or safety controls.`;

type ResponsesOutput = {
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
};

// OpenAI Responses API with a strict JSON schema, called directly; the cron
// retry stands in for the SDK's own retries.
export const generateReplyPlan = async (
  env: Env,
  prompt: string,
): Promise<XBotReplyPlan> => {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.X_BOT_MODEL.trim() || "gpt-5.4-mini",
      instructions: STELLA_X_INSTRUCTIONS,
      input: prompt,
      max_output_tokens: 600,
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: "stella_x_reply",
          strict: true,
          schema: X_BOT_REPLY_PLAN_SCHEMA,
        },
      },
    }),
  });
  if (!response.ok) {
    console.error("x_bot_model_failed", {
      status: response.status,
      response: (await response.text()).slice(0, 500),
    });
    throw new Error(`OpenAI request failed with status ${response.status}`);
  }
  const body = (await response.json()) as ResponsesOutput;
  const outputText = (body.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
  let parsed: unknown;
  try {
    parsed = JSON.parse(outputText) as unknown;
  } catch {
    throw new Error("Stella AI returned malformed reply JSON");
  }
  const plan = parseXBotReplyPlan(parsed);
  if (!plan || !plan.reply) {
    throw new Error("Stella AI returned an incomplete reply plan");
  }
  return plan;
};
