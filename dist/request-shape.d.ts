import { z } from "zod";
import { type ToolNameMap } from "./names";
declare const JsonRecordSchema: z.ZodObject<{
    type: z.ZodOptional<z.ZodUnknown>;
    name: z.ZodOptional<z.ZodUnknown>;
    text: z.ZodOptional<z.ZodUnknown>;
    content: z.ZodOptional<z.ZodUnknown>;
    model: z.ZodOptional<z.ZodUnknown>;
    messages: z.ZodOptional<z.ZodUnknown>;
    tools: z.ZodOptional<z.ZodUnknown>;
    system: z.ZodOptional<z.ZodUnknown>;
    metadata: z.ZodOptional<z.ZodUnknown>;
}, z.core.$catchall<z.ZodUnknown>>;
export type JsonRecord = z.infer<typeof JsonRecordSchema>;
export declare const CLAUDE_CODE_BETA = "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,effort-2025-11-24";
export declare const CLAUDE_CODE_USER_AGENT = "claude-cli/2.1.74 (external, sdk-cli)";
export declare const CLAUDE_CODE_SYSTEM_TEXT = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
export declare const DEFAULT_SYSTEM_TEXT = "You are an expert coding assistant operating inside pi.";
export declare const CLAUDE_CODE_BILLING_TEXT = "x-anthropic-billing-header: cc_version=2.1.74.7f2; cc_entrypoint=sdk-cli; cch=00000;";
export type RewrittenRequest = {
    readonly body: JsonRecord;
    readonly toolNames: ToolNameMap;
};
export declare const parseBody: (raw: string) => JsonRecord | undefined;
export declare const rewriteBody: (body: JsonRecord, workingDirectory: string) => RewrittenRequest;
export {};
