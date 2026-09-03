import { createHash, randomUUID } from "node:crypto"
import { homedir, hostname } from "node:os"
import { z } from "zod"
import { type ToolNameMap, toClaudeCodeToolName, toolNameMap } from "./names"

const JsonRecordSchema = z
  .object({
    type: z.unknown().optional(),
    name: z.unknown().optional(),
    text: z.unknown().optional(),
    content: z.unknown().optional(),
    model: z.unknown().optional(),
    stream: z.unknown().optional(),
    messages: z.unknown().optional(),
    tools: z.unknown().optional(),
    system: z.unknown().optional(),
    metadata: z.unknown().optional(),
  })
  .catchall(z.unknown())

export type JsonRecord = z.infer<typeof JsonRecordSchema>

// Everything below is captured verbatim from claude-cli 2.1.258 (the version installed
// here) by pointing ANTHROPIC_BASE_URL at a local listener. The gateway routes, bills,
// and caches on client shape, so these must stay in sync with a real Claude Code
// request. 2.1.258 lists `context-1m-2025-08-07` once; older builds sent it twice.
export const CLAUDE_CODE_BETA =
  "claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,context-1m-2025-08-07,advanced-tool-use-2025-11-20,effort-2025-11-24,fallback-credit-2026-06-01"
export const CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.258 (external, sdk-cli)"
export const CLAUDE_CODE_SYSTEM_TEXT =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK."

// AnyRouter's own billing protocol, not part of the Anthropic API: the gateway reads this
// system block, strips it, and forwards the rest upstream — verified by the fact that
// adding it still hits the same prompt cache. The text is what claude-cli 2.1.258 emits
// with CLAUDE_CODE_ATTRIBUTION_HEADER on; 2.1.258 no longer appends a `cch=` field.
export const CLAUDE_CODE_BILLING_TEXT =
  "x-anthropic-billing-header: cc_version=2.1.258.1e2; cc_entrypoint=sdk-cli;"

const CLAUDE_CODE_BILLING_PREFIX = "x-anthropic-billing-header: cc_version="

// The Anthropic SDK fingerprint Claude Code carries. `x-stainless-os: Windows` is what
// this machine actually sends (injected via ANTHROPIC_CUSTOM_HEADERS), not the real OS.
export const CLAUDE_CODE_STAINLESS_HEADERS: Readonly<Record<string, string>> = {
  "x-stainless-arch": "x64",
  "x-stainless-lang": "js",
  "x-stainless-os": "Windows",
  "x-stainless-package-version": "0.112.1",
  "x-stainless-retry-count": "0",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v26.3.0",
  "x-stainless-timeout": "3000",
}

// Claude Code holds one session id for the whole session and sends it twice: in
// metadata.user_id and in the x-claude-code-session-id header. Minting a fresh uuid per
// request makes the gateway treat every call as a new session, which reroutes it to a
// different upstream account and drops the prompt cache.
export const SESSION_ID = randomUUID()

// Claude Code's device id identifies the machine, not the project directory.
const DEVICE_ID = createHash("sha256")
  .update(`anyrouter-cc:${hostname()}:${homedir()}`)
  .digest("hex")

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

// Returns undefined when the caller supplied no system text at all. Callers then emit
// only the Claude Code prefix, which is exactly what real claude-cli sends when it has
// no extra system prompt — inventing filler text here would put a system block on the
// wire that no Claude Code client would ever send.
const systemText = (system: unknown): string | undefined => {
  if (typeof system === "string" && system.trim().length > 0) return sanitizeText(system)
  if (!Array.isArray(system)) return undefined

  const text = system
    .map((item) => {
      if (typeof item === "string") return item
      const block = JsonRecordSchema.safeParse(item)
      const value = block.success ? block.data.text : undefined
      return typeof value === "string" ? value : JSON.stringify(item)
    })
    .filter((item): item is string => item !== undefined && item.trim().length > 0)
    .join("\n\n")
  return text.length > 0 ? sanitizeText(text) : undefined
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
  if (blocks.length > 0) return blocks
  const text = systemText(system)
  return text === undefined ? [] : [{ type: "text", text, cache_control: { type: "ephemeral" } }]
}

const mappedSystem = (system: unknown): unknown[] => {
  // The billing block is consumed and stripped by the gateway, so what actually reaches
  // upstream is Claude Code's two-block shape: agent identity, then the real prompt.
  const prefix = [
    { type: "text", text: CLAUDE_CODE_BILLING_TEXT },
    {
      type: "text",
      text: CLAUDE_CODE_SYSTEM_TEXT,
      cache_control: { type: "ephemeral" },
    },
  ]
  if (!Array.isArray(system)) {
    const text = systemText(system)
    return text === undefined
      ? [...prefix]
      : [...prefix, { type: "text", text, cache_control: { type: "ephemeral" } }]
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

const mappedMetadata = (metadata: unknown): JsonRecord => {
  const source = JsonRecordSchema.safeParse(metadata)
  return {
    ...(source.success ? source.data : {}),
    // Claude Code encodes user_id as a JSON string, not the older flat
    // user_<hash>_account__session_<uuid> form, and holds it for the whole session.
    user_id: JSON.stringify({
      device_id: DEVICE_ID,
      account_uuid: "",
      session_id: SESSION_ID,
    }),
  }
}

export const rewriteBody = (body: JsonRecord): RewrittenRequest => {
  const rewrittenBody: JsonRecord = {
    ...body,
    model: typeof body.model === "string" ? body.model.replace(/\[1m\]$/i, "") : body.model,
    // Pass the caller's streaming choice through. Real claude-cli streams, so forcing
    // this to false was the one place this request diverged from the shape everything
    // else here works to reproduce. Normalized to a boolean so the field is always
    // present and the response side can branch on it without re-reading the body.
    stream: body.stream === true,
    messages: mappedMessages(body.messages),
    tools: mappedTools(body.tools),
    system: mappedSystem(body.system),
    metadata: mappedMetadata(body.metadata),
  }
  return { body: rewrittenBody, toolNames: toolNameMap }
}
