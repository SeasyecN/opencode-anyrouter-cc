import { describe, expect, it } from "bun:test"
import { resolve } from "node:path"
import { Model, Provider } from "@opencode/plugin"
import type { SessionHttpRequest, SessionHttpResponse } from "@opencode/plugin/promise/session"
import { Schema } from "effect"
import { createAnyRouterPlugin } from "../src/plugin"
import { CLAUDE_CODE_BETA } from "../src/request-shape"
import { createHarness } from "./plugin-harness"

const options = {
  baseUrl: "https://router.example",
  authToken: "fixture-token",
  environment: {},
  readFile: async () => undefined,
}

const requestEvent = (
  request: Request,
  providerID = "anyrouter-cc",
  kind: SessionHttpRequest["kind"] = "primary",
): SessionHttpRequest =>
  ({ model: { providerID, id: "claude-opus-5[1m]" }, request, kind }) as SessionHttpRequest

const responseEvent = (request: Request, response: Response, providerID = "anyrouter-cc") =>
  ({ ...requestEvent(request, providerID), response }) as SessionHttpResponse

const messagesRequest = (body: unknown, url = "https://router.example/v1/messages") =>
  new Request(url, { method: "POST", body: JSON.stringify(body) })

describe("V2 plugin setup", () => {
  it("executes the real default setup with clean env/home, registers models and stable replays", async () => {
    // A subprocess avoids reading the developer's actual gateway environment/settings.
    const root = resolve(import.meta.dir, "..")
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
        import assert from "node:assert/strict"
        import * as entry from "./src/index.ts"
        import { createHarness } from "./tests/plugin-harness.ts"
        assert.deepEqual(Object.keys(entry), ["default"])
        const plugin = entry.default
        assert.equal(plugin.id, "@seasyecn/opencode-anyrouter-cc")
        const missing = createHarness({}, process.env.HOME)
        assert.equal(await plugin.setup(missing.ctx), undefined)
        assert.equal(missing.replay().size, 0)
        assert.equal(missing.hooks.length, 0)
        const h = createHarness({ baseUrl: "https://router.example", apiKey: "fixture-key" }, process.env.HOME)
        assert.equal(await plugin.setup(h.ctx), undefined)
        const first = h.replay()
        const record = first.get("anyrouter-cc")
        assert.equal(record.provider.settings.baseURL, "https://router.example/v1")
        assert.deepEqual([...record.models.keys()], ["claude-fable-5-1[1m]", "claude-opus-5[1m]"])
        assert.deepEqual(h.replay(), first)
        assert.equal(h.hooks.length, 2)
      `,
      ],
      {
        cwd: root,
        env: {
          HOME: resolve(root, "tests/fixtures/absent-home"),
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect(stderr).toBe("")
    expect(exit).toBe(0)
  })

  it("contributes schema-valid V2 provider/models without mutating another provider or prior snapshots", async () => {
    const h = createHarness()
    let reads = 0
    await createAnyRouterPlugin({
      ...options,
      readFile: async () => {
        reads++
        return undefined
      },
    }).setup(h.ctx)
    const otherID = Provider.ID.make("other")
    const other = {
      info: Provider.Info.empty(otherID),
      models: [Model.Info.default(otherID, Model.ID.make("model"))],
    }
    const first = h.replay([other])
    const record = first.get("anyrouter-cc")
    expect(record).toBeDefined()
    expect(first.get("other")?.provider).toEqual(other.info)
    expect(record?.provider.package).toBe("@opencode/ai/providers/anthropic")
    expect(record?.provider.activation).toBe("enabled")
    expect(record?.provider.settings).toEqual({
      baseURL: "https://router.example/v1",
      authToken: "fixture-token",
      encoding: "none",
    })
    Schema.decodeUnknownSync(Provider.Info)(record?.provider)
    for (const model of record?.models.values() ?? []) {
      Schema.decodeUnknownSync(Model.Info)(model)
      expect(model.modelID).toBe(Model.ID.make(model.id.replace("[1m]", "")))
      expect(model.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] })
      expect(model.limit).toEqual({ context: 1_000_000, output: 64_000 })
      expect(model).not.toHaveProperty("tool_call")
      expect(model).not.toHaveProperty("modalities")
    }
    expect(h.replay([other])).toEqual(first)
    const mutated = h.replay([other]).get("anyrouter-cc")?.provider as { name: string }
    mutated.name = "changed snapshot"
    expect(h.replay([other])).toEqual(first)
    expect(reads).toBe(3)
    expect(record?.provider).not.toHaveProperty("npm")
    expect(record?.provider).not.toHaveProperty("options")
  })

  it("lets ctx options override factory defaults and ignores non-string gateway options", async () => {
    const h = createHarness({
      baseUrl: "https://custom.example/prefix/v1/",
      apiKey: "ctx-key",
      authToken: false,
    })
    await createAnyRouterPlugin({
      baseUrl: options.baseUrl,
      environment: {},
      readFile: options.readFile,
    }).setup(h.ctx)
    expect(h.replay().get("anyrouter-cc")?.provider.settings).toEqual({
      baseURL: "https://custom.example/prefix/v1",
      apiKey: "ctx-key",
      encoding: "none",
    })
  })

  it("uses ctx.location.directory for project settings and keeps explicit auth-source precedence", async () => {
    const paths: string[] = []
    const h = createHarness({ apiKey: "ctx-key" }, "/custom-project")
    await createAnyRouterPlugin({
      environment: { ANTHROPIC_AUTH_TOKEN: "lower-priority-token" },
      homeDir: "/fixture-home",
      readFile: async (path) => {
        paths.push(path)
        return path === "/custom-project/.claude/settings.local.json"
          ? JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://project.example" } })
          : undefined
      },
    }).setup(h.ctx)
    expect(paths).toEqual([
      "/custom-project/.claude/settings.local.json",
      "/custom-project/.claude/settings.json",
      "/fixture-home/.claude/settings.json",
    ])
    expect(h.replay().get("anyrouter-cc")?.provider.settings).toMatchObject({
      baseURL: "https://project.example/v1",
      apiKey: "ctx-key",
    })
  })

  it.each([
    { authToken: "key-only" },
    { baseUrl: "https://router.example" },
    { baseUrl: " ", apiKey: " " },
  ])("registers nothing for incomplete config %j", async (partial) => {
    const h = createHarness()
    await createAnyRouterPlugin({
      ...partial,
      environment: {},
      readFile: async () => undefined,
    }).setup(h.ctx)
    expect(h.replay().size).toBe(0)
    expect(h.hooks).toHaveLength(0)
  })
})

describe("registered native HTTP hooks", () => {
  it.each([
    "primary",
    "compaction",
    "title",
    "generate",
  ] as const)("rewrites %s headers/body/query while preserving generation parameters", async (kind) => {
    const h = createHarness()
    await createAnyRouterPlugin(options).setup(h.ctx)
    const controller = new AbortController()
    const request = new Request("https://router.example/v1/messages?trace=1&beta=false", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "x-api-key": "stale-key",
        authorization: "stale-auth",
        "content-length": "999",
        "x-custom": "keep",
      },
      body: JSON.stringify({
        model: "claude-opus-5[1m]",
        stream: true,
        max_tokens: 1234,
        temperature: 0.2,
        thinking: { type: "enabled", budget_tokens: 1000 },
        output_config: { effort: "high" },
        context_management: { edits: [] },
        metadata: { trace_id: "trace-1" },
        system: "Repository rules.",
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "call-1", name: "read", input: { path: "README.md" } },
            ],
          },
        ],
        tools: [{ name: "read", input_schema: { type: "object" } }],
      }),
    })
    const event = requestEvent(request, "anyrouter-cc", kind)
    await h.dispatch("http.request", event)
    expect(event.request.url).toBe("https://router.example/v1/messages?trace=1&beta=true")
    expect(request.bodyUsed).toBe(false)
    const headers = event.request.headers
    expect(headers.get("authorization")).toBe("Bearer fixture-token")
    expect(headers.has("x-api-key")).toBe(false)
    expect(headers.has("content-length")).toBe(false)
    expect(headers.get("x-custom")).toBe("keep")
    expect(headers.get("anthropic-beta")).toBe(CLAUDE_CODE_BETA)
    expect(headers.get("user-agent")).toBe("claude-cli/2.1.258 (external, sdk-cli)")
    const body = (await event.request.clone().json()) as {
      system: unknown[]
      metadata: { user_id: string }
    }
    expect(body).toMatchObject({
      model: "claude-opus-5",
      stream: true,
      max_tokens: 1234,
      temperature: 0.2,
      thinking: { type: "enabled", budget_tokens: 1000 },
      output_config: { effort: "high" },
      context_management: { edits: [] },
      metadata: { trace_id: "trace-1" },
      tools: [{ name: "Read" }],
      messages: [{ content: [{ name: "Read" }] }],
    })
    expect(body.system).toHaveLength(3)
    expect(JSON.parse(body.metadata.user_id).session_id).toBe(
      headers.get("x-claude-code-session-id"),
    )
    controller.abort()
    expect(event.request.signal.aborted).toBe(true)
    expect(h.hooks.every((hook) => hook.providerID === "anyrouter-cc")).toBe(true)
  })

  it("replaces stale bearer auth with configured API-key auth", async () => {
    const h = createHarness({ apiKey: "ctx-key" })
    await createAnyRouterPlugin({
      baseUrl: options.baseUrl,
      environment: {},
      readFile: options.readFile,
    }).setup(h.ctx)
    const request = messagesRequest({ model: "claude-fable-5-1[1m]", stream: false })
    request.headers.set("authorization", "stale")
    const event = requestEvent(request)
    await h.dispatch("http.request", event)
    expect(event.request.headers.get("x-api-key")).toBe("ctx-key")
    expect(event.request.headers.has("authorization")).toBe(false)
    expect(await event.request.json()).toMatchObject({ model: "claude-fable-5-1", stream: false })
  })

  it("leaves other providers, hosts, paths, methods and invalid bodies untouched", async () => {
    const h = createHarness()
    await createAnyRouterPlugin(options).setup(h.ctx)
    const events = [
      requestEvent(messagesRequest({ model: "other" }), "other"),
      requestEvent(messagesRequest({}, "https://another.example/v1/messages")),
      requestEvent(messagesRequest({}, "https://router.example/v1/models")),
      requestEvent(new Request("https://router.example/v1/messages")),
      requestEvent(
        new Request("https://router.example/v1/messages", { method: "POST", body: "invalid" }),
      ),
    ]
    const fetch = globalThis.fetch
    for (const event of events) {
      const original = event.request
      await h.dispatch("http.request", event)
      expect(event.request).toBe(original)
      expect(original.bodyUsed).toBe(false)
    }
    // Also call the callback directly to verify its own provider guard.
    await h.hooks.find((hook) => hook.name === "http.request")?.callback(events[0] as never)
    expect(events[0]?.request.headers.has("authorization")).toBe(false)
    expect(globalThis.fetch).toBe(fetch)
  })

  it("adapts JSON fallback and streaming tool names, but not other providers or errors", async () => {
    const h = createHarness()
    await createAnyRouterPlugin(options).setup(h.ctx)
    const request = messagesRequest({ model: "claude-opus-5" })
    const json = {
      id: "msg-1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "tool_use", id: "call-1", name: "Read", input: {} }],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }
    const fallback = responseEvent(request, Response.json(json))
    await h.dispatch("http.response", fallback)
    expect(fallback.response.headers.get("content-type")).toBe("text/event-stream")
    expect(await fallback.response.text()).toContain('"name":"read"')
    const stream = responseEvent(
      request,
      new Response(
        'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"Read"}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ),
    )
    await h.dispatch("http.response", stream)
    expect(await stream.response.text()).toContain('"name":"read"')
    for (const event of [
      responseEvent(request, Response.json(json), "other"),
      responseEvent(request, new Response("error", { status: 401 })),
      responseEvent(new Request("https://router.example/v1/models"), Response.json(json)),
    ]) {
      const response = event.response
      await h.dispatch("http.response", event)
      expect(event.response).toBe(response)
      expect(response.bodyUsed).toBe(false)
    }
  })
})
