# @seasyecn/opencode-anyrouter-cc

Minimal OpenCode V1 provider for AnyRouter's Claude Code-compatible gateway.
It registers `anyrouter-cc/claude-fable-5-1[1m]` and `anyrouter-cc/claude-opus-5[1m]`,
sends `claude-fable-5-1` / `claude-opus-5` upstream, and adapts the provider request to
`POST /v1/messages?beta=true` in the shape claude-cli 2.1.258 sends.

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

Add the printed URI to the OpenCode `plugin` array in the project `opencode.json`
(or the user config):

```json
{
  "plugin": ["file:///absolute/path/to/opencode-anyrouter-cc/dist/index.js"]
}
```

Restart OpenCode after changing the plugin list.

## npm Installation

Install the published package:

```bash
bun add @seasyecn/opencode-anyrouter-cc
# or: npm install @seasyecn/opencode-anyrouter-cc
```

Add the package name to the OpenCode `plugin` array:

```json
{
  "plugin": ["@seasyecn/opencode-anyrouter-cc"]
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
