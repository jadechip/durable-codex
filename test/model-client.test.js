import test from "node:test";
import assert from "node:assert/strict";

import { OpenAIResponsesModelClient } from "../src/lib/model-client.js";

test("OpenAIResponsesModelClient fails fast when a stream stalls after a partial delta", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode([
        'data: {"type":"response.output_text.delta","delta":"Hello","response":{"id":"resp_stall"}}',
        "",
        "",
      ].join("\n")));
      // Intentionally never close and never emit more provider events.
    },
  });

  const client = new OpenAIResponsesModelClient({
    apiKey: "test-key",
    baseUrl: "https://example.com/v1",
    streamIdleTimeoutMs: 20,
    fetchImpl: async () => new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    }),
  });

  const iterator = client.streamResponse({
    model: "test-model",
    input: "hello",
  })[Symbol.asyncIterator]();

  const first = await iterator.next();
  assert.equal(first.value.type, "output_text.delta");
  assert.equal(first.value.delta, "Hello");

  await assert.rejects(
    () => iterator.next(),
    /Model stream stalled for 20ms without any provider events/,
  );
});

test("OpenAIResponsesModelClient assembles streamed function call arguments into a tool item", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode([
        'data: {"type":"response.output_item.added","response":{"id":"resp_fc"},"item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"apply_patch","arguments":""}}',
        "",
        'data: {"type":"response.function_call_arguments.done","response":{"id":"resp_fc"},"item_id":"fc_1","output_index":0,"arguments":"{\\"input\\":\\"*** Begin Patch\\\\n*** Add File: note.txt\\\\n+hello\\\\n*** End Patch\\\\n\\"}"}',
        "",
        'data: {"type":"response.completed","response":{"id":"resp_fc","output":[]}}',
        "",
        "",
      ].join("\n")));
      controller.close();
    },
  });

  const client = new OpenAIResponsesModelClient({
    apiKey: "test-key",
    baseUrl: "https://example.com/v1",
    fetchImpl: async () => new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    }),
  });

  const events = [];
  for await (const event of client.streamResponse({
    model: "test-model",
    input: "hello",
  })) {
    events.push(event);
  }

  const toolEvent = events.find((event) => event.type === "output_item.done");
  assert.ok(toolEvent);
  assert.equal(toolEvent.item.type, "function_call");
  assert.equal(toolEvent.item.id, "fc_1");
  assert.equal(toolEvent.item.call_id, "call_1");
  assert.equal(toolEvent.item.name, "apply_patch");
  assert.match(toolEvent.item.arguments, /\*\*\* Begin Patch/);
});

test("OpenAIResponsesModelClient dedupes repeated function call completions by call_id", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode([
        'data: {"type":"response.output_item.done","response":{"id":"resp_dup"},"item":{"type":"function_call","id":"fc_stream","call_id":"call_dup","name":"apply_patch","arguments":"{\\"input\\":\\"*** Begin Patch\\\\n*** Add File: note.txt\\\\n+hello\\\\n*** End Patch\\\\n\\"}"}}',
        "",
        'data: {"type":"response.completed","response":{"id":"resp_dup","output":[{"type":"function_call","id":"fc_completed","call_id":"call_dup","name":"apply_patch","arguments":"{\\"input\\":\\"*** Begin Patch\\\\n*** Add File: note.txt\\\\n+hello\\\\n*** End Patch\\\\n\\"}"}]}}',
        "",
        "",
      ].join("\n")));
      controller.close();
    },
  });

  const client = new OpenAIResponsesModelClient({
    apiKey: "test-key",
    baseUrl: "https://example.com/v1",
    fetchImpl: async () => new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    }),
  });

  const events = [];
  for await (const event of client.streamResponse({
    model: "test-model",
    input: "hello",
  })) {
    events.push(event);
  }

  const toolEvents = events.filter((event) => event.type === "output_item.done");
  assert.equal(toolEvents.length, 1);
  assert.equal(toolEvents[0].item.call_id, "call_dup");
});
