import { traceRequest } from "./debug"
import { fromClaudeCodeToolName } from "./names"
import {
  CLAUDE_CODE_BETA,
  CLAUDE_CODE_STAINLESS_HEADERS,
  CLAUDE_CODE_USER_AGENT,
  parseBody,
  rewriteBody,
  SESSION_ID,
} from "./request-shape"
import { adaptAnthropicResponse } from "./response"
import type { GatewayConfig } from "./types"

export type FetchInput = Request | URL | string
type FetchImplementation = (input: FetchInput, init?: RequestInit) => Promise<Response>
type ProviderFetchOptions = {
  readonly gateway: GatewayConfig
  readonly fetchImplementation?: FetchImplementation
  readonly workingDirectory?: string
}

const inputUrl = (input: FetchInput): string =>
  input instanceof Request ? input.url : input instanceof URL ? input.href : input

const inputMethod = (input: FetchInput, init: RequestInit | undefined): string =>
  (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()

const inputHeaders = (input: FetchInput, init: RequestInit | undefined): Headers => {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  if (init?.headers !== undefined) {
    for (const [key, value] of new Headers(init.headers)) headers.set(key, value)
  }
  return headers
}

const bodyText = async (
  input: FetchInput,
  init: RequestInit | undefined,
): Promise<string | undefined> => {
  if (typeof init?.body === "string") return init.body
  if (!(input instanceof Request)) return undefined
  return await input.clone().text()
}

const isProviderMessagesRequest = (url: URL, gateway: GatewayConfig, method: string): boolean => {
  const base = new URL(gateway.baseUrl)
  return (
    method === "POST" && url.origin === base.origin && url.pathname === `${base.pathname}/messages`
  )
}

const authHeaders = (headers: Headers, auth: GatewayConfig["auth"]): void => {
  headers.delete("authorization")
  headers.delete("x-api-key")
  if (auth.kind === "bearer") {
    headers.set("authorization", `Bearer ${auth.value}`)
  } else {
    headers.set("x-api-key", auth.value)
  }
}

const claudeCodeHeaders = (headers: Headers, auth: GatewayConfig["auth"]): Headers => {
  const updated = new Headers(headers)
  authHeaders(updated, auth)
  // Real claude-cli sends application/json even when `stream` is true; the response
  // side decides by content-type, so nothing here depends on the streaming flag.
  updated.set("accept", "application/json")
  updated.set("accept-encoding", "gzip, deflate, br, zstd")
  updated.delete("content-length")
  updated.set("content-type", "application/json")
  updated.set("anthropic-version", "2023-06-01")
  updated.set("anthropic-dangerous-direct-browser-access", "true")
  updated.set("anthropic-beta", CLAUDE_CODE_BETA)
  updated.set("user-agent", CLAUDE_CODE_USER_AGENT)
  updated.set("x-app", "cli")
  // Claude Code sends the session id here as well as in metadata.user_id; the two must
  // carry the same value or the gateway sees an inconsistent client.
  updated.set("x-claude-code-session-id", SESSION_ID)
  for (const [key, value] of Object.entries(CLAUDE_CODE_STAINLESS_HEADERS)) {
    updated.set(key, value)
  }
  return updated
}

const rewrittenInit = (
  input: FetchInput,
  init: RequestInit | undefined,
  headers: Headers,
  body: string,
): RequestInit => {
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  const rewritten: RequestInit = { ...init, method: "POST", headers, body }
  if (signal !== undefined) rewritten.signal = signal
  return rewritten
}

export const createProviderFetch = (options: ProviderFetchOptions): FetchImplementation => {
  const upstream = options.fetchImplementation ?? globalThis.fetch
  return async (input, init) => {
    const url = new URL(inputUrl(input))
    if (!isProviderMessagesRequest(url, options.gateway, inputMethod(input, init))) {
      return await upstream(input, init)
    }

    const rawBody = await bodyText(input, init)
    if (rawBody === undefined) return await upstream(input, init)
    const parsedBody = parseBody(rawBody)
    if (parsedBody === undefined) return await upstream(input, init)

    const rewritten = rewriteBody(parsedBody)
    url.searchParams.set("beta", "true")
    const headers = claudeCodeHeaders(inputHeaders(input, init), options.gateway.auth)
    const startedAt = Date.now()
    const response = await upstream(
      url,
      rewrittenInit(input, init, headers, JSON.stringify(rewritten.body)),
    )

    if (process.env["ANYROUTER_DEBUG"]) {
      // Clone before anything reads the body, so tracing never consumes the real response.
      const failed = response.status < 200 || response.status >= 300
      await traceRequest({
        body: rewritten.body,
        status: response.status,
        elapsedMs: Date.now() - startedAt,
        contentType: response.headers.get("content-type"),
        responseBody: failed ? await response.clone().text() : undefined,
      })
    }

    return await adaptAnthropicResponse(response, {
      toolNameMap: rewritten.toolNames,
    })
  }
}

export { fromClaudeCodeToolName }
