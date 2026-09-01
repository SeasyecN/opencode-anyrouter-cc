import { appendFile } from "node:fs/promises"
import type { JsonRecord } from "./request-shape"

// Opt-in request/response tracing. Set ANYROUTER_DEBUG to a file path to enable; when it
// is unset nothing is computed and nothing is written. Records request *shape* and error
// bodies only — never credentials, prompt text, or conversation content.

type BlockShape = {
  readonly type: unknown
  readonly chars: number
  readonly cached: boolean
  readonly head: string
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined

const shapeOfBlocks = (value: unknown): readonly BlockShape[] | string => {
  if (!Array.isArray(value)) return `not-an-array:${typeof value}`
  return value.map((item) => {
    if (typeof item === "string") {
      return { type: "raw-string", chars: item.length, cached: false, head: item.slice(0, 60) }
    }
    const block = record(item) ?? {}
    const text = typeof block["text"] === "string" ? block["text"] : ""
    return {
      type: block["type"],
      chars: text.length,
      cached: block["cache_control"] !== undefined,
      // First 60 chars identify which prompt this is without dumping the conversation.
      head: text.slice(0, 60),
    }
  })
}

const describe = (value: unknown): unknown => {
  if (value === undefined) return "<absent>"
  if (value === null) return null
  if (Array.isArray(value)) return `array[${value.length}]`
  if (typeof value === "object") return `object{${Object.keys(value).join(",")}}`
  return value
}

const countCacheBreakpoints = (system: unknown, messages: readonly unknown[]): number => {
  const inSystem = Array.isArray(system)
    ? system.filter((block) => record(block)?.["cache_control"] !== undefined).length
    : 0
  return messages.reduce<number>((sum, item) => {
    const content = record(item)?.["content"]
    if (!Array.isArray(content)) return sum
    return sum + content.filter((block) => record(block)?.["cache_control"] !== undefined).length
  }, inSystem)
}

export const traceRequest = async (entry: {
  readonly body: JsonRecord
  readonly status: number
  readonly elapsedMs: number
  readonly responseBody?: string | undefined
  readonly contentType?: string | null
}): Promise<void> => {
  const path = process.env["ANYROUTER_DEBUG"]
  if (path === undefined || path.length === 0) return

  const body = entry.body as Record<string, unknown>
  const messages = Array.isArray(body["messages"]) ? (body["messages"] as unknown[]) : []
  const tools = body["tools"]
  const line = {
    ok: entry.status >= 200 && entry.status < 300,
    status: entry.status,
    elapsedMs: entry.elapsedMs,
    contentType: entry.contentType ?? null,
    model: body["model"],
    stream: body["stream"],
    max_tokens: describe(body["max_tokens"]),
    temperature: describe(body["temperature"]),
    thinking: describe(body["thinking"]),
    context_management: describe(body["context_management"]),
    output_config: describe(body["output_config"]),
    tools: describe(tools),
    toolCount: Array.isArray(tools) ? tools.length : null,
    systemBlocks: shapeOfBlocks(body["system"]),
    messageCount: messages.length,
    messageRoles: messages.map((item) => record(item)?.["role"]),
    payloadBytes: JSON.stringify(body).length,
    cacheBreakpoints: countCacheBreakpoints(body["system"], messages),
    responseBody: entry.responseBody?.slice(0, 400),
  }

  try {
    await appendFile(path, `${JSON.stringify(line)}\n`)
  } catch {
    // Tracing must never break the request path.
  }
}
