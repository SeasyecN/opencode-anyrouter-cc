import { describe, expect, it } from "bun:test"
import { adaptAnthropicResponse, convertAnthropicResponseToSse } from "../src/response"

const sseResponse = (chunks: readonly string[]): Response => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

const readEvents = async (
  response: Response,
): Promise<ReadonlyArray<{ readonly event: string; readonly data: string }>> => {
  const frames = (await response.text()).trim().split("\n\n")
  return frames.map((frame) => {
    const lines = frame.split("\n")
    const event = lines.find((line) => line.startsWith("event: "))?.slice(7)
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6)
    if (event === undefined || data === undefined) throw new Error("invalid SSE frame in test")
    return { event, data }
  })
}

describe("convertAnthropicResponseToSse", () => {
  it("converts a text message with usage and stop reason", async () => {
    const response = new Response(
      JSON.stringify({
        id: "msg_text",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: "Hello from AnyRouter" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 4 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )

    const converted = await convertAnthropicResponseToSse(response)
    const events = await readEvents(converted)

    expect(converted.headers.get("content-type")).toContain("text/event-stream")
    expect(events.map(({ event }) => event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(JSON.parse(events[2]?.data ?? "{}")).toMatchObject({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hello from AnyRouter" },
    })
    expect(JSON.parse(events[4]?.data ?? "{}")).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 4 },
    })
  })

  it("omits unsupported redacted thinking while preserving reasoning and text SSE", async () => {
    const response = new Response(
      JSON.stringify({
        id: "msg_reasoning",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [
          { type: "thinking", thinking: "I am thinking", signature: "sig_1" },
          { type: "redacted_thinking", data: "redacted_1" },
          { type: "text", text: "The answer." },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 8 },
      }),
      { status: 200 },
    )

    const converted = await convertAnthropicResponseToSse(response)
    const events = await readEvents(converted)

    expect(events.map(({ event }) => event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
    expect(JSON.parse(events[1]?.data ?? "{}")).toMatchObject({
      content_block: { type: "thinking", thinking: "" },
    })
    expect(JSON.parse(events[2]?.data ?? "{}")).toMatchObject({
      delta: { type: "thinking_delta", thinking: "I am thinking" },
    })
    expect(JSON.parse(events[3]?.data ?? "{}")).toMatchObject({
      delta: { type: "signature_delta", signature: "sig_1" },
    })
    expect(JSON.parse(events[5]?.data ?? "{}")).toMatchObject({
      content_block: { type: "text", text: "" },
    })
  })

  it("converts tool use blocks and reverses tool names", async () => {
    const response = new Response(
      JSON.stringify({
        id: "msg_tool",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "Glob",
            input: { command: "pwd" },
          },
        ],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 8, output_tokens: 7 },
      }),
      { status: 200 },
    )

    const converted = await convertAnthropicResponseToSse(response, {
      toolNameMap: { glob: "Glob" },
    })
    const events = await readEvents(converted)

    expect(JSON.parse(events[1]?.data ?? "{}")).toMatchObject({
      type: "content_block_start",
      content_block: { type: "tool_use", id: "call_1", name: "glob" },
    })
    expect(JSON.parse(events[2]?.data ?? "{}")).toMatchObject({
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: '{"command":"pwd"}' },
    })
    expect(JSON.parse(events[4]?.data ?? "{}")).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
    })
  })

  it("passes non-success responses through unchanged", async () => {
    const response = new Response("upstream error", {
      status: 429,
      headers: { "x-request-id": "req_1" },
    })

    const converted = await convertAnthropicResponseToSse(response)

    expect(converted).toBe(response)
    expect(converted.status).toBe(429)
    expect(await converted.text()).toBe("upstream error")
  })
})

describe("adaptAnthropicResponse", () => {
  it("forwards an upstream SSE stream and reverses tool names in place", async () => {
    const response = sseResponse([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_1","name":"Glob","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"pat"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"tern\\":\\"*.ts\\"}"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])

    const adapted = await adaptAnthropicResponse(response, { toolNameMap: { glob: "Glob" } })
    const events = await readEvents(adapted)

    expect(adapted.headers.get("content-type")).toContain("text/event-stream")
    expect(events.map(({ event }) => event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "message_stop",
    ])
    expect(JSON.parse(events[1]?.data ?? "{}")).toMatchObject({
      content_block: { type: "tool_use", id: "call_1", name: "glob" },
    })
    // Deltas must stay separate frames — collapsing them is what the old buffered path did.
    expect(JSON.parse(events[2]?.data ?? "{}")).toMatchObject({
      delta: { type: "input_json_delta", partial_json: '{"pat' },
    })
    expect(JSON.parse(events[3]?.data ?? "{}")).toMatchObject({
      delta: { type: "input_json_delta", partial_json: 'tern":"*.ts"}' },
    })
  })

  it("reassembles frames split across chunk boundaries", async () => {
    const response = sseResponse([
      "event: content_block_st",
      'art\ndata: {"type":"content_block_start","index":0,"content_bl',
      'ock":{"type":"tool_use","id":"call_2","name":"Read","input":{}}}\n',
      '\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])

    const adapted = await adaptAnthropicResponse(response, { toolNameMap: { read: "Read" } })
    const events = await readEvents(adapted)

    expect(events.map(({ event }) => event)).toEqual(["content_block_start", "message_stop"])
    expect(JSON.parse(events[0]?.data ?? "{}")).toMatchObject({
      content_block: { type: "tool_use", id: "call_2", name: "read" },
    })
  })

  it("streams frames as they arrive instead of buffering the whole response", async () => {
    const encoder = new TextEncoder()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          encoder.encode('event: message_start\ndata: {"type":"message_start"}\n\n'),
        )
        await gate
        controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'))
        controller.close()
      },
    })
    const response = new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })

    const adapted = await adaptAnthropicResponse(response)
    const reader = (adapted.body as ReadableStream<Uint8Array>).getReader()

    // The first frame must be readable while upstream is still withholding the rest.
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain("message_start")

    release?.()
    const second = await reader.read()
    expect(new TextDecoder().decode(second.value)).toContain("message_stop")
  })

  it("synthesizes SSE when a streaming request is answered with a whole JSON message", async () => {
    const response = new Response(
      JSON.stringify({
        id: "msg_json",
        type: "message",
        role: "assistant",
        model: "claude-opus-5",
        content: [{ type: "text", text: "Buffered" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )

    const adapted = await adaptAnthropicResponse(response)
    const events = await readEvents(adapted)

    expect(adapted.headers.get("content-type")).toContain("text/event-stream")
    expect(events.map(({ event }) => event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ])
  })

  it("passes non-success responses through untouched", async () => {
    const response = new Response("upstream error", { status: 502 })

    const adapted = await adaptAnthropicResponse(response)

    expect(adapted).toBe(response)
    expect(await adapted.text()).toBe("upstream error")
  })
})
