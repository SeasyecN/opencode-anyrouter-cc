import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AnyRouterPluginOptions, GatewayConfig, SettingsReader } from "./types"

const SettingsSchema = z.object({
  env: z.record(z.string(), z.string()).optional(),
})

type ConfigSource = Readonly<{
  readonly ANTHROPIC_BASE_URL?: string | undefined
  readonly ANTHROPIC_AUTH_TOKEN?: string | undefined
  readonly ANTHROPIC_API_KEY?: string | undefined
  readonly [key: string]: string | undefined
}>

export class InvalidGatewayConfigurationError extends Error {
  readonly name = "InvalidGatewayConfigurationError"
}

const defaultReadFile: SettingsReader = async (path) => {
  const file = Bun.file(path)
  if (!(await file.exists())) return undefined
  return await file.text()
}

const parseJson = (raw: string): unknown => JSON.parse(raw)

const readSettings = async (
  path: string,
  readFile: SettingsReader,
): Promise<ConfigSource | undefined> => {
  const raw = await readFile(path)
  if (raw === undefined) return undefined

  let parsed: unknown
  try {
    parsed = parseJson(raw)
  } catch (error) {
    if (error instanceof SyntaxError) return undefined
    throw error
  }

  const settings = SettingsSchema.safeParse(parsed)
  return settings.success ? settings.data.env : undefined
}

const cleanValue = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const cleaned = value.trim()
  return cleaned.length === 0 ? undefined : cleaned
}

const firstValue = (sources: readonly ConfigSource[], key: string): string | undefined => {
  for (const source of sources) {
    const value = cleanValue(source[key])
    if (value !== undefined) return value
  }
  return undefined
}

const firstAuth = (sources: readonly ConfigSource[]): GatewayConfig["auth"] | undefined => {
  for (const source of sources) {
    const authToken = cleanValue(source.ANTHROPIC_AUTH_TOKEN)
    if (authToken !== undefined) return { kind: "bearer", value: authToken }

    const apiKey = cleanValue(source.ANTHROPIC_API_KEY)
    if (apiKey !== undefined) return { kind: "api-key", value: apiKey }
  }
  return undefined
}

export const normalizeBaseUrl = (baseUrl: string): string => {
  const value = baseUrl.trim()
  const parsed = new URL(value)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidGatewayConfigurationError("base URL must use HTTP or HTTPS")
  }

  const pathname = parsed.pathname.replace(/\/+$/, "")
  parsed.pathname = pathname.endsWith("/v1") ? pathname : `${pathname}/v1`
  parsed.search = ""
  parsed.hash = ""
  return parsed.toString().replace(/\/$/, "")
}

export const resolveGatewayConfig = async (
  options: AnyRouterPluginOptions = {},
): Promise<GatewayConfig | undefined> => {
  const cwd = options.cwd ?? process.cwd()
  const homeDir = options.homeDir ?? homedir()
  const environment = options.environment ?? process.env
  const explicit: ConfigSource = {
    ANTHROPIC_BASE_URL: options.baseUrl,
    ANTHROPIC_AUTH_TOKEN: options.authToken,
    ANTHROPIC_API_KEY: options.apiKey,
  }
  const settingsPaths = [
    join(cwd, ".claude", "settings.local.json"),
    join(cwd, ".claude", "settings.json"),
    join(homeDir, ".claude", "settings.json"),
  ]
  const readFile = options.readFile ?? defaultReadFile
  const settings = await Promise.all(settingsPaths.map((path) => readSettings(path, readFile)))
  const sources = [
    explicit,
    environment,
    ...settings.filter((source): source is ConfigSource => source !== undefined),
  ]
  const baseUrl = firstValue(sources, "ANTHROPIC_BASE_URL")
  const auth = firstAuth(sources)
  if (baseUrl === undefined || auth === undefined) return undefined

  return { baseUrl: normalizeBaseUrl(baseUrl), auth }
}
