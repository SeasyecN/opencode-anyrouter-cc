import { z } from "zod";
import { type ToolNameMap } from "./names";
declare const JsonRecordSchema: z.ZodObject<{
    type: z.ZodOptional<z.ZodUnknown>;
    name: z.ZodOptional<z.ZodUnknown>;
    text: z.ZodOptional<z.ZodUnknown>;
    content: z.ZodOptional<z.ZodUnknown>;
    model: z.ZodOptional<z.ZodUnknown>;
    stream: z.ZodOptional<z.ZodUnknown>;
    messages: z.ZodOptional<z.ZodUnknown>;
    tools: z.ZodOptional<z.ZodUnknown>;
    system: z.ZodOptional<z.ZodUnknown>;
    metadata: z.ZodOptional<z.ZodUnknown>;
}, z.core.$catchall<z.ZodUnknown>>;
export type JsonRecord = z.infer<typeof JsonRecordSchema>;
export declare const CLAUDE_CODE_BETA = "claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,context-1m-2025-08-07,advanced-tool-use-2025-11-20,effort-2025-11-24,fallback-credit-2026-06-01";
export declare const CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.258 (external, sdk-cli)";
export declare const CLAUDE_CODE_SYSTEM_TEXT = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
export declare const CLAUDE_CODE_BILLING_TEXT = "x-anthropic-billing-header: cc_version=2.1.258.1e2; cc_entrypoint=sdk-cli;";
export declare const CLAUDE_CODE_STAINLESS_HEADERS: Readonly<Record<string, string>>;
export declare const SESSION_ID: `${string}-${string}-${string}-${string}-${string}`;
export type RewrittenRequest = {
    readonly body: JsonRecord;
    readonly toolNames: ToolNameMap;
};
export declare const parseBody: (raw: string) => JsonRecord | undefined;
export declare const rewriteBody: (body: JsonRecord) => RewrittenRequest;
export {};
