import { MODELS } from "./models.generated.js";
import { isRetiredAssistantProvider } from "./provider-display.js";

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

export type RuntimeModelCatalogModel = {
  id: string;
  name: string;
  provider: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
};

export type RuntimeModelCatalogSnapshot = {
  revision: number;
  models: RuntimeModelCatalogModel[];
  runtimeManagedProviders: Array<{
    id: string;
    authManaged: boolean;
    credentialless: boolean;
  }>;
  refreshedAt: number | null;
  configError?: string;
  catalogError?: string;
};

export type RuntimeListModelsRequest = {
  forceRefresh?: boolean;
};

export function getAllModels(): CatalogModel[] {
  return Object.keys(MODELS)
    .filter((provider) => !isRetiredAssistantProvider(provider))
    .sort()
    .flatMap((provider) =>
      Object.values(MODELS[provider as keyof typeof MODELS]),
    ) as CatalogModel[];
}
