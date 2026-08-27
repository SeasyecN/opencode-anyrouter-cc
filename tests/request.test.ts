import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
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
  readonly metadata?: Readonly<{ readonly user_id?: unknown }>
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
      "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24",
    )
    expect(JSON.parse(String(call?.init?.body))).toMatchObject({
      model: "claude-opus-5",
      stream: false,
      messages: [{ role: "user", content: "Hello" }],
      system: expect.any(Array),
      metadata: expect.any(Object),
    })
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
      "x-anthropic-billing-header: cc_version=2.1.74.7f2; cc_entrypoint=sdk-cli; cch=00000;",
    )
    expect(system[1]?.text).toBe("You are a Claude agent, built on Anthropic's Claude Agent SDK.")
    expect(system[2]?.text).toBe("Follow the repository rules.")
    expect(assistantContent[0]?.name).toBe("Read")
    expect(assistantContent[1]?.name).toBe("List")
    expect(tools[0]?.name).toBe("Read")
    expect(tools[1]?.name).toBe("List")
    expect(String(metadata.user_id)).toMatch(/^user_[0-9a-f]{64}_account__session_[0-9a-f-]+$/)
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

  it("keeps an existing metadata user id and all metadata fields on repeat adaptation", async () => {
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
    const accountHash = createHash("sha256").update("anyrouter-cc:/project").digest("hex")
    const metadata = {
      user_id: `user_${accountHash}_account__session_existing`,
      trace_id: "trace-1",
    }

    await providerFetch("https://router.example/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-opus-5", metadata }),
    })

    const firstBody = bodies[0]
    expect(firstBody?.metadata).toEqual(metadata)
    if (firstBody === undefined) throw new Error("first rewritten body was not captured")

    await providerFetch("https://router.example/v1/messages", {
      method: "POST",
      body: JSON.stringify(firstBody),
    })

    expect(bodies[1]?.metadata).toEqual(metadata)
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
