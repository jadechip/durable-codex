const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL_PROVIDER = "openai";
const DEFAULT_OPENROUTER_STREAM_IDLE_TIMEOUT_MS = 60_000;

function normalizeModelProvider(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized || "openai";
}

function resolveDefaultModelProvider(env = {}) {
  const candidates = [
    env?.DEFAULT_MODEL_PROVIDER,
    env?.OPENROUTER_PREFERRED_PROVIDER,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return normalizeModelProvider(candidate);
    }
  }
  return DEFAULT_MODEL_PROVIDER;
}

function describeConfiguredProviders(providers) {
  return Object.keys(providers).join(", ");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTimeoutMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.floor(numeric);
}

function extractOutputText(payload) {
  if (typeof payload?.output_text === "string" && payload.output_text) {
    return payload.output_text;
  }

  const output = Array.isArray(payload?.output) ? payload.output : [];
  const fragments = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === "output_text" && typeof part.text === "string") {
        fragments.push(part.text);
      }
    }
  }

  return fragments.join("");
}

async function formatErrorResponse(response) {
  const fallback = `OpenAI request failed with status ${response.status}`;

  try {
    const payload = await response.json();
    return payload?.error?.message || fallback;
  } catch {
    return fallback;
  }
}

function formatStreamErrorEvent(event) {
  return event?.error?.message || "OpenAI streaming request failed";
}

function formatIncompleteEvent(event) {
  const reason = event?.response?.incomplete_details?.reason;
  return reason ? `OpenAI response was incomplete: ${reason}` : "OpenAI response was incomplete";
}

function createStreamIdleTimeoutError(idleTimeoutMs) {
  const error = new Error(`Model stream stalled for ${idleTimeoutMs}ms without any provider events.`);
  error.code = "MODEL_STREAM_IDLE_TIMEOUT";
  return error;
}

function functionCallEmissionKey(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  if (typeof item.call_id === "string" && item.call_id) {
    return item.call_id;
  }

  if (typeof item.id === "string" && item.id) {
    return item.id;
  }

  return null;
}

async function* parseSseEvents(stream, {
  idleTimeoutMs = null,
} = {}) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastPayloadAt = Date.now();

  try {
    while (true) {
      const remainingIdleMs = idleTimeoutMs === null
        ? null
        : Math.max(1, idleTimeoutMs - (Date.now() - lastPayloadAt));

      const { value, done } = await Promise.race([
        reader.read(),
        ...(remainingIdleMs === null
          ? []
          : [
              delay(remainingIdleMs).then(() => {
                throw createStreamIdleTimeoutError(idleTimeoutMs);
              }),
            ]),
      ]);
      if (done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");

      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        separatorIndex = buffer.indexOf("\n\n");

        const dataLines = [];
        for (const line of rawEvent.split("\n")) {
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /, ""));
          }
        }

        const payload = dataLines.join("\n").trim();
        if (!payload || payload === "[DONE]") {
          continue;
        }

        lastPayloadAt = Date.now();
        yield JSON.parse(payload);
      }
    }

    const trailing = buffer.trim();
    if (!trailing) {
      return;
    }

    const dataLines = [];
    for (const line of trailing.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }

    const payload = dataLines.join("\n").trim();
    if (payload && payload !== "[DONE]") {
      lastPayloadAt = Date.now();
      yield JSON.parse(payload);
    }
  } catch (error) {
    if (error?.code === "MODEL_STREAM_IDLE_TIMEOUT") {
      await reader.cancel().catch(() => {});
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function resolveStreamIdleTimeoutMs(configured, fallback = null) {
  const direct = normalizeTimeoutMs(configured);
  if (direct !== null) {
    return direct;
  }
  return normalizeTimeoutMs(fallback);
}

function buildInstructions(baseInstructions, developerInstructions) {
  return [baseInstructions, developerInstructions].filter(Boolean).join("\n\n");
}

function excerptFromStructuredInput(input) {
  const fragments = [];

  for (const item of Array.isArray(input) ? input : []) {
    if (!item || typeof item !== "object") {
      continue;
    }

    if (item.type === "message") {
      const content = Array.isArray(item.content) ? item.content : [];
      for (const part of content) {
        if (!part || typeof part !== "object") {
          continue;
        }
        if (typeof part.text === "string" && part.text) {
          fragments.push(part.text);
        }
      }
      continue;
    }

    if (item.type === "function_call_output" && typeof item.output === "string" && item.output) {
      fragments.push(item.output);
    }
  }

  return fragments.join("\n").slice(-200);
}

export class OpenAIResponsesModelClient {
  constructor({
    apiKey,
    baseUrl = DEFAULT_OPENAI_BASE_URL,
    extraHeaders = {},
    streamIdleTimeoutMs = null,
    fetchImpl = (input, init) => globalThis.fetch(input, init),
  }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.extraHeaders = extraHeaders;
    this.streamIdleTimeoutMs = normalizeTimeoutMs(streamIdleTimeoutMs);
    this.fetch = fetchImpl;
  }

  async *streamResponse({
    input,
    prompt,
    model,
    baseInstructions,
    developerInstructions,
    tools = [],
    previousResponseId = null,
    toolChoice = undefined,
    parallelToolCalls = false,
    signal = undefined,
  }) {
    const instructions = buildInstructions(baseInstructions, developerInstructions);
    const body = {
      model,
      input: input ?? prompt ?? "",
      stream: true,
    };

    if (instructions) {
      body.instructions = instructions;
    }

    if (Array.isArray(tools) && tools.length > 0) {
      body.tools = tools;
      body.parallel_tool_calls = Boolean(parallelToolCalls);
      if (toolChoice !== undefined) {
        body.tool_choice = toolChoice;
      }
    }

    if (typeof previousResponseId === "string" && previousResponseId) {
      body.previous_response_id = previousResponseId;
    }

    const response = await this.fetch(`${this.baseUrl}/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json; charset=utf-8",
        ...this.extraHeaders,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new Error(await formatErrorResponse(response));
    }

    if (!response.body) {
      throw new Error("OpenAI streaming response did not include a body");
    }

    let responseId = null;
    let sawCompleted = false;
    let sawOutputSignal = false;
    const pendingFunctionCalls = new Map();
    const emittedFunctionCallKeys = new Set();

    for await (const event of parseSseEvents(response.body, {
      idleTimeoutMs: this.streamIdleTimeoutMs,
    })) {
      responseId = event?.response?.id ?? responseId;

      switch (event?.type) {
        case "response.created":
          yield {
            type: "response.created",
            responseId,
          };
          break;
        case "response.in_progress":
          break;
        case "response.output_text.delta":
          if (typeof event.delta === "string" && event.delta) {
            sawOutputSignal = true;
            yield {
              type: "output_text.delta",
              delta: event.delta,
              responseId,
            };
          }
          break;
        case "response.reasoning_summary_part.added":
          sawOutputSignal = true;
          yield {
            type: "reasoning.summary_part_added",
            summaryIndex: Number.isInteger(event.summary_index) ? event.summary_index : 0,
            responseId,
          };
          break;
        case "response.reasoning_summary_text.delta":
          if (typeof event.delta === "string") {
            sawOutputSignal = true;
            yield {
              type: "reasoning.summary_text.delta",
              delta: event.delta,
              summaryIndex: Number.isInteger(event.summary_index) ? event.summary_index : 0,
              responseId,
            };
          }
          break;
        case "response.reasoning_text.delta":
          if (typeof event.delta === "string") {
            sawOutputSignal = true;
            yield {
              type: "reasoning.text.delta",
              delta: event.delta,
              contentIndex: Number.isInteger(event.content_index) ? event.content_index : 0,
              responseId,
            };
          }
          break;
        case "response.output_item.added":
          if (event.item && typeof event.item === "object") {
            sawOutputSignal = true;
            if (event.item.type === "function_call" && typeof event.item.id === "string" && event.item.id) {
              pendingFunctionCalls.set(event.item.id, event.item);
            }
            yield {
              type: "output_item.added",
              item: event.item,
              responseId,
            };
          }
          break;
        case "response.function_call_arguments.done": {
          sawOutputSignal = true;
          const itemId = typeof event.item_id === "string" && event.item_id ? event.item_id : null;
          if (!itemId) {
            break;
          }

          const pendingItem = pendingFunctionCalls.get(itemId) ?? {};
          const emissionKey =
            (typeof event.call_id === "string" && event.call_id)
            || functionCallEmissionKey(pendingItem)
            || itemId;
          if (emissionKey && emittedFunctionCallKeys.has(emissionKey)) {
            pendingFunctionCalls.delete(itemId);
            break;
          }
          const mergedItem = {
            ...pendingItem,
            type: "function_call",
            id: itemId,
            output_index: Number.isInteger(event.output_index)
              ? event.output_index
              : (Number.isInteger(pendingItem?.output_index) ? pendingItem.output_index : 0),
            call_id: typeof event.call_id === "string" && event.call_id
              ? event.call_id
              : pendingItem?.call_id,
            name: typeof event.name === "string" && event.name
              ? event.name
              : pendingItem?.name,
            arguments: typeof event.arguments === "string"
              ? event.arguments
              : (typeof pendingItem?.arguments === "string" ? pendingItem.arguments : ""),
          };

          pendingFunctionCalls.delete(itemId);
          if (emissionKey) {
            emittedFunctionCallKeys.add(emissionKey);
          }
          yield {
            type: "output_item.done",
            item: mergedItem,
            responseId,
          };
          break;
        }
        case "response.output_item.done":
          if (event.item && typeof event.item === "object") {
            sawOutputSignal = true;
            if (event.item.type === "function_call" && typeof event.item.id === "string" && event.item.id) {
              pendingFunctionCalls.set(event.item.id, event.item);
              if (!event.item.arguments) {
                break;
              }
              const emissionKey = functionCallEmissionKey(event.item);
              if (emissionKey && emittedFunctionCallKeys.has(emissionKey)) {
                pendingFunctionCalls.delete(event.item.id);
                break;
              }
              if (emissionKey) {
                emittedFunctionCallKeys.add(emissionKey);
              }
              pendingFunctionCalls.delete(event.item.id);
            }
            yield {
              type: "output_item.done",
              item: event.item,
              responseId,
            };
          }
          break;
        case "response.completed":
          sawCompleted = true;
          for (const item of Array.isArray(event?.response?.output) ? event.response.output : []) {
            const emissionKey = functionCallEmissionKey(item);
            if (
              item?.type === "function_call" &&
              emissionKey &&
              !emittedFunctionCallKeys.has(emissionKey) &&
              typeof item.arguments === "string" &&
              item.arguments
            ) {
              emittedFunctionCallKeys.add(emissionKey);
              if (typeof item.id === "string" && item.id) {
                pendingFunctionCalls.delete(item.id);
              }
              yield {
                type: "output_item.done",
                item,
                responseId: event?.response?.id ?? responseId,
              };
            }
          }
          if (!sawOutputSignal) {
            const text = extractOutputText(event?.response);
            if (text) {
              yield {
                type: "output_text.delta",
                delta: text,
                responseId: event?.response?.id ?? responseId,
              };
            }
          }
          yield {
            type: "completed",
            responseId: event?.response?.id ?? responseId,
            response: event?.response ?? null,
          };
          break;
        case "response.failed":
          throw new Error(formatStreamErrorEvent(event));
        case "response.incomplete":
          throw new Error(formatIncompleteEvent(event));
        case "error":
          throw new Error(formatStreamErrorEvent(event));
        default:
          break;
      }
    }

    if (!sawCompleted) {
      throw new Error("OpenAI response stream ended before response.completed");
    }
  }

  async *streamText({ prompt, model, baseInstructions, developerInstructions, signal }) {
    yield* this.streamResponse({
      prompt,
      model,
      baseInstructions,
      developerInstructions,
      signal,
    });
  }

  async generateText(args) {
    let text = "";
    let responseId = null;

    for await (const event of this.streamResponse(args)) {
      if (event.type === "output_text.delta") {
        text += event.delta;
      }
      responseId = event.responseId ?? responseId;
    }

    return {
      text,
      responseId,
    };
  }
}

class MultiProviderModelClient {
  constructor(providers, options = {}) {
    this.providers = providers;
    this.preferredProvider = options.preferredProvider || "openai";
  }

  resolveProvider(rawProvider) {
    const normalized = normalizeModelProvider(rawProvider);
    if (this.providers[normalized]) {
      return normalized;
    }

    const providerKeys = Object.keys(this.providers);
    if (!providerKeys.length) {
      return null;
    }

    if (providerKeys.includes(this.preferredProvider)) {
      return this.preferredProvider;
    }

    return providerKeys[0];
  }

  getClient(provider) {
    const client = this.providers[provider];
    if (!client) {
      const available = describeConfiguredProviders(this.providers);
      throw new Error(`Model provider '${provider}' is not configured. Available providers: ${available}`);
    }
    return client;
  }

  async *streamResponse(request) {
    const provider = this.resolveProvider(request?.modelProvider);
    const client = this.getClient(provider);
    yield* client.streamResponse(request);
  }

  async generateText(request) {
    const provider = this.resolveProvider(request?.modelProvider);
    const client = this.getClient(provider);
    return client.generateText(request);
  }

  async *streamText(request) {
    const provider = this.resolveProvider(request?.modelProvider);
    const client = this.getClient(provider);
    yield* client.streamText(request);
  }
}

export class StubModelClient {
  async *streamResponse({ input, prompt, model }) {
    const excerpt = typeof prompt === "string" && prompt
      ? prompt.slice(-200)
      : excerptFromStructuredInput(input) || "No conversation context was provided.";
    const text = `Stub response from ${model}: ${excerpt}`;
    const chunkSize = 24;

    for (let cursor = 0; cursor < text.length; cursor += chunkSize) {
      await delay(30);
      yield {
        type: "output_text.delta",
        delta: text.slice(cursor, cursor + chunkSize),
        responseId: null,
      };
    }

    yield {
      type: "completed",
      responseId: null,
      response: null,
    };
  }

  async *streamText(args) {
    yield* this.streamResponse(args);
  }

  async generateText(args) {
    let text = "";

    for await (const event of this.streamResponse(args)) {
      if (event.type === "output_text.delta") {
        text += event.delta;
      }
    }

    return {
      text,
      responseId: null,
    };
  }
}

export function createModelClient(env) {
  const providers = {};

  if (typeof env?.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim()) {
    providers.openai = new OpenAIResponsesModelClient({
      apiKey: env.OPENAI_API_KEY.trim(),
      baseUrl: env.OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL,
      streamIdleTimeoutMs: resolveStreamIdleTimeoutMs(
        env.OPENAI_STREAM_IDLE_TIMEOUT_MS,
        env.MODEL_STREAM_IDLE_TIMEOUT_MS,
      ),
    });
  }

  if (typeof env?.OPENROUTER_API_KEY === "string" && env.OPENROUTER_API_KEY.trim()) {
    providers.openrouter = new OpenAIResponsesModelClient({
      apiKey: env.OPENROUTER_API_KEY.trim(),
      baseUrl: env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL,
      streamIdleTimeoutMs: resolveStreamIdleTimeoutMs(
        env.OPENROUTER_STREAM_IDLE_TIMEOUT_MS,
        env.MODEL_STREAM_IDLE_TIMEOUT_MS ?? DEFAULT_OPENROUTER_STREAM_IDLE_TIMEOUT_MS,
      ),
      extraHeaders: {
        ...(env.OPENROUTER_HTTP_REFERER ? { "HTTP-Referer": env.OPENROUTER_HTTP_REFERER.trim() } : {}),
        ...(env.OPENROUTER_X_TITLE ? { "X-Title": env.OPENROUTER_X_TITLE.trim() } : {}),
      },
    });
  }

  const providerKeys = Object.keys(providers);
  if (providerKeys.length === 0) {
    return new StubModelClient();
  }

  if (providerKeys.length === 1) {
    return providers[providerKeys[0]];
  }

  return new MultiProviderModelClient(providers, {
    preferredProvider: resolveDefaultModelProvider(env),
  });
}
