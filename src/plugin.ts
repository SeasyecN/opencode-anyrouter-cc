import type { Config, Plugin, PluginOptions } from "@opencode-ai/plugin"
import { resolveGatewayConfig } from "./config"
import { createProviderFetch } from "./request"
import type { AnyRouterPluginOptions, GatewayConfig } from "./types"

const PROVIDER_ID = "anyrouter-cc"

// OpenCode alias -> upstream model id. Both ship with the 1M window as the default, so
// the `[1m]` suffix is stripped before the request leaves (see rewriteBody). Output is
// capped at what claude-cli 2.1.258 itself requests (max_tokens: 64000), not the API's
// 128K ceiling, so the request shape stays identical to a real Claude Code call.
const MODELS = {
  "claude-fable-5-1[1m]": { id: "claude-fable-5-1", name: "Claude Fable 5.1 (1M context)" },
  "claude-opus-5[1m]": { id: "claude-opus-5", name: "Claude Opus 5 (1M context)" },
} as const

const PluginOptionsSchema = {
  baseUrl: "baseUrl",
  authToken: "authToken",
  apiKey: "apiKey",
} as const

const pluginOptions = (options: PluginOptions | undefined): AnyRouterPluginOptions => {
  if (options === undefined) return {}
  const selected: AnyRouterPluginOptions = {}
  const baseUrl = options[PluginOptionsSchema.baseUrl]
  const authToken = options[PluginOptionsSchema.authToken]
  const apiKey = options[PluginOptionsSchema.apiKey]
  return {
    ...selected,
    ...(typeof baseUrl === "string" ? { baseUrl } : {}),
    ...(typeof authToken === "string" ? { authToken } : {}),
    ...(typeof apiKey === "string" ? { apiKey } : {}),
  }
}

const providerConfig = (
  gateway: GatewayConfig,
  workingDirectory: string,
): NonNullable<Config["provider"]>[string] => ({
  api: gateway.baseUrl,
  name: "AnyRouter Claude Code",
  npm: "@ai-sdk/anthropic",
  options: {
    apiKey: "anyrouter-cc",
    baseURL: gateway.baseUrl,
    fetch: createProviderFetch({ gateway, workingDirectory }),
  },
  models: Object.fromEntries(
    Object.entries(MODELS).map(([alias, model]) => [
      alias,
      {
        id: model.id,
        name: model.name,
        reasoning: true,
        tool_call: true,
        modalities: { input: ["text"], output: ["text"] },
        cost: { input: 0, output: 0 },
        limit: { context: 1_000_000, output: 64_000 },
      },
    ]),
  ),
})

export const createAnyRouterPlugin =
  (options: AnyRouterPluginOptions = {}): Plugin =>
  async (input, receivedOptions) => {
    const resolvedOptions = {
      ...options,
      ...pluginOptions(receivedOptions),
      cwd: options.cwd ?? input.directory,
    }

    return {
      config: async (config) => {
        const gateway = await resolveGatewayConfig(resolvedOptions)
        if (gateway === undefined) return

        config.provider = {
          ...(config.provider ?? {}),
          [PROVIDER_ID]: providerConfig(gateway, input.directory),
        }
      },
    }
  }

export const AnyRouterPlugin: Plugin = createAnyRouterPlugin()
export default AnyRouterPlugin
