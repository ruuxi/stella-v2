/** Slack-side messages and views: the connect prompt and the App Home tab. */

import { slackTry } from "./api.js";
import { SLACK_PATHS, slackPublicOrigin } from "./config.js";
import { signLinkToken } from "./link-state.js";
import type { SlackInstallation } from "./store.js";

export const connectUrl = async (
  env: Cloudflare.Env,
  teamId: string,
  slackUserId: string,
): Promise<string> =>
  `${slackPublicOrigin(env)}${SLACK_PATHS.link}?s=${encodeURIComponent(await signLinkToken(env, { teamId, slackUserId }))}`;

export const connectBlocks = (url: string, lead: string): unknown[] => [
  { type: "section", text: { type: "mrkdwn", text: lead } },
  {
    type: "actions",
    elements: [
      {
        type: "button",
        style: "primary",
        action_id: "stella_connect",
        text: { type: "plain_text", text: "Connect Stella" },
        url,
      },
    ],
  },
  {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "Stella works on your own Stella account, so she can use your memory and connected apps. The link is yours alone and expires in 30 minutes.",
      },
    ],
  },
];

const CONNECT_LEAD =
  "*Connect your Stella account to use Stella here.* It takes a few seconds.";

/** The connect button, privately: ephemeral in a channel, a DM in a DM. */
export const sendConnectPrompt = async (
  env: Cloudflare.Env,
  install: SlackInstallation,
  args: {
    channelId: string;
    slackUserId: string;
    threadTs?: string;
    isDm: boolean;
  },
): Promise<void> => {
  const url = await connectUrl(env, install.teamId, args.slackUserId);
  const blocks = connectBlocks(url, CONNECT_LEAD);
  const text = "Connect your Stella account to use Stella here.";
  if (args.isDm) {
    await slackTry(install.botToken, "chat.postMessage", {
      channel: args.channelId,
      text,
      blocks,
    });
    return;
  }
  await slackTry(install.botToken, "chat.postEphemeral", {
    channel: args.channelId,
    user: args.slackUserId,
    text,
    blocks,
    ...(args.threadTs ? { thread_ts: args.threadTs } : {}),
  });
};

export const publishHome = async (
  env: Cloudflare.Env,
  install: SlackInstallation,
  slackUserId: string,
  linked: boolean,
): Promise<void> => {
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: "Stella" } },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "Mention *@Stella* in a channel (invite her first with `/invite @Stella`) or message her here. She works on it with your Stella account, posts progress in the thread, and posts results when her background agents finish.",
      },
    },
    { type: "divider" },
  ];
  if (linked) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: ":white_check_mark: Your Stella account is connected. Use `/stella disconnect` to disconnect it.",
      },
    });
  } else {
    blocks.push(
      ...connectBlocks(
        await connectUrl(env, install.teamId, slackUserId),
        CONNECT_LEAD,
      ),
    );
  }
  await slackTry(install.botToken, "views.publish", {
    user_id: slackUserId,
    view: { type: "home", blocks },
  });
};
