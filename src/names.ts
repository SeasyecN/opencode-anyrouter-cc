const CLAUDE_CODE_TOOL_NAMES = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  todowrite: "TodoWrite",
  webfetch: "WebFetch",
  websearch: "WebSearch",
} as const

export type ToolNameMap = Readonly<Record<string, string>>

export const toolNameMap: ToolNameMap = CLAUDE_CODE_TOOL_NAMES

export const toClaudeCodeToolName = (name: string): string => {
  const mapped = Object.entries(CLAUDE_CODE_TOOL_NAMES).find(
    ([source]) => source === name.toLowerCase(),
  )?.[1]
  return mapped ?? `${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

export const fromClaudeCodeToolName = (name: string, map: ToolNameMap): string => {
  for (const [source, target] of Object.entries(map)) {
    if (target.toLowerCase() === name.toLowerCase()) return source
  }
  return name.charAt(0).toLowerCase() + name.slice(1)
}
