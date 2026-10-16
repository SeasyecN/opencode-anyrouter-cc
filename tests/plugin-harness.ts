import type { Model, Plugin, Provider } from "@opencode/plugin"
import type { ProviderEditor, ProviderRecord } from "@opencode/plugin/promise/provider"
import type { SessionHooks } from "@opencode/plugin/promise/session"

type Transform = (editor: ProviderEditor) => void
type Hook = {
  readonly name: keyof SessionHooks
  readonly providerID?: string | undefined
  readonly callback: (event: never) => Promise<void> | void
}

// Run actual registered callbacks, not just registration spies. Replays start from
// fresh source state as in OpenCode; add replaces an inventory by provider ID.
export const createHarness = (options: Plugin.Context["options"] = {}, directory = "/project") => {
  const transforms: Transform[] = []
  const hooks: Hook[] = []
  const ctx = {
    location: { directory },
    options,
    provider: {
      async transform(callback: Transform) {
        transforms.push(callback)
        return { dispose: async () => transforms.splice(transforms.indexOf(callback), 1) }
      },
    },
    session: {
      async hook<Name extends keyof SessionHooks>(
        name: Name,
        callback: (event: SessionHooks[Name]) => Promise<void> | void,
        scope?: { providerID?: string },
      ) {
        const hook: Hook = { name, providerID: scope?.providerID, callback }
        hooks.push(hook)
        return { dispose: async () => hooks.splice(hooks.indexOf(hook), 1) }
      },
    },
  } as unknown as Plugin.Context

  const replay = (seed: readonly { info: Provider.Info; models: readonly Model.Info[] }[] = []) => {
    const records = new Map<string, ProviderRecord>()
    const add: ProviderEditor["add"] = ({ info, models }) => {
      records.set(info.id, {
        provider: structuredClone(info),
        models: new Map(models.map((model) => [model.id, structuredClone(model)])),
      })
    }
    seed.forEach(add)
    const editor = { add } as ProviderEditor
    for (const callback of transforms) {
      if (callback(editor) !== undefined) throw new Error("Provider transforms must be synchronous")
    }
    return records
  }

  const dispatch = async <Name extends keyof SessionHooks>(
    name: Name,
    event: SessionHooks[Name],
  ) => {
    for (const hook of hooks) {
      if (hook.name !== name) continue
      if (hook.providerID !== undefined && "model" in event) {
        if (hook.providerID !== event.model.providerID) continue
      }
      await hook.callback(event as never)
    }
  }

  return { ctx, transforms, hooks, replay, dispatch }
}
