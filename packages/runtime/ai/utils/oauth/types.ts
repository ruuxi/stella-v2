import type { Api, Model } from "../../types.js";

export type OAuthCredentials = {
	refresh: string;
	access: string;
	expires: number;
	[key: string]: unknown;
};

export type OAuthProviderId = string;

export type OAuthProvider = OAuthProviderId;

export type OAuthPrompt = {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
};

export type OAuthAuthInfo = {
	url: string;
	instructions?: string;
};

export interface OAuthLoginCallbacks {
	onAuth: (info: OAuthAuthInfo) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;

	onCredentialsReady?: (credentials: OAuthCredentials) => Promise<void>;
	signal?: AbortSignal;
}

export interface OAuthProviderInterface {
	readonly id: OAuthProviderId;
	readonly name: string;

	login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;

	usesCallbackServer?: boolean;

	refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;

	getApiKey(credentials: OAuthCredentials): string;

	modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
}

export interface OAuthProviderInfo {
	id: OAuthProviderId;
	name: string;
	available: boolean;
}
