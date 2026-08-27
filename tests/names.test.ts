import { describe, expect, it } from "bun:test"
import { fromClaudeCodeToolName, toClaudeCodeToolName, toolNameMap } from "../src/names"

describe("Claude Code tool names", () => {
  it("maps registered OpenCode tools without an unsupported list alias", () => {
    expect(toClaudeCodeToolName("glob")).toBe("Glob")
    expect(fromClaudeCodeToolName("Glob", toolNameMap)).toBe("glob")
    expect(toClaudeCodeToolName("list")).toBe("List")
  })

  it("contains only OpenCode tool mappings", () => {
    expect(Object.keys(toolNameMap)).toEqual([
      "read",
      "write",
      "edit",
      "bash",
      "grep",
      "glob",
      "todowrite",
      "webfetch",
      "websearch",
    ])
    expect(toClaudeCodeToolName("find")).toBe("Find")
  })
})
