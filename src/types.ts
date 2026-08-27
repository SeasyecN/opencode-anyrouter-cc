export type AuthConfig =
  | { readonly kind: "bearer"; readonly value: string }
  | { readonly kind: "api-key"; readonly value: string }

export type GatewayConfig = {
  readonly baseUrl: string
  readonly auth: AuthConfig
}

export type SettingsReader = (path: string) => Promise<string | undefined>

export type AnyRouterPluginOptions = {
  readonly baseUrl?: string
  readonly authToken?: string
  readonly apiKey?: string
  readonly cwd?: string
  readonly homeDir?: string
  readonly environment?: Readonly<Record<string, string | undefined>>
  readonly readFile?: SettingsReader
}
