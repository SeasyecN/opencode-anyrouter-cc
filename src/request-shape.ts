import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { type ToolNameMap, toClaudeCodeToolName, toolNameMap } from "./names"

const JsonRecordSchema = z
  .object({
    type: z.unknown().optional(),
    name: z.unknown().optional(),
    text: z.unknown().optional(),
    content: z.unknown().optional(),
    model: z.unknown().optional(),
    messages: z.unknown().optional(),
    tools: z.unknown().optional(),
    system: z.unknown().optional(),
    metadata: z.unknown().optional(),
  })
  .catchall(z.unknown())

export type JsonRecord = z.infer<typeof JsonRecordSchema>

export const CLAUDE_CODE_BETA =
  "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24"
export const CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.74 (external, sdk-cli)"
export const CLAUDE_CODE_SYSTEM_TEXT =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK."
export const DEFAULT_SYSTEM_TEXT = "You are an expert coding assistant operating inside pi."
export const CLAUDE_CODE_BILLING_TEXT =
  "x-anthropic-billing-header: cc_version=2.1.74.7f2; cc_entrypoint=sdk-cli; cch=00000;"

const CLAUDE_CODE_BILLING_PREFIX = "x-anthropic-billing-header: cc_version="
const CLAUDE_CODE_SYSTEM_PREFIX = "You are a Claude agent, built on Anthropic's Claude Agent SDK."

export type RewrittenRequest = {
  readonly body: JsonRecord
  readonly toolNames: ToolNameMap
}

export const parseBody = (raw: string): JsonRecord | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }
  const body = JsonRecordSchema.safeParse(parsed)
  return body.success ? body.data : undefined
}

const mappedContent = (content: unknown): unknown => {
  if (!Array.isArray(content)) return content
  return content.map((item) => {
    const block = JsonRecordSchema.safeParse(item)
    if (!block.success || block.data.type !== "tool_use") return item
    const name = block.data.name
    return typeof name === "string" ? { ...block.data, name: toClaudeCodeToolName(name) } : item
  })
}

const mappedMessages = (messages: unknown): unknown => {
  if (!Array.isArray(messages)) return messages
  return messages.map((item) => {
    const message = JsonRecordSchema.safeParse(item)
    if (!message.success) return item
    return { ...message.data, content: mappedContent(message.data.content) }
  })
}

const mappedTools = (tools: unknown): unknown => {
  if (!Array.isArray(tools)) return tools
  return tools.map((item) => {
    const tool = JsonRecordSchema.safeParse(item)
    if (!tool.success) return item
    const name = tool.data.name
    return typeof name === "string" ? { ...tool.data, name: toClaudeCodeToolName(name) } : item
  })
}

const sanitizeText = (text: string): string => text.replace(/[\uD800-\uDFFF]/g, "\uFFFD")

const systemText = (system: unknown): string => {
  if (typeof system === "string" && system.trim().length > 0) return sanitizeText(system)
  if (!Array.isArray(system)) return DEFAULT_SYSTEM_TEXT

  const text = system
    .map((item) => {
      if (typeof item === "string") return item
      const block = JsonRecordSchema.safeParse(item)
      const value = block.success ? block.data.text : undefined
      return typeof value === "string" ? value : JSON.stringify(item)
    })
    .filter((item): item is string => item !== undefined && item.trim().length > 0)
    .join("\n\n")
  return text.length > 0 ? sanitizeText(text) : DEFAULT_SYSTEM_TEXT
}

const textBlock = (value: unknown): JsonRecord | undefined => {
  const block = JsonRecordSchema.safeParse(value)
  if (!block.success || block.data.type !== "text" || typeof block.data.text !== "string")
    return undefined
  return block.data
}

const hasSystemText = (system: readonly unknown[], prefix: string): boolean =>
  system.some((item) => {
    const text = textBlock(item)?.text
    return typeof text === "string" && text.startsWith(prefix)
  })

const normalizedSystemBlocks = (system: readonly unknown[]): unknown[] => {
  const blocks = system.flatMap((item) => {
    if (typeof item === "string") return [{ type: "text", text: sanitizeText(item) }]
    const block = JsonRecordSchema.safeParse(item)
    if (!block.success) return []
    if (typeof block.data.text !== "string") return [block.data]
    return [{ ...block.data, text: sanitizeText(block.data.text) }]
  })
  return blocks.length > 0
    ? blocks
    : [{ type: "text", text: systemText(system), cache_control: { type: "ephemeral" } }]
}

const mappedSystem = (system: unknown): unknown[] => {
  const prefix = [
    { type: "text", text: CLAUDE_CODE_BILLING_TEXT },
    {
      type: "text",
      text: CLAUDE_CODE_SYSTEM_TEXT,
      cache_control: { type: "ephemeral" },
    },
  ]
  if (!Array.isArray(system)) {
    return [
      ...prefix,
      { type: "text", text: systemText(system), cache_control: { type: "ephemeral" } },
    ]
  }

  const hasBilling = hasSystemText(system, CLAUDE_CODE_BILLING_PREFIX)
  const hasIdentity = hasSystemText(system, CLAUDE_CODE_SYSTEM_PREFIX)
  if (hasBilling && hasIdentity) return [...system]
  return [
    ...(hasBilling ? [] : [prefix[0]]),
    ...(hasIdentity ? [] : [prefix[1]]),
    ...normalizedSystemBlocks(system),
  ]
}

const mappedMetadata = (metadata: unknown, workingDirectory: string): JsonRecord => {
  const source = JsonRecordSchema.safeParse(metadata)
  const accountHash = createHash("sha256").update(`anyrouter-cc:${workingDirectory}`).digest("hex")
  const sessionPrefix = `user_${accountHash}_account__session_`
  const existingUserId = source.success ? source.data["user_id"] : undefined
  const userId =
    typeof existingUserId === "string" && existingUserId.startsWith(sessionPrefix)
      ? existingUserId
      : `${sessionPrefix}${randomUUID()}`
  return {
    ...(source.success ? source.data : {}),
    user_id: userId,
  }
}

export const rewriteBody = (body: JsonRecord, workingDirectory: string): RewrittenRequest => {
  const rewrittenBody: JsonRecord = {
    ...body,
    model: typeof body.model === "string" ? body.model.replace(/\[1m\]$/i, "") : body.model,
    stream: false,
    messages: mappedMessages(body.messages),
    tools: mappedTools(body.tools),
    system: mappedSystem(body.system),
    metadata: mappedMetadata(body.metadata, workingDirectory),
  }
  return { body: rewrittenBody, toolNames: toolNameMap }
}
