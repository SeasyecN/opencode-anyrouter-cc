import { describe, expect, it } from "bun:test"
import { normalizeBaseUrl, resolveGatewayConfig } from "../src/config"

type SettingsFiles = Readonly<Record<string, string>>

const readSettings =
  (files: SettingsFiles, reads: string[]): ((path: string) => Promise<string | undefined>) =>
  async (path) => {
    reads.push(path)
    return files[path]
  }

describe("normalizeBaseUrl", () => {
  it("normalizes URLs with and without the Anthropic API version", () => {
    expect(normalizeBaseUrl("https://router.example")).toBe("https://router.example/v1")
    expect(normalizeBaseUrl("https://router.example/")).toBe("https://router.example/v1")
    expect(normalizeBaseUrl("https://router.example/v1")).toBe("https://router.example/v1")
    expect(normalizeBaseUrl("https://router.example/v1/")).toBe("https://router.example/v1")
  })
})

describe("resolveGatewayConfig", () => {
  it("prefers explicit options over environment and settings files", async () => {
    const reads: string[] = []
    const config = await resolveGatewayConfig({
      baseUrl: "https://explicit.example",
      authToken: "explicit-token",
      apiKey: "ignored-explicit-key",
      cwd: "/project",
      homeDir: "/home/test",
      environment: {
        ANTHROPIC_BASE_URL: "https://environment.example",
        ANTHROPIC_AUTH_TOKEN: "environment-token",
      },
      readFile: readSettings(
        {
          "/project/.claude/settings.local.json": JSON.stringify({
            env: {
              ANTHROPIC_BASE_URL: "https://local.example",
              ANTHROPIC_AUTH_TOKEN: "local-token",
            },
          }),
          "/project/.claude/settings.json": JSON.stringify({
            env: {
              ANTHROPIC_BASE_URL: "https://project.example",
              ANTHROPIC_AUTH_TOKEN: "project-token",
            },
          }),
          "/home/test/.claude/settings.json": JSON.stringify({
            env: {
              ANTHROPIC_BASE_URL: "https://user.example",
              ANTHROPIC_AUTH_TOKEN: "user-token",
            },
          }),
        },
        reads,
      ),
    })

    expect(config).toEqual({
      baseUrl: "https://explicit.example/v1",
      auth: { kind: "bearer", value: "explicit-token" },
    })
    expect(reads).not.toContain("/home/test/.claude.json")
  })

  it("falls back through project-local, project, and user settings", async () => {
    const config = await resolveGatewayConfig({
      cwd: "/project",
      homeDir: "/home/test",
      environment: {},
      readFile: readSettings(
        {
          "/project/.claude/settings.local.json": "{}",
          "/project/.claude/settings.json": JSON.stringify({
            env: {
              ANTHROPIC_BASE_URL: "https://project.example",
              ANTHROPIC_API_KEY: "project-key",
            },
          }),
          "/home/test/.claude/settings.json": JSON.stringify({
            env: {
              ANTHROPIC_BASE_URL: "https://user.example",
              ANTHROPIC_API_KEY: "user-key",
            },
          }),
        },
        [],
      ),
    })

    expect(config).toEqual({
      baseUrl: "https://project.example/v1",
      auth: { kind: "api-key", value: "project-key" },
    })
  })

  it("uses user settings when project settings do not define the gateway", async () => {
    const config = await resolveGatewayConfig({
      cwd: "/project",
      homeDir: "/home/test",
      environment: {},
      readFile: readSettings(
        {
          "/project/.claude/settings.local.json": "{}",
          "/project/.claude/settings.json": "{}",
          "/home/test/.claude/settings.json": JSON.stringify({
            env: {
              ANTHROPIC_BASE_URL: "https://user.example",
              ANTHROPIC_API_KEY: "user-key",
            },
          }),
        },
        [],
      ),
    })

    expect(config).toEqual({
      baseUrl: "https://user.example/v1",
      auth: { kind: "api-key", value: "user-key" },
    })
  })

  it("prefers project-local settings over project and user settings", async () => {
    const config = await resolveGatewayConfig({
      cwd: "/project",
      homeDir: "/home/test",
      environment: {},
      readFile: readSettings(
        {
          "/project/.claude/settings.local.json": JSON.stringify({
            env: {
              ANTHROPIC_BASE_URL: "https://local.example",
              ANTHROPIC_AUTH_TOKEN: "local-token",
            },
          }),
          "/project/.claude/settings.json": JSON.stringify({
            env: {
              ANTHROPIC_BASE_URL: "https://project.example",
              ANTHROPIC_AUTH_TOKEN: "project-token",
            },
          }),
          "/home/test/.claude/settings.json": JSON.stringify({
            env: {
              ANTHROPIC_BASE_URL: "https://user.example",
              ANTHROPIC_AUTH_TOKEN: "user-token",
            },
          }),
        },
        [],
      ),
    })

    expect(config).toEqual({
      baseUrl: "https://local.example/v1",
      auth: { kind: "bearer", value: "local-token" },
    })
  })

  it("prefers an auth token over an API key at the selected source", async () => {
    const config = await resolveGatewayConfig({
      baseUrl: "https://explicit.example",
      environment: {
        ANTHROPIC_AUTH_TOKEN: "bearer-token",
        ANTHROPIC_API_KEY: "api-key",
      },
      readFile: async () => undefined,
    })

    expect(config).toEqual({
      baseUrl: "https://explicit.example/v1",
      auth: { kind: "bearer", value: "bearer-token" },
    })
  })

  it("returns no configuration without exposing a credential", async () => {
    const secret = "secret-that-must-not-escape"
    const config = await resolveGatewayConfig({
      apiKey: secret,
      environment: {},
      readFile: async () => undefined,
    })

    expect(config).toBeUndefined()
    expect(JSON.stringify(config ?? null)).not.toContain(secret)
  })
})
