export type ToolNameMap = Readonly<Record<string, string>>;
export declare const toolNameMap: ToolNameMap;
export declare const toClaudeCodeToolName: (name: string) => string;
export declare const fromClaudeCodeToolName: (name: string, map: ToolNameMap) => string;
