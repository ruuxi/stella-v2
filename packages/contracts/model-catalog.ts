import { MODELS } from "./models.generated.js";

export type CatalogApi = string;
export type Api = CatalogApi;

export type CatalogModel<TApi extends CatalogApi = CatalogApi> = {
  id: string;
  name: string;
  api: TApi;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: Partial<
    Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>
  >;
  input: ("text" | "image")[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: unknown;
};

export type Model<TApi extends Api = Api> = CatalogModel<TApi>;

export function getAllModels(): CatalogModel[] {
  return Object.keys(MODELS)
    .sort()
    .flatMap((provider) =>
      Object.values(MODELS[provider as keyof typeof MODELS]),
    ) as CatalogModel[];
}
