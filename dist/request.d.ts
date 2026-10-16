import { fromClaudeCodeToolName } from "./names";
import type { GatewayConfig } from "./types";
export type FetchInput = Request | URL | string;
type FetchImplementation = (input: FetchInput, init?: RequestInit) => Promise<Response>;
type ProviderFetchOptions = {
    readonly gateway: GatewayConfig;
    readonly fetchImplementation?: FetchImplementation;
    readonly workingDirectory?: string;
};
export declare const isProviderMessagesRequest: (url: URL, gateway: GatewayConfig, method: string) => boolean;
export declare const rewriteProviderRequest: (request: Request, gateway: GatewayConfig) => Promise<Request>;
export declare const createProviderFetch: (options: ProviderFetchOptions) => FetchImplementation;
export { fromClaudeCodeToolName };
