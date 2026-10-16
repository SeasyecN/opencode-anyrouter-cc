# @seasyecn/opencode-anyrouter-cc

Native OpenCode V2 provider for AnyRouter's Claude Code-compatible gateway.
It registers `anyrouter-cc/claude-fable-5-1[1m]` and `anyrouter-cc/claude-opus-5[1m]`,
sends `claude-fable-5-1` / `claude-opus-5` upstream, and adapts the provider request to
`POST /v1/messages?beta=true` in the shape claude-cli 2.1.258 sends.

## Requirements and migration

Version **0.2.0 targets OpenCode 2.0.30** and pins `@opencode/plugin` to **2.0.30**.
It uses `Plugin.define`, a synchronous `ctx.provider.transform` that contributes
the provider and models, and provider-scoped native `http.request` / `http.response`
hooks. It does not rely on V1 `config` hooks, `npm`, or `options.fetch`.

This release is V2-only; use 0.1.0 for V1. Change the V1 `plugin` array to the
native V2 `plugins` array. Replace `[package, options]` tuples with
`{ "package": "...", "options": { ... } }`. Existing gateway option names,
environment variables, settings-file precedence and model aliases are unchanged.

## Local Installation

Build the package from this checkout:

```bash
git clone https://github.com/SeasyecN/opencode-anyrouter-cc.git opencode-anyrouter-cc
cd opencode-anyrouter-cc
bun install
bun run build
```

Print the absolute file URI for the built plugin:

```bash
printf 'file://%s\n' "$(realpath dist/index.js)"
```

Add the printed URI to the OpenCode `plugins` array in the project `opencode.json`
(or the user config):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///absolute/path/to/opencode-anyrouter-cc/dist/index.js"]
}
```

Restart OpenCode after changing the plugin list.

## npm Installation (after 0.2.0 is published)

Use a pinned remote package in the OpenCode `plugins` array. OpenCode installs
package plugins automatically; a local clone or `bun add` is not required:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@seasyecn/opencode-anyrouter-cc@0.2.0"]
}
```

Restart OpenCode after changing the plugin list.

## Gateway Configuration

The resolver checks these sources in order:

1. Plugin options (`baseUrl`, `authToken`, `apiKey`)
2. Process environment
3. Project `.claude/settings.local.json`
4. Project `.claude/settings.json`
5. User `~/.claude/settings.json`

For normal local use, set the gateway variables in the environment:

```bash
export ANTHROPIC_BASE_URL=https://anyrouter.top
export ANTHROPIC_AUTH_TOKEN=your-token
```

`ANTHROPIC_AUTH_TOKEN` is sent as `Authorization: Bearer ...`. When it is
absent, `ANTHROPIC_API_KEY` is sent as `x-api-key`. Base URLs with or without
`/v1` are accepted. The plugin never reads `~/.claude.json`, invokes
`apiKeyHelper`, changes `globalThis.fetch`, logs credentials, or writes gateway
configuration.

For a per-plugin base URL override (credentials can remain in the environment):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@seasyecn/opencode-anyrouter-cc@0.2.0",
      "options": { "baseUrl": "https://anyrouter.top" }
    }
  ]
}
```

The provider is registered only when both a base URL and credentials resolve.
Resolution happens during plugin setup; reload the plugin after changing them.
No default model or other provider is changed. The native Anthropic runtime
handles transport; HTTP hooks replace headers and the Claude Code envelope only
for this provider's configured messages endpoint. Generation parameters such as
`max_tokens`, `thinking`, `context_management`, and `output_config` are preserved.
Streaming tool names are mapped back, including JSON-to-SSE fallback responses.
All request kinds (agent, compaction, title and generate) use the same HTTP hooks.
OpenCode disposes these registrations when the plugin unloads; there are no
plugin-owned timers, subprocesses, or persistent state.

With configuration present, select one of:

```text
anyrouter-cc/claude-fable-5-1[1m]
anyrouter-cc/claude-opus-5[1m]
```

## Development

```bash
bun run check
bun test
bun run typecheck
bun run build
```
