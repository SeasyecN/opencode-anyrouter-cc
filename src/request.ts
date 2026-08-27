import { fromClaudeCodeToolName } from "./names"
import { CLAUDE_CODE_BETA, CLAUDE_CODE_USER_AGENT, parseBody, rewriteBody } from "./request-shape"
import { convertAnthropicResponseToSse } from "./response"
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
  updated.set("accept", "application/json")
  updated.delete("content-length")
  updated.set("content-type", "application/json")
  updated.set("anthropic-version", "2023-06-01")
  updated.set("anthropic-dangerous-direct-browser-access", "true")
  updated.set("anthropic-beta", CLAUDE_CODE_BETA)
  updated.set("user-agent", CLAUDE_CODE_USER_AGENT)
  updated.set("x-app", "cli")
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
  const workingDirectory = options.workingDirectory ?? process.cwd()
  return async (input, init) => {
    const url = new URL(inputUrl(input))
    if (!isProviderMessagesRequest(url, options.gateway, inputMethod(input, init))) {
      return await upstream(input, init)
    }

    const rawBody = await bodyText(input, init)
    if (rawBody === undefined) return await upstream(input, init)
    const parsedBody = parseBody(rawBody)
    if (parsedBody === undefined) return await upstream(input, init)

    const rewritten = rewriteBody(parsedBody, workingDirectory)
    url.searchParams.set("beta", "true")
    const headers = claudeCodeHeaders(inputHeaders(input, init), options.gateway.auth)
    const response = await upstream(
      url,
      rewrittenInit(input, init, headers, JSON.stringify(rewritten.body)),
    )
    return await convertAnthropicResponseToSse(response, {
      toolNameMap: rewritten.toolNames,
    })
  }
}

export { fromClaudeCodeToolName }
