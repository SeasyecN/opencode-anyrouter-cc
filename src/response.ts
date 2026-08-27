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
      usage: { input_tokens: message.usage.input_tokens, output_tokens: 0 },
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
