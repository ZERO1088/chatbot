/**
 * Minimal DeepSeek chat-completions provider for the AI SDK.
 *
 * The template reaches every model through the Vercel AI Gateway, which needs
 * `AI_GATEWAY_API_KEY` (and a card on file). This module is the alternative
 * call path: it talks straight to DeepSeek's OpenAI-compatible API using
 * `DEEPSEEK_API_KEY`, with no extra dependency — the request/response mapping
 * is the only thing that actually has to exist.
 *
 * `lib/ai/providers.ts` decides which path is used; nothing else in the app
 * needs to know.
 *
 * Implemented against the AI SDK "language model v3" interface
 * (`@ai-sdk/provider`), which is what `ai@7` expects.
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolResultPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";

type Warning = LanguageModelV3GenerateResult["warnings"][number];

export type DeepSeekModelConfig = {
  apiKey: string;
  /** e.g. https://api.deepseek.com/v1 */
  baseURL: string;
  /** DeepSeek's own model name, e.g. `deepseek-chat` / `deepseek-reasoner`. */
  modelId: string;
  provider?: string;
};

/* -------------------------------------------------------------------------- */
/* OpenAI-compatible wire format                                             */
/* -------------------------------------------------------------------------- */

type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { arguments: string; name: string };
};

type OpenAIMessage =
  | { content: string; role: "system" | "user" }
  | {
      content: string | null;
      reasoning_content?: string;
      role: "assistant";
      tool_calls?: OpenAIToolCall[];
    }
  | { content: string; role: "tool"; tool_call_id: string };

type DeepSeekUsage = {
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
};

type DeepSeekChunk = {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        function?: { arguments?: string; name?: string };
        id?: string;
        index?: number;
      }>;
    };
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        function?: { arguments?: string; name?: string };
        id?: string;
      }>;
    };
  }>;
  model?: string;
  usage?: DeepSeekUsage;
};

/* -------------------------------------------------------------------------- */
/* Pure conversion helpers (unit-testable without network access)             */
/* -------------------------------------------------------------------------- */

function safeStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

/** `LanguageModelV3ToolCallPart.input` is an object; `ToolCall.input` is a string. */
function toolArgumentsToString(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }

  return safeStringify(input);
}

function toolResultToString(output: LanguageModelV3ToolResultPart["output"]) {
  switch (output.type) {
    case "text":
      return output.value;
    case "json":
      return safeStringify(output.value);
    case "error-text":
    case "error-json":
      return safeStringify(output.value);
    case "execution-denied":
      return output.reason
        ? `Tool execution denied: ${output.reason}`
        : "Tool execution denied";
    case "content":
      return output.value
        .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
        .join("\n");
    default:
      return "";
  }
}

/**
 * Flattens the AI SDK prompt into OpenAI chat messages.
 *
 * Two DeepSeek-specific rules are applied here:
 *   - file/image parts are dropped (chat completions is text-only) with a
 *     warning instead of failing the whole request;
 *   - `reasoning_content` is never echoed back, because DeepSeek rejects
 *     requests that replay it.
 */
export function convertPromptToMessages(
  prompt: LanguageModelV3CallOptions["prompt"]
): { messages: OpenAIMessage[]; warnings: Warning[] } {
  const messages: OpenAIMessage[] = [];
  const warnings: Warning[] = [];

  for (const message of prompt) {
    if (message.role === "system") {
      messages.push({ content: message.content, role: "system" });
      continue;
    }

    if (message.role === "user") {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");

      if (message.content.some((part) => part.type === "file")) {
        warnings.push({
          details:
            "DeepSeek chat completions only accepts text input; the file part was ignored.",
          feature: "file parts",
          type: "unsupported",
        });
      }

      messages.push({ content: text, role: "user" });
      continue;
    }

    if (message.role === "assistant") {
      const text = message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");

      const toolCalls: OpenAIToolCall[] = message.content
        .filter((part) => part.type === "tool-call")
        .map((part) => ({
          function: {
            arguments: toolArgumentsToString(part.input),
            name: part.toolName,
          },
          id: part.toolCallId,
          type: "function" as const,
        }));

      messages.push({
        content: text.length > 0 ? text : toolCalls.length > 0 ? null : "",
        role: "assistant",
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    for (const part of message.content) {
      if (part.type === "tool-result") {
        messages.push({
          content: toolResultToString(part.output),
          role: "tool",
          tool_call_id: part.toolCallId,
        });
      }
    }
  }

  return { messages, warnings };
}

export function mapFinishReason(
  raw: string | null | undefined,
  sawToolCalls = false
): LanguageModelV3FinishReason {
  const reason = raw ?? undefined;

  switch (reason) {
    case "stop":
      return {
        raw: reason,
        unified: sawToolCalls ? "tool-calls" : "stop",
      };
    case "length":
      return { raw: reason, unified: "length" };
    case "tool_calls":
      return { raw: reason, unified: "tool-calls" };
    case "content_filter":
      return { raw: reason, unified: "content-filter" };
    case "insufficient_system_resource":
      return { raw: reason, unified: "error" };
    default:
      return { raw: reason, unified: sawToolCalls ? "tool-calls" : "stop" };
  }
}

export function mapUsage(
  usage: DeepSeekUsage | undefined
): LanguageModelV3Usage {
  const inputTotal = usage?.prompt_tokens;
  const cacheRead = usage?.prompt_tokens_details?.cached_tokens;
  const outputTotal = usage?.completion_tokens;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;

  return {
    inputTokens: {
      cacheRead: cacheRead ?? undefined,
      cacheWrite: undefined,
      noCache:
        inputTotal === undefined
          ? undefined
          : Math.max(0, inputTotal - (cacheRead ?? 0)),
      total: inputTotal ?? undefined,
    },
    outputTokens: {
      reasoning: reasoning ?? undefined,
      text:
        outputTotal === undefined
          ? undefined
          : Math.max(0, outputTotal - (reasoning ?? 0)),
      total: outputTotal ?? undefined,
    },
  };
}

/**
 * Splits buffered SSE text into complete `data:` payloads, returning the
 * unterminated tail so the caller can prepend it to the next network chunk.
 */
export function extractSseEvents(buffer: string): {
  events: string[];
  rest: string;
} {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events: string[] = [];

  for (const block of blocks) {
    for (const line of block.split("\n")) {
      const trimmed = line.trim();

      if (trimmed.startsWith("data:")) {
        events.push(trimmed.slice(5).trim());
      }
    }
  }

  return { events, rest };
}

function mapToolChoice(
  choice: NonNullable<LanguageModelV3CallOptions["toolChoice"]>
): unknown {
  switch (choice.type) {
    case "auto":
    case "none":
    case "required":
      return choice.type;
    case "tool":
      return { function: { name: choice.toolName }, type: "function" };
    default:
      return;
  }
}

function buildRequestBody(
  options: LanguageModelV3CallOptions,
  modelId: string,
  stream: boolean
): { body: Record<string, unknown>; warnings: Warning[] } {
  const { messages, warnings } = convertPromptToMessages(options.prompt);

  if (options.topK !== undefined) {
    warnings.push({
      details: "DeepSeek chat completions has no top_k parameter.",
      feature: "topK",
      type: "unsupported",
    });
  }

  const body: Record<string, unknown> = {
    messages,
    model: modelId,
    stream,
  };

  if (stream) {
    body.stream_options = { include_usage: true };
  }
  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }
  if (options.topP !== undefined) {
    body.top_p = options.topP;
  }
  if (options.maxOutputTokens !== undefined) {
    body.max_tokens = options.maxOutputTokens;
  }
  if (options.stopSequences?.length) {
    body.stop = options.stopSequences;
  }
  if (options.presencePenalty !== undefined) {
    body.presence_penalty = options.presencePenalty;
  }
  if (options.frequencyPenalty !== undefined) {
    body.frequency_penalty = options.frequencyPenalty;
  }
  if (options.seed !== undefined) {
    body.seed = options.seed;
  }
  if (options.responseFormat?.type === "json") {
    body.response_format = { type: "json_object" };
  }

  const functionTools =
    options.tools?.filter((tool) => tool.type === "function") ?? [];

  if (functionTools.length > 0) {
    body.tools = functionTools.map((tool) => ({
      function: {
        description: tool.description,
        name: tool.name,
        parameters: tool.inputSchema,
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      },
      type: "function",
    }));
  }

  if (options.toolChoice) {
    const toolChoice = mapToolChoice(options.toolChoice);

    if (toolChoice !== undefined) {
      body.tool_choice = toolChoice;
    }
  }

  return { body, warnings };
}

async function readApiError(response: Response): Promise<string> {
  let detail = "";

  try {
    const raw = await response.text();
    detail = raw.slice(0, 500);

    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string } };
      detail = parsed.error?.message ?? detail;
    } catch {
      // Keep the raw body.
    }
  } catch {
    // Nothing readable; the status alone must do.
  }

  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;

  return detail.trim().length > 0
    ? `DeepSeek API request failed (${status}): ${detail.trim()}`
    : `DeepSeek API request failed (${status}).`;
}

/* -------------------------------------------------------------------------- */
/* The language model                                                         */
/* -------------------------------------------------------------------------- */

export function createDeepSeekModel(
  config: DeepSeekModelConfig
): LanguageModelV3 {
  const endpoint = `${config.baseURL.replace(/\/+$/, "")}/chat/completions`;

  const headers = () => ({
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  });

  const post = (payload: Record<string, unknown>, signal?: AbortSignal) =>
    fetch(endpoint, {
      body: JSON.stringify(payload),
      headers: headers(),
      method: "POST",
      signal,
    });

  return {
    async doGenerate(options): Promise<LanguageModelV3GenerateResult> {
      const { body, warnings } = buildRequestBody(
        options,
        config.modelId,
        false
      );

      const response = await post(
        { ...body, ...options.providerOptions?.deepseek },
        options.abortSignal
      );

      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      const json = (await response.json()) as DeepSeekChunk;
      const choice = json.choices?.[0];
      const message = choice?.message;
      const content: LanguageModelV3Content[] = [];

      if (message?.reasoning_content) {
        content.push({ text: message.reasoning_content, type: "reasoning" });
      }
      if (message?.content) {
        content.push({ text: message.content, type: "text" });
      }

      const toolCalls = message?.tool_calls ?? [];

      toolCalls.forEach((call, index) => {
        content.push({
          input: call.function?.arguments ?? "{}",
          toolCallId: call.id ?? `tool-call-${index}`,
          toolName: call.function?.name ?? "",
          type: "tool-call",
        });
      });

      return {
        content,
        finishReason: mapFinishReason(
          choice?.finish_reason,
          toolCalls.length > 0
        ),
        request: { body },
        response: {
          headers: Object.fromEntries([...response.headers.entries()]),
          modelId: json.model,
          timestamp: new Date(),
        },
        usage: mapUsage(json.usage),
        warnings,
      };
    },

    async doStream(options) {
      const { body, warnings } = buildRequestBody(
        options,
        config.modelId,
        true
      );

      const response = await post(
        { ...body, ...options.providerOptions?.deepseek },
        options.abortSignal
      );

      if (!response.ok) {
        throw new Error(await readApiError(response));
      }

      if (!response.body) {
        throw new Error("DeepSeek API returned an empty response body.");
      }

      const reader = response.body.getReader();

      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        cancel() {
          reader.cancel().catch(() => {
            // The stream is already gone; nothing to clean up.
          });
        },
        async start(controller) {
          controller.enqueue({ type: "stream-start", warnings });

          let textId: string | null = null;
          let textStarted = false;
          let reasoningId: string | null = null;
          let reasoningStarted = false;
          let usage: LanguageModelV3Usage = mapUsage(undefined);
          let finishReason = mapFinishReason(undefined);
          const toolCalls = new Map<
            string,
            { arguments: string; id: string; name: string }
          >();
          let syntheticToolCalls = 0;

          const handleEvent = (data: string) => {
            if (data.length === 0 || data === "[DONE]") {
              return;
            }

            const chunk = JSON.parse(data) as DeepSeekChunk;
            const choice = chunk.choices?.[0];
            const delta = choice?.delta;

            if (chunk.usage) {
              usage = mapUsage(chunk.usage);
            }
            if (choice?.finish_reason) {
              finishReason = mapFinishReason(choice.finish_reason);
            }

            if (delta?.reasoning_content) {
              reasoningId ??= "reasoning-0";
              if (!reasoningStarted) {
                reasoningStarted = true;
                controller.enqueue({
                  id: reasoningId,
                  type: "reasoning-start",
                });
              }
              controller.enqueue({
                delta: delta.reasoning_content,
                id: reasoningId,
                type: "reasoning-delta",
              });
            }

            if (delta?.content) {
              textId ??= "text-0";
              if (!textStarted) {
                textStarted = true;
                controller.enqueue({ id: textId, type: "text-start" });
              }
              controller.enqueue({
                delta: delta.content,
                id: textId,
                type: "text-delta",
              });
            }

            for (const call of delta?.tool_calls ?? []) {
              // A call's arguments arrive spread over several chunks, joined by
              // `index`. Fall back to the call id, then to a fresh slot, so two
              // parallel calls in a provider response cannot collapse into one.
              let key: string;

              if (call.index === undefined) {
                if (call.id === undefined) {
                  syntheticToolCalls += 1;
                  key = `synthetic-${syntheticToolCalls}`;
                } else {
                  key = call.id;
                }
              } else {
                key = `index-${call.index}`;
              }
              let entry = toolCalls.get(key);

              if (!entry) {
                entry = {
                  arguments: "",
                  id: call.id ?? `tool-call-${key}`,
                  name: call.function?.name ?? "",
                };
                toolCalls.set(key, entry);
                controller.enqueue({
                  id: entry.id,
                  toolName: entry.name,
                  type: "tool-input-start",
                });
              } else if (!entry.name && call.function?.name) {
                // The name arrived after the call was opened; the part is
                // already keyed by id, and the closing `tool-call` carries it.
                entry.name = call.function.name;
              }

              const fragment = call.function?.arguments ?? "";

              if (fragment.length > 0) {
                entry.arguments += fragment;
                controller.enqueue({
                  delta: fragment,
                  id: entry.id,
                  type: "tool-input-delta",
                });
              }
            }
          };

          try {
            const decoder = new TextDecoder();
            let buffer = "";

            while (true) {
              // biome-ignore lint/performance/noAwaitInLoops: an SSE body has to be read chunk by chunk, in order
              const { done, value } = await reader.read();

              if (done) {
                break;
              }

              buffer += decoder.decode(value, { stream: true });

              const { events, rest } = extractSseEvents(buffer);

              buffer = rest;

              for (const event of events) {
                handleEvent(event);
              }
            }

            // A final event may arrive without its terminating blank line.
            buffer += decoder.decode();

            const { events } = extractSseEvents(`${buffer}\n\n`);

            for (const event of events) {
              handleEvent(event);
            }

            if (reasoningId) {
              controller.enqueue({ id: reasoningId, type: "reasoning-end" });
            }
            if (textId) {
              controller.enqueue({ id: textId, type: "text-end" });
            }

            for (const entry of toolCalls.values()) {
              controller.enqueue({ id: entry.id, type: "tool-input-end" });
              controller.enqueue({
                input: entry.arguments.length > 0 ? entry.arguments : "{}",
                toolCallId: entry.id,
                toolName: entry.name,
                type: "tool-call",
              });
            }

            controller.enqueue({
              finishReason:
                toolCalls.size > 0 && finishReason.unified === "stop"
                  ? mapFinishReason(finishReason.raw, true)
                  : finishReason,
              type: "finish",
              usage,
            });
          } catch (error) {
            controller.enqueue({
              error: error instanceof Error ? error.message : String(error),
              type: "error",
            });
          } finally {
            controller.close();
          }
        },
      });

      return {
        request: { body },
        response: {
          headers: Object.fromEntries([...response.headers.entries()]),
        },
        stream,
      };
    },

    modelId: config.modelId,
    provider: config.provider ?? "deepseek",
    specificationVersion: "v3",
    supportedUrls: {},
  };
}
