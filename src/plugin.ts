import { Model, Plugin, type PluginOptions, Provider } from "@opencode/plugin"
import { resolveGatewayConfig } from "./config"
import { traceRequest } from "./debug"
import { toolNameMap } from "./names"
import { isProviderMessagesRequest, rewriteProviderRequest } from "./request"
import { type JsonRecord, parseBody } from "./request-shape"
import { adaptAnthropicResponse } from "./response"
import type { AnyRouterPluginOptions, GatewayConfig } from "./types"

const PROVIDER_ID = Provider.ID.make("anyrouter-cc")

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

const providerInfo = (gateway: GatewayConfig): Provider.Info => ({
  ...Provider.Info.empty(PROVIDER_ID),
  name: "AnyRouter Claude Code",
  activation: "enabled",
  package: "@opencode/ai/providers/anthropic",
  settings: {
    baseURL: gateway.baseUrl,
    // The native runtime owns transport/auth; the HTTP hook adds the gateway envelope.
    ...(gateway.auth.kind === "bearer"
      ? { authToken: gateway.auth.value }
      : { apiKey: gateway.auth.value }),
    encoding: "none",
  },
})

export const createAnyRouterPlugin = (options: AnyRouterPluginOptions = {}): Plugin.Plugin =>
  Plugin.define({
    id: "@seasyecn/opencode-anyrouter-cc",
    async setup(ctx) {
      // Resolve filesystem/environment inputs once, never inside a replayable transform.
      const gateway = await resolveGatewayConfig({
        ...options,
        ...pluginOptions(ctx.options),
        cwd: options.cwd ?? ctx.location.directory,
      })
      if (gateway === undefined) return

      // Weak keys do not retain requests after errors/aborts. Only opt-in tracing
      // captures payloads; normal calls do not keep per-request state.
      const traces = new WeakMap<Request, { body: JsonRecord; startedAt: number }>()

      await ctx.provider.transform((editor) => {
        editor.add({
          info: providerInfo(gateway),
          models: Object.entries(MODELS).map(
            ([alias, model]): Model.Info => ({
              ...Model.Info.default(PROVIDER_ID, Model.ID.make(alias)),
              modelID: Model.ID.make(model.id),
              name: model.name,
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 1_000_000, output: 64_000 },
            }),
          ),
        })
      })

      await ctx.session.hook(
        "http.request",
        async (event) => {
          if (event.model.providerID !== PROVIDER_ID) return
          const request = await rewriteProviderRequest(event.request, gateway)
          if (request !== event.request && process.env["ANYROUTER_DEBUG"]) {
            const body = parseBody(await request.clone().text())
            if (body !== undefined) traces.set(request, { body, startedAt: Date.now() })
          }
          event.request = request
        },
        { providerID: PROVIDER_ID },
      )
      await ctx.session.hook(
        "http.response",
        async (event) => {
          if (event.model.providerID !== PROVIDER_ID) return
          if (!isProviderMessagesRequest(new URL(event.request.url), gateway, event.request.method))
            return
          const trace = traces.get(event.request)
          if (trace !== undefined) {
            traces.delete(event.request)
            await traceRequest({
              body: trace.body,
              status: event.response.status,
              elapsedMs: Date.now() - trace.startedAt,
              contentType: event.response.headers.get("content-type"),
              responseBody: event.response.ok ? undefined : await event.response.clone().text(),
            })
          }
          event.response = await adaptAnthropicResponse(event.response, { toolNameMap })
        },
        { providerID: PROVIDER_ID },
      )
      // OpenCode owns hook/transform registration cleanup; no timers or subscriptions.
    },
  })

export const AnyRouterPlugin = createAnyRouterPlugin()

export default AnyRouterPlugin
