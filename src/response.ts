import { z } from "zod"
import { fromClaudeCodeToolName } from "./names"

const TextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
})

const ToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
})

const ThinkingBlockSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().optional().default(""),
})

const RedactedThinkingBlockSchema = z.object({
  type: z.literal("redacted_thinking"),
  data: z.string(),
})

const ContentBlockSchema = z.discriminatedUnion("type", [
  TextBlockSchema,
  ToolUseBlockSchema,
  ThinkingBlockSchema,
  RedactedThinkingBlockSchema,
])

const MessageSchema = z.object({
  id: z.string(),
  type: z.literal("message"),
  role: z.literal("assistant"),
  model: z.string(),
  content: z.array(ContentBlockSchema),
  stop_reason: z.string().nullable(),
  stop_sequence: z.string().nullable(),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
    })
    .passthrough(),
})

type AnthropicMessage = z.infer<typeof MessageSchema>
type ContentBlock = AnthropicMessage["content"][number]
type SupportedContentBlock = Exclude<ContentBlock, { type: "redacted_thinking" }>
type ResponseOptions = {
  readonly toolNameMap?: Readonly<Record<string, string>>
}

const parseJson = (raw: string): unknown => JSON.parse(raw)

const eventFrame = (event: string, data: Readonly<Record<string, unknown>>): string =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

const messageStart = (message: AnthropicMessage): string =>
  eventFrame("message_start", {
    type: "message_start",
    message: {
      id: message.id,
      type: message.type,
      role: message.role,
      model: message.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      // Pass the whole usage object through. cache_creation_input_tokens and
      // cache_read_input_tokens live here, and dropping them makes every response look
      // like a cache miss to OpenCode even when the gateway served a hit. Claude Code's
      // own message_start carries these fields too.
      usage: { ...message.usage, output_tokens: 0 },
    },
  })

const contentBlockFrames = (
  block: SupportedContentBlock,
  index: number,
  toolNameMap: Readonly<Record<string, string>>,
): string => {
  switch (block.type) {
    case "text":
      return [
        eventFrame("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        }),
        ...(block.text.length > 0
          ? [
              eventFrame("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: { type: "text_delta", text: block.text },
              }),
            ]
          : []),
        eventFrame("content_block_stop", { type: "content_block_stop", index }),
      ].join("")
    case "tool_use":
      return [
        eventFrame("content_block_start", {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: block.id,
            name: fromClaudeCodeToolName(block.name, toolNameMap),
            input: {},
          },
        }),
        eventFrame("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input ?? {}) ?? "{}",
          },
        }),
        eventFrame("content_block_stop", { type: "content_block_stop", index }),
      ].join("")
    case "thinking":
      return [
        eventFrame("content_block_start", {
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "" },
        }),
        ...(block.thinking.length > 0
          ? [
              eventFrame("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: { type: "thinking_delta", thinking: block.thinking },
              }),
            ]
          : []),
        ...(block.signature.length > 0
          ? [
              eventFrame("content_block_delta", {
                type: "content_block_delta",
                index,
                delta: { type: "signature_delta", signature: block.signature },
              }),
            ]
          : []),
        eventFrame("content_block_stop", { type: "content_block_stop", index }),
      ].join("")
    default:
      return assertNever(block)
  }
}

const isSupportedContentBlock = (block: ContentBlock): block is SupportedContentBlock =>
  block.type !== "redacted_thinking"

const assertNever = (value: never): never => {
  throw new Error(`Unexpected Anthropic content block: ${String(value)}`)
}

const messageEnd = (message: AnthropicMessage): string =>
  [
    eventFrame("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: message.stop_reason,
        stop_sequence: message.stop_sequence,
      },
      usage: { output_tokens: message.usage.output_tokens },
    }),
    eventFrame("message_stop", { type: "message_stop" }),
  ].join("")

const passThrough = (raw: string, response: Response): Response => {
  const headers = new Headers(response.headers)
  return new Response(raw, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

// --- streaming path -------------------------------------------------------
// When the gateway streams, the frames are already the shape OpenCode wants. The only
// field that still has to be touched is the tool name inside content_block_start, so
// every other frame is forwarded byte-for-byte, separator included.

const DATA_PREFIX = "data:"

// Anthropic emits \n\n, but accept \r\n\r\n too rather than silently buffering the whole
// response when a proxy rewrites line endings.
const FRAME_SEPARATORS = ["\r\n\r\n", "\n\n"] as const

type FrameBoundary = { readonly end: number; readonly next: number }

const nextFrameBoundary = (buffer: string): FrameBoundary | undefined => {
  let found: FrameBoundary | undefined
  for (const separator of FRAME_SEPARATORS) {
    const index = buffer.indexOf(separator)
    if (index === -1) continue
    if (found === undefined || index < found.end) {
      found = { end: index, next: index + separator.length }
    }
  }
  return found
}

const dataValue = (line: string): string | undefined => {
  if (!line.startsWith(DATA_PREFIX)) return undefined
  const rest = line.slice(DATA_PREFIX.length)
  return rest.startsWith(" ") ? rest.slice(1) : rest
}

const ToolUseStartSchema = z
  .object({
    type: z.literal("content_block_start"),
    content_block: z
      .object({
        type: z.literal("tool_use"),
        name: z.string(),
      })
      .passthrough(),
  })
  .passthrough()

const withRewrittenData = (lines: readonly string[], data: string): string => {
  let replaced = false
  return lines
    .flatMap((line) => {
      if (dataValue(line) === undefined) return [line]
      if (replaced) return []
      replaced = true
      return [`${DATA_PREFIX} ${data}`]
    })
    .join("\n")
}

const rewriteFrame = (frame: string, toolNameMap: Readonly<Record<string, string>>): string => {
  const lines = frame.split("\n")
  const payload = lines
    .map(dataValue)
    .filter((value): value is string => value !== undefined)
    .join("\n")
  if (payload.length === 0) return frame

  let parsed: unknown
  try {
    parsed = parseJson(payload)
  } catch (error) {
    if (error instanceof SyntaxError) return frame
    throw error
  }

  const start = ToolUseStartSchema.safeParse(parsed)
  if (!start.success) return frame

  const name = fromClaudeCodeToolName(start.data.content_block.name, toolNameMap)
  if (name === start.data.content_block.name) return frame

  return withRewrittenData(
    lines,
    JSON.stringify({
      ...start.data,
      content_block: { ...start.data.content_block, name },
    }),
  )
}

const createSseToolNameTransform = (
  toolNameMap: Readonly<Record<string, string>>,
): TransformStream<Uint8Array, Uint8Array> => {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      for (;;) {
        const boundary = nextFrameBoundary(buffer)
        if (boundary === undefined) break
        const frame = buffer.slice(0, boundary.end)
        const separator = buffer.slice(boundary.end, boundary.next)
        buffer = buffer.slice(boundary.next)
        controller.enqueue(encoder.encode(`${rewriteFrame(frame, toolNameMap)}${separator}`))
      }
    },
    flush(controller) {
      buffer += decoder.decode()
      if (buffer.length > 0) controller.enqueue(encoder.encode(buffer))
    },
  })
}

export const streamAnthropicSse = (response: Response, options: ResponseOptions = {}): Response => {
  if (response.body === null) return response
  const headers = new Headers(response.headers)
  // fetch already decoded the body, and neither length nor encoding survives the rewrite.
  headers.delete("content-length")
  headers.delete("content-encoding")
  return new Response(
    response.body.pipeThrough(createSseToolNameTransform(options.toolNameMap ?? {})),
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  )
}

const isEventStream = (response: Response): boolean =>
  (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")

// Stream through when the gateway streams; fall back to synthesizing SSE from a whole
// JSON message when it answers a streaming request with one anyway.
export const adaptAnthropicResponse = async (
  response: Response,
  options: ResponseOptions = {},
): Promise<Response> => {
  if (response.status < 200 || response.status >= 300) return response
  if (isEventStream(response)) return streamAnthropicSse(response, options)
  return await convertAnthropicResponseToSse(response, options)
}

export const convertAnthropicResponseToSse = async (
  response: Response,
  options: ResponseOptions = {},
): Promise<Response> => {
  if (response.status < 200 || response.status >= 300) return response

  const raw = await response.text()
  let parsed: unknown
  try {
    parsed = parseJson(raw)
  } catch (error) {
    if (error instanceof SyntaxError) return passThrough(raw, response)
    throw error
  }

  const message = MessageSchema.safeParse(parsed)
  if (!message.success) return passThrough(raw, response)

  const toolNameMap = options.toolNameMap ?? {}
  const frames = [
    messageStart(message.data),
    ...message.data.content
      .filter(isSupportedContentBlock)
      .map((block, index) => contentBlockFrames(block, index, toolNameMap)),
    messageEnd(message.data),
  ]
  const headers = new Headers(response.headers)
  headers.set("content-type", "text/event-stream")
  headers.delete("content-length")
  headers.set("cache-control", "no-cache")
  return new Response(frames.join(""), {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
