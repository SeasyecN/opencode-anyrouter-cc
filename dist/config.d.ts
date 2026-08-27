import type { AnyRouterPluginOptions, GatewayConfig } from "./types";
export declare class InvalidGatewayConfigurationError extends Error {
    readonly name = "InvalidGatewayConfigurationError";
}
export declare const normalizeBaseUrl: (baseUrl: string) => string;
export declare const resolveGatewayConfig: (options?: AnyRouterPluginOptions) => Promise<GatewayConfig | undefined>;
