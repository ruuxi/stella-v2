import { ConnectorError } from "../errors";

export type SocialProviderRequest = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  bodyEncoding?: "json" | "form";
  headers?: Record<string, string>;
};

const stringInput = (
  input: Record<string, unknown>,
  ...keys: string[]
): string | undefined => {
  for (const key of keys) {
    if (typeof input[key] === "string" && input[key])
      return input[key] as string;
  }
  return undefined;
};

const requiredString = (
  input: Record<string, unknown>,
  ...keys: string[]
): string => {
  const value = stringInput(input, ...keys);
  if (!value) throw new ConnectorError("invalid_input");
  return value;
};

const withQuery = (
  path: string,
  input: Record<string, unknown>,
  keys: readonly string[],
): string => {
  const url = new URL(path, "https://request.invalid");
  for (const key of keys) {
    const value = input[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
};

export const SOCIAL_ACTION_OPERATIONS: Readonly<
  Record<string, Readonly<Record<string, "read" | "write">>>
> = {
  twitter: {
    TWITTER_USER_LOOKUP_ME: "read",
    TWITTER_CREATION_OF_A_POST: "write",
  },
  youtube: {
    YOUTUBE_LIST_USER_PLAYLISTS: "read",
    YOUTUBE_CREATE_PLAYLIST: "write",
  },
  reddit: {
    REDDIT_GET_ME_PREFS: "read",
    REDDIT_CREATE_REDDIT_POST: "write",
  },
  meta: {
    FACEBOOK_LIST_MANAGED_PAGES: "read",
    FACEBOOK_CREATE_POST: "write",
    INSTAGRAM_GET_USER_INFO: "read",
    INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH: "write",
    METAADS_GET_AD_ACCOUNTS: "read",
    METAADS_UPDATE_CAMPAIGN: "write",
  },
  linkedin: {
    LINKEDIN_GET_MY_INFO: "read",
    LINKEDIN_CREATE_LINKED_IN_POST: "write",
  },
};

export const SOCIAL_ACTION_REQUIRED_SCOPES: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  twitter: {
    TWITTER_USER_LOOKUP_ME: ["tweet.read", "users.read"],
    TWITTER_CREATION_OF_A_POST: ["tweet.read", "tweet.write", "users.read"],
  },
  youtube: {
    YOUTUBE_LIST_USER_PLAYLISTS: [
      "https://www.googleapis.com/auth/youtube.readonly",
    ],
    YOUTUBE_CREATE_PLAYLIST: [
      "https://www.googleapis.com/auth/youtube.force-ssl",
    ],
  },
  reddit: {
    REDDIT_GET_ME_PREFS: ["identity", "read"],
    REDDIT_CREATE_REDDIT_POST: ["submit"],
  },
  meta: {
    FACEBOOK_LIST_MANAGED_PAGES: ["pages_show_list"],
    FACEBOOK_CREATE_POST: ["pages_manage_posts"],
    INSTAGRAM_GET_USER_INFO: ["instagram_basic"],
    INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH: ["instagram_content_publish"],
    METAADS_GET_AD_ACCOUNTS: ["ads_read"],
    METAADS_UPDATE_CAMPAIGN: ["ads_management"],
  },
  linkedin: {
    LINKEDIN_GET_MY_INFO: ["openid", "profile"],
    LINKEDIN_CREATE_LINKED_IN_POST: ["w_member_social"],
  },
};

/** Exact public connector ids owned by each social provider action. */
export const SOCIAL_PROVIDER_CONNECTOR_ACTIONS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  twitter: {
    twitter: ["TWITTER_USER_LOOKUP_ME", "TWITTER_CREATION_OF_A_POST"],
  },
  youtube: {
    youtube: ["YOUTUBE_LIST_USER_PLAYLISTS", "YOUTUBE_CREATE_PLAYLIST"],
  },
  reddit: {
    reddit: ["REDDIT_GET_ME_PREFS", "REDDIT_CREATE_REDDIT_POST"],
  },
  meta: {
    facebook: ["FACEBOOK_LIST_MANAGED_PAGES", "FACEBOOK_CREATE_POST"],
    instagram: [
      "INSTAGRAM_GET_USER_INFO",
      "INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH",
    ],
    metaads: ["METAADS_GET_AD_ACCOUNTS", "METAADS_UPDATE_CAMPAIGN"],
  },
  linkedin: {
    linkedin: ["LINKEDIN_GET_MY_INFO", "LINKEDIN_CREATE_LINKED_IN_POST"],
  },
};

export const buildSocialProviderRequest = (
  providerKey: string,
  action: string,
  input: Record<string, unknown>,
): SocialProviderRequest | null => {
  switch (`${providerKey}:${action}`) {
    case "twitter:TWITTER_USER_LOOKUP_ME":
      return { method: "GET", path: "/2/users/me" };
    case "twitter:TWITTER_CREATION_OF_A_POST":
      return { method: "POST", path: "/2/tweets", body: input };

    case "youtube:YOUTUBE_LIST_USER_PLAYLISTS":
      return {
        method: "GET",
        path: withQuery("/youtube/v3/playlists?mine=true&part=snippet", input, [
          "part",
          "maxResults",
          "pageToken",
        ]),
      };
    case "youtube:YOUTUBE_CREATE_PLAYLIST":
      return {
        method: "POST",
        path: "/youtube/v3/playlists?part=snippet,status",
        body: {
          snippet: {
            title: requiredString(input, "title"),
            ...(typeof input.description === "string"
              ? { description: input.description }
              : {}),
          },
          ...(typeof input.privacyStatus === "string"
            ? { status: { privacyStatus: input.privacyStatus } }
            : {}),
        },
      };

    case "reddit:REDDIT_GET_ME_PREFS":
      return {
        method: "GET",
        path: withQuery("/api/v1/me/prefs", input, ["fields"]),
      };
    case "reddit:REDDIT_CREATE_REDDIT_POST":
      return {
        method: "POST",
        path: "/api/submit",
        bodyEncoding: "form",
        headers: { "user-agent": "Stella/1.0 by contact@fromyou.ai" },
        body: {
          api_type: "json",
          sr: requiredString(input, "subreddit", "sr"),
          title: requiredString(input, "title"),
          kind:
            stringInput(input, "kind") ??
            (typeof input.url === "string" ? "link" : "self"),
          ...(typeof input.text === "string" ? { text: input.text } : {}),
          ...(typeof input.url === "string" ? { url: input.url } : {}),
          ...(typeof input.flair_id === "string"
            ? { flair_id: input.flair_id }
            : {}),
        },
      };

    case "meta:FACEBOOK_LIST_MANAGED_PAGES":
      return { method: "GET", path: "/me/accounts" };
    case "meta:FACEBOOK_CREATE_POST": {
      const pageId = requiredString(input, "page_id", "pageId");
      const { page_id: _pageId, pageId: _pageIdCamel, ...body } = input;
      return {
        method: "POST",
        path: `/${encodeURIComponent(pageId)}/feed`,
        body,
      };
    }
    case "meta:INSTAGRAM_GET_USER_INFO": {
      const userId = requiredString(input, "ig_user_id", "igUserId", "user_id");
      return {
        method: "GET",
        path: `/${encodeURIComponent(userId)}?fields=id,username,followers_count,media_count`,
      };
    }
    case "meta:INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH": {
      const userId = requiredString(input, "ig_user_id", "igUserId");
      return {
        method: "POST",
        path: `/${encodeURIComponent(userId)}/media_publish`,
        body: { creation_id: requiredString(input, "creation_id") },
      };
    }
    case "meta:METAADS_GET_AD_ACCOUNTS":
      return { method: "GET", path: "/me/adaccounts" };
    case "meta:METAADS_UPDATE_CAMPAIGN": {
      const campaignId = requiredString(
        input,
        "campaign_id",
        "campaignId",
        "id",
      );
      const {
        campaign_id: _campaignId,
        campaignId: _campaignIdCamel,
        id: _id,
        ...body
      } = input;
      return {
        method: "POST",
        path: `/${encodeURIComponent(campaignId)}`,
        body,
      };
    }

    case "linkedin:LINKEDIN_GET_MY_INFO":
      return { method: "GET", path: "/v2/userinfo" };
    case "linkedin:LINKEDIN_CREATE_LINKED_IN_POST":
      return {
        method: "POST",
        path: "/v2/ugcPosts",
        body: input,
        headers: { "x-restli-protocol-version": "2.0.0" },
      };
    default:
      return null;
  }
};
