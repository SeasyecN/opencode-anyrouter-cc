import { fromClaudeCodeToolName } from "./names";
import type { GatewayConfig } from "./types";
export type FetchInput = Request | URL | string;
type FetchImplementation = (input: FetchInput, init?: RequestInit) => Promise<Response>;
type ProviderFetchOptions = {
    readonly gateway: GatewayConfig;
    readonly fetchImplementation?: FetchImplementation;
    readonly workingDirectory?: string;
};
export declare const createProviderFetch: (options: ProviderFetchOptions) => FetchImplementation;
export { fromClaudeCodeToolName };
