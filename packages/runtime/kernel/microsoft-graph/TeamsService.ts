import { GRAPH_DEFAULT_PAGE_SIZE, GRAPH_MAX_PAGE_SIZE } from "./constants.js";
import type { GraphClient } from "./GraphClient.js";
import { ok, fail, type ServiceContent } from "./service-result.js";

const clampTop = (value: unknown): number => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return GRAPH_DEFAULT_PAGE_SIZE;
  return Math.min(Math.trunc(n), GRAPH_MAX_PAGE_SIZE);
};

const enc = encodeURIComponent;

/**
 * Representative first-party Microsoft Teams service over Microsoft Graph.
 * Delegated endpoints backed by the shared Microsoft grant's
 * `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All`,
 * and `ChannelMessage.Send` scopes.
 */
export class TeamsService {
  constructor(private readonly graph: GraphClient) {}

  /** Lists teams the signed-in user is a member of. */
  public listJoinedTeams = async (): Promise<ServiceContent> => {
    try {
      const data = await this.graph.get<{ value?: unknown[] }>(
        "/me/joinedTeams",
        { $select: "id,displayName,description" },
      );
      return ok({ teams: data.value ?? [] });
    } catch (error) {
      return fail("teams.listJoinedTeams", error);
    }
  };

  /** Lists channels within a team. */
  public listChannels = async (args: {
    teamId: string;
  }): Promise<ServiceContent> => {
    try {
      const data = await this.graph.get<{ value?: unknown[] }>(
        `/teams/${enc(args.teamId)}/channels`,
        { $select: "id,displayName,description,membershipType,webUrl" },
      );
      return ok({ channels: data.value ?? [] });
    } catch (error) {
      return fail("teams.listChannels", error);
    }
  };

  /** Lists recent messages in a channel. */
  public listChannelMessages = async (args: {
    teamId: string;
    channelId: string;
    top?: number;
  }): Promise<ServiceContent> => {
    try {
      const data = await this.graph.get<{ value?: unknown[] }>(
        `/teams/${enc(args.teamId)}/channels/${enc(args.channelId)}/messages`,
        { $top: clampTop(args.top) },
      );
      return ok({ messages: data.value ?? [] });
    } catch (error) {
      return fail("teams.listChannelMessages", error);
    }
  };

  /** Posts a message to a channel. */
  public sendChannelMessage = async (args: {
    teamId: string;
    channelId: string;
    content: string;
    contentType?: "text" | "html";
  }): Promise<ServiceContent> => {
    try {
      const data = await this.graph.post<{ id?: string; webUrl?: string }>(
        `/teams/${enc(args.teamId)}/channels/${enc(args.channelId)}/messages`,
        {
          body: {
            contentType: args.contentType === "html" ? "html" : "text",
            content: args.content,
          },
        },
      );
      return ok({ id: data.id, webUrl: data.webUrl });
    } catch (error) {
      return fail("teams.sendChannelMessage", error);
    }
  };
}
