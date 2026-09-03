import { describe, expect, it } from "bun:test"
import type { Config, PluginInput } from "@opencode-ai/plugin"
import { createAnyRouterPlugin } from "../src/plugin"

describe("createAnyRouterPlugin", () => {
  it("exposes only the default plugin entrypoint to the OpenCode loader", async () => {
    const module = await import("../src/index")

    expect(Object.keys(module)).toEqual(["default"])
    const hooks = await module.default({ directory: "/project" } as PluginInput)
    expect(typeof hooks.config).toBe("function")
  })

  it("registers the Fable 5.1 and Opus 5 one-million-context models", async () => {
    const plugin = createAnyRouterPlugin({
      baseUrl: "https://router.example",
      authToken: "plugin-token",
      readFile: async () => undefined,
    })
    const hooks = await plugin({ directory: "/project" } as PluginInput)
    const config: Config = { provider: {} }

    await hooks.config?.(config)

    const providers = config.provider ?? {}
    const provider = providers["anyrouter-cc"]
    const fable = provider?.models?.["claude-fable-5-1[1m]"]
    const opus = provider?.models?.["claude-opus-5[1m]"]
    expect(Object.keys(providers)).toEqual(["anyrouter-cc"])
    expect(provider?.api).toBe("https://router.example/v1")
    expect(provider?.npm).toBe("@ai-sdk/anthropic")
    expect(Object.keys(provider?.models ?? {})).toEqual([
      "claude-fable-5-1[1m]",
      "claude-opus-5[1m]",
    ])
    expect(fable?.id).toBe("claude-fable-5-1")
    expect(fable?.limit).toEqual({ context: 1_000_000, output: 64_000 })
    expect(opus?.id).toBe("claude-opus-5")
  })

  it("does not register a provider when gateway configuration is missing", async () => {
    const plugin = createAnyRouterPlugin({
      environment: {},
      readFile: async () => undefined,
    })
    const hooks = await plugin({ directory: "/project" } as PluginInput)
    const config: Config = { provider: {} }

    await hooks.config?.(config)

    expect(config.provider).toEqual({})
  })
})
