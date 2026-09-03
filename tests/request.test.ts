import { describe, expect, it } from "bun:test"
import { createProviderFetch } from "../src/request"
import type { GatewayConfig } from "../src/types"

type FetchInput = Request | URL | string
type RewrittenBlock = Readonly<{
  readonly type?: unknown
  readonly text?: unknown
  readonly name?: unknown
  readonly cache_control?: unknown
  readonly [key: string]: unknown
}>
type RewrittenMessage = Readonly<{
  readonly content?: ReadonlyArray<RewrittenBlock>
}>
type RewrittenBody = Readonly<{
  readonly system?: ReadonlyArray<RewrittenBlock>
  readonly messages?: ReadonlyArray<RewrittenMessage>
  readonly tools?: ReadonlyArray<RewrittenBlock>
  readonly thinking?: unknown
  readonly context_management?: unknown
  readonly output_config?: unknown
  readonly metadata?: Readonly<{
    readonly user_id?: unknown
    readonly [key: string]: unknown
  }>
}>

const gateway: GatewayConfig = {
  baseUrl: "https://router.example/v1",
  auth: { kind: "bearer", value: "gateway-token" },
}

describe("createProviderFetch", () => {
  it("rewrites the provider's messages request and preserves its abort signal", async () => {
    const calls: {
      readonly input: FetchInput
      readonly init: RequestInit | undefined
    }[] = []
    const signal = new AbortController().signal
    const upstream = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
      calls.push({ input, init })
      return new Response("{}", { status: 200 })
    }
    const providerFetch = createProviderFetch({
      gateway,
      fetchImplementation: upstream,
    })
    const body = {
      model: "claude-opus-5[1m]",
      stream: true,
      messages: [{ role: "user", content: "Hello" }],
    }

    await providerFetch("https://router.example/v1/messages", {
      method: "POST",
      headers: {
        "content-length": "999",
        "content-type": "application/json",
        "anthropic-beta": "sdk-default",
        "x-api-key": "stale-key",
      },
      body: JSON.stringify(body),
      signal,
    })

    const call = calls[0]
    expect(call).toBeDefined()
    expect(call?.input.toString()).toBe("https://router.example/v1/messages?beta=true")
    expect(call?.init?.signal).toBe(signal)
    const headers = new Headers(call?.init?.headers)
    expect(headers.get("authorization")).toBe("Bearer gateway-token")
    expect(headers.get("x-api-key")).toBeNull()
    expect(headers.get("content-length")).toBeNull()
    expect(headers.get("anthropic-beta")).toBe(
      "claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,context-1m-2025-08-07,advanced-tool-use-2025-11-20,effort-2025-11-24,fallback-credit-2026-06-01",
    )
    expect(headers.get("user-agent")).toBe("claude-cli/2.1.258 (external, sdk-cli)")
    expect(headers.get("accept-encoding")).toBe("gzip, deflate, br, zstd")
    expect(headers.get("x-stainless-lang")).toBe("js")
    expect(headers.get("x-stainless-package-version")).toBe("0.112.1")
    expect(headers.get("x-claude-code-session-id")).toMatch(/^[0-9a-f-]{36}$/)
    // claude-cli itself asks for application/json on streaming requests.
    expect(headers.get("accept")).toBe("application/json")
    const rewrittenBody = JSON.parse(String(call?.init?.body)) as RewrittenBody
    expect(rewrittenBody).toMatchObject({
      model: "claude-opus-5",
      stream: true,
      messages: [{ role: "user", content: "Hello" }],
      system: expect.any(Array),
      metadata: expect.any(Object),
    })
    expect(Object.hasOwn(rewrittenBody, "thinking")).toBe(false)
    expect(Object.hasOwn(rewrittenBody, "context_management")).toBe(false)
    expect(Object.hasOwn(rewrittenBody, "output_config")).toBe(false)
  })

  it("preserves caller-supplied reasoning, context, and output fields", async () => {
    let rewrittenBody: RewrittenBody | undefined
    const upstream = async (_input: FetchInput, init?: RequestInit): Promise<Response> => {
      rewrittenBody = JSON.parse(String(init?.body)) as RewrittenBody
      return new Response("{}", { status: 200 })
    }
    const providerFetch = createProviderFetch({
      gateway,
      fetchImplementation: upstream,
    })
    const thinking = { type: "enabled", budget_tokens: 2048 }
    const contextManagement = { edits: [{ type: "compact", keep: "recent" }] }
    const outputConfig = { effort: "low", format: "json" }

    await providerFetch("https://router.example/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-5",
        thinking,
        context_management: contextManagement,
        output_config: outputConfig,
      }),
    })

    expect(rewrittenBody?.thinking).toEqual(thinking)
    expect(rewrittenBody?.context_management).toEqual(contextManagement)
    expect(rewrittenBody?.output_config).toEqual(outputConfig)
  })

  it("sends only the Claude Code prefix when compaction supplies an empty system", async () => {
    // OpenCode's compaction path calls the model with `system: []` and `tools: {}`
    // (packages/opencode/src/session/compaction.ts). That is the only caller that hits
    // the empty-system branch, so it must not gain a system block claiming to run
    // inside some other agent.
    let rewrittenBody: RewrittenBody | undefined
    const upstream = async (_input: FetchInput, init?: RequestInit): Promise<Response> => {
      rewrittenBody = JSON.parse(String(init?.body)) as RewrittenBody
      return new Response("{}", { status: 200 })
    }
    const providerFetch = createProviderFetch({ gateway, fetchImplementation: upstream })

    await providerFetch("https://router.example/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-5",
        system: [],
        messages: [{ role: "user", content: "Summarize the conversation." }],
      }),
    })

    const system = rewrittenBody?.system ?? []
    expect(system).toHaveLength(2)
    expect(system[0]?.text).toContain("x-anthropic-billing-header")
    expect(system[1]?.text).toBe("You are a Claude agent, built on Anthropic's Claude Agent SDK.")
    for (const block of system) {
      expect(String(block.text)).not.toContain("inside pi")
    }
  })

  it("sends only the Claude Code prefix when no system field is present", async () => {
    let rewrittenBody: RewrittenBody | undefined
    const upstream = async (_input: FetchInput, init?: RequestInit): Promise<Response> => {
      rewrittenBody = JSON.parse(String(init?.body)) as RewrittenBody
      return new Response("{}", { status: 200 })
    }
    const providerFetch = createProviderFetch({ gateway, fetchImplementation: upstream })

    await providerFetch("https://router.example/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-opus-5", messages: [] }),
    })

    expect(rewrittenBody?.system).toHaveLength(2)
  })

  it("uses x-api-key when no bearer token is configured", async () => {
    const calls: RequestInit[] = []
    const upstream = async (_input: FetchInput, init?: RequestInit): Promise<Response> => {
      if (init !== undefined) calls.push(init)
      return new Response("{}", { status: 200 })
    }
    const providerFetch = createProviderFetch({
      gateway: {
        baseUrl: gateway.baseUrl,
        auth: { kind: "api-key", value: "api-key" },
      },
      fetchImplementation: upstream,
    })

    await providerFetch("https://router.example/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-opus-5", messages: [] }),
    })

    const headers = new Headers(calls[0]?.headers)
    expect(headers.get("x-api-key")).toBe("api-key")
    expect(headers.get("authorization")).toBeNull()
  })

  it("adapts system prompts, tools, and assistant tool blocks for Claude Code", async () => {
    let rewrittenBody: RewrittenBody | undefined
    const upstream = async (_input: FetchInput, init?: RequestInit): Promise<Response> => {
      rewrittenBody = JSON.parse(String(init?.body)) as RewrittenBody
      return new Response("{}", { status: 200 })
    }
    const providerFetch = createProviderFetch({
      gateway,
      workingDirectory: "/project",
      fetchImplementation: upstream,
    })

    await providerFetch("https://router.example/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-5[1m]",
        system: "Follow the repository rules.",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "call_1",
                name: "read",
                input: { path: "README.md" },
              },
              {
                type: "tool_use",
                id: "call_2",
                name: "list",
                input: { path: "." },
              },
            ],
          },
        ],
        tools: [
          {
            name: "read",
            description: "read a file",
            input_schema: { type: "object" },
          },
          {
            name: "list",
            description: "list a directory",
            input_schema: { type: "object" },
          },
        ],
      }),
    })

    const system = rewrittenBody?.system ?? []
    const messages = rewrittenBody?.messages ?? []
    const assistantContent = messages[0]?.content ?? []
    const tools = rewrittenBody?.tools ?? []
    const metadata = rewrittenBody?.metadata ?? {}
    expect(system).toHaveLength(3)
    expect(system[0]?.text).toBe(
      "x-anthropic-billing-header: cc_version=2.1.258.1e2; cc_entrypoint=sdk-cli;",
    )
    expect(system[1]?.text).toBe("You are a Claude agent, built on Anthropic's Claude Agent SDK.")
    expect(system[2]?.text).toBe("Follow the repository rules.")
    expect(assistantContent[0]?.name).toBe("Read")
    expect(assistantContent[1]?.name).toBe("List")
    expect(tools[0]?.name).toBe("Read")
    expect(tools[1]?.name).toBe("List")
    expect(String(metadata.user_id)).toMatch(
      /^\{"device_id":"[0-9a-f]{64}","account_uuid":"","session_id":"[0-9a-f-]+"\}$/,
    )
  })

  it("preserves varied system blocks while adding the target envelope once", async () => {
    let rewrittenBody: RewrittenBody | undefined
    const upstream = async (_input: FetchInput, init?: RequestInit): Promise<Response> => {
      rewrittenBody = JSON.parse(String(init?.body)) as RewrittenBody
      return new Response("{}", { status: 200 })
    }
    const providerFetch = createProviderFetch({
      gateway,
      workingDirectory: "/project",
      fetchImplementation: upstream,
    })
    const system = [
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=older; cc_entrypoint=sdk-cli; cch=00000;",
      },
      {
        type: "text",
        text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
        cache_control: { type: "ephemeral" },
      },
      { type: "text", text: "Keep this legitimate block." },
      { type: "text", text: "Keep this second legitimate block." },
    ]

    await providerFetch("https://router.example/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-opus-5", system }),
    })

    expect(rewrittenBody?.system).toEqual(system)
  })

  it("does not duplicate a single existing protocol block", async () => {
    let rewrittenBody: RewrittenBody | undefined
    const upstream = async (_input: FetchInput, init?: RequestInit): Promise<Response> => {
      rewrittenBody = JSON.parse(String(init?.body)) as RewrittenBody
      return new Response("{}", { status: 200 })
    }
    const providerFetch = createProviderFetch({
      gateway,
      fetchImplementation: upstream,
    })

    await providerFetch("https://router.example/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        model: "claude-opus-5",
        system: [
          {
            type: "text",
            text: "x-anthropic-billing-header: cc_version=older; cc_entrypoint=sdk-cli; cch=00000;",
          },
          { type: "text", text: "Keep this block." },
        ],
      }),
    })

    const system = rewrittenBody?.system ?? []
    expect(
      system.filter((block) => String(block.text).startsWith("x-anthropic-billing-header:")).length,
    ).toBe(1)
    expect(
      system.filter((block) => String(block.text).startsWith("You are a Claude agent,")).length,
    ).toBe(1)
    expect(system[2]?.text).toBe("Keep this block.")
  })

  it("normalizes the metadata user id and keeps every other metadata field", async () => {
    const bodies: RewrittenBody[] = []
    const upstream = async (_input: FetchInput, init?: RequestInit): Promise<Response> => {
      if (typeof init?.body === "string") bodies.push(JSON.parse(init.body) as RewrittenBody)
      return new Response("{}", { status: 200 })
    }
    const providerFetch = createProviderFetch({
      gateway,
      workingDirectory: "/project",
      fetchImplementation: upstream,
    })
    const metadata = { user_id: "whatever-the-caller-sent", trace_id: "trace-1" }

    await providerFetch("https://router.example/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-opus-5", metadata }),
    })

    const firstBody = bodies[0]
    if (firstBody === undefined) throw new Error("first rewritten body was not captured")
    expect(firstBody.metadata?.["trace_id"]).toBe("trace-1")
    expect(String(firstBody.metadata?.user_id)).toMatch(
      /^\{"device_id":"[0-9a-f]{64}","account_uuid":"","session_id":"[0-9a-f-]+"\}$/,
    )
  })

  // OpenCode builds every request from scratch and never echoes the plugin's own output
  // back, so session stability has to hold across independent requests. The previous
  // suite only fed a rewritten body back in, which hid a fresh uuid on every call.
  it("sends one stable session id across independent requests and in the header", async () => {
    const bodies: RewrittenBody[] = []
    const sessionHeaders: (string | null)[] = []
    const upstream = async (_input: FetchInput, init?: RequestInit): Promise<Response> => {
      if (typeof init?.body === "string") bodies.push(JSON.parse(init.body) as RewrittenBody)
      sessionHeaders.push(new Headers(init?.headers).get("x-claude-code-session-id"))
      return new Response("{}", { status: 200 })
    }
    const providerFetch = createProviderFetch({
      gateway,
      workingDirectory: "/project",
      fetchImplementation: upstream,
    })

    for (const prompt of ["first turn", "second turn", "third turn"]) {
      await providerFetch("https://router.example/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "claude-opus-5",
          system: "Use the repository rules.",
          messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        }),
      })
    }

    const userIds = bodies.map((body) => String(body.metadata?.user_id))
    expect(new Set(userIds).size).toBe(1)
    expect(new Set(sessionHeaders).size).toBe(1)

    const sessionId = JSON.parse(String(userIds[0])).session_id
    expect(sessionHeaders[0]).toBe(sessionId)
  })

  it("does not duplicate Claude Code system or metadata injection", async () => {
    const bodies: RewrittenBody[] = []
    const upstream = async (_input: FetchInput, init?: RequestInit): Promise<Response> => {
      if (typeof init?.body === "string") bodies.push(JSON.parse(init.body) as RewrittenBody)
      return new Response("{}", { status: 200 })
    }
    const providerFetch = createProviderFetch({
      gateway,
      workingDirectory: "/project",
      fetchImplementation: upstream,
    })

    await providerFetch("https://router.example/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-opus-5", system: "Use the repository rules." }),
    })
    const firstBody = bodies[0]
    expect(firstBody).toBeDefined()
    if (firstBody === undefined) throw new Error("first rewritten body was not captured")

    await providerFetch("https://router.example/v1/messages", {
      method: "POST",
      body: JSON.stringify(firstBody),
    })

    expect(bodies).toHaveLength(2)
    expect(bodies[1]?.system).toEqual(firstBody.system)
    expect(bodies[1]?.metadata?.user_id).toBe(firstBody.metadata?.user_id)
  })

  it("does not rewrite unrelated requests", async () => {
    const calls: {
      readonly input: FetchInput
      readonly init: RequestInit | undefined
    }[] = []
    const upstream = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
      calls.push({ input, init })
      return new Response("{}", { status: 200 })
    }
    const providerFetch = createProviderFetch({
      gateway,
      fetchImplementation: upstream,
    })

    await providerFetch("https://router.example/v1/models", { method: "GET" })

    expect(calls[0]?.input.toString()).toBe("https://router.example/v1/models")
    expect(calls[0]?.init?.method).toBe("GET")
  })

  it("leaves the global fetch reference unchanged", () => {
    const originalFetch = globalThis.fetch

    createProviderFetch({ gateway })

    expect(globalThis.fetch).toBe(originalFetch)
  })
})
