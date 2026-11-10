// Frozen pre-migration Extalia OpenAI adapter (MIT), v0.4.242. Benchmark/test fixture only.

// packages/runtime/src/model.ts
var ProviderError = class extends Error {
  constructor(message, status, retryable = false) {
    super(message);
    this.status = status;
    this.retryable = retryable;
    this.name = "ProviderError";
  }
  status;
  retryable;
};
var QUOTA_MESSAGE = /insufficient[_ ]quota|quota|credit|billing|payment required|rate[_ -]?limit|too many requests|usage limit|limit (?:exceeded|reached)|exceeded your|out of tokens|tokens? (?:limit|budget) (?:exceeded|reached)/i;
function isQuotaMessage(message) {
  return QUOTA_MESSAGE.test(message) && !/context|prompt is too long|maximum.*length/i.test(message);
}
function isRetryableStatus(status, message = "") {
  if (status === void 0) return true;
  return status === 402 || status === 408 || status === 429 || status >= 500 || isQuotaMessage(message);
}

// packages/runtime/src/providers/sse.ts
async function* readSse(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary;
      while (boundary = /\r?\n\r?\n/.exec(buffer)) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const message = parseBlock(block);
        if (message) yield message;
      }
      if (done) {
        const message = parseBlock(buffer);
        if (message) yield message;
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
function parseBlock(block) {
  let event;
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { ...event ? { event } : {}, data: data.join("\n") } : void 0;
}

// packages/runtime/src/usage.ts
var KEYS = ["inputTokens", "outputTokens", "cachedInputTokens"];
var tokenCount = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : void 0;
function normalizeUsage(raw) {
  if (!raw) return void 0;
  const usage = {};
  for (const key of KEYS) {
    const value = tokenCount(raw[key]);
    if (value !== void 0) usage[key] = value;
  }
  if (usage.inputTokens !== void 0 && usage.cachedInputTokens !== void 0 && usage.cachedInputTokens > usage.inputTokens) delete usage.cachedInputTokens;
  return Object.keys(usage).length ? usage : void 0;
}

// packages/runtime/src/providers/packages/runtime/src/providers/openai.ts
function toChatMessages(system, messages) {
  const result = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user") {
      result.push(message.images?.length ? { role: "user", content: [...message.images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.data}` } })), { type: "text", text: message.text || "Attached image." }] } : { role: "user", content: message.text });
    } else if (message.role === "assistant") {
      result.push({
        role: "assistant",
        content: message.text || null,
        ...message.toolCalls.length ? {
          tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }))
        } : {}
      });
    } else {
      for (const entry of message.results) result.push({ role: "tool", tool_call_id: entry.toolCallId, content: entry.isError ? `Error: ${entry.content}` : entry.content });
    }
  }
  return result;
}
function stopReason(finish, hasTools) {
  if (hasTools) return "tool_use";
  if (finish === "length") return "max_tokens";
  if (finish === "content_filter") return "refusal";
  if (finish === "stop" || finish === void 0) return "end";
  return "other";
}
function parseArguments(raw) {
  if (!raw.trim()) return { input: {} };
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) return { input: value };
    return { input: {}, inputError: "Tool arguments must be a JSON object." };
  } catch {
    return { input: {}, inputError: "Tool arguments were not valid JSON." };
  }
}
var streamOptionsRejected = /* @__PURE__ */ new Set();
var STREAM_OPTIONS_REJECTED = /stream_options|(?:unknown|unrecognized|unsupported)\s+(?:request\s+)?(?:parameter|argument|field)/i;
async function readText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
function errorDetail(text) {
  try {
    const body = JSON.parse(text);
    return typeof body.error === "string" ? body.error : body.error?.message ?? body.message ?? "";
  } catch {
    return text.slice(0, 300);
  }
}
async function errorFrom(response, text) {
  const detail = errorDetail(text ?? await readText(response));
  const retryable = response.status !== 401 && isRetryableStatus(response.status, detail);
  const prefix = response.status === 401 || response.status === 403 ? "The endpoint rejected the credentials" : `The endpoint returned ${response.status}`;
  return new ProviderError(detail ? `${prefix}: ${detail}` : `${prefix}.`, response.status, retryable);
}
var count = tokenCount;
function toUsage(raw) {
  if (!raw || typeof raw !== "object") return void 0;
  const usage = raw;
  const reported = (primary, alternate) => Object.hasOwn(usage, primary) ? count(usage[primary]) ?? null : Object.hasOwn(usage, alternate) ? count(usage[alternate]) ?? null : void 0;
  const inputTokens = reported("prompt_tokens", "input_tokens");
  const outputTokens = reported("completion_tokens", "output_tokens");
  const details = usage.prompt_tokens_details;
  const cachedInputTokens = details && typeof details === "object" && Object.hasOwn(details, "cached_tokens") ? count(details.cached_tokens) ?? null : void 0;
  if (inputTokens === void 0 && outputTokens === void 0 && cachedInputTokens === void 0) return void 0;
  return {
    ...inputTokens !== void 0 ? { inputTokens } : {},
    ...outputTokens !== void 0 ? { outputTokens } : {},
    ...cachedInputTokens !== void 0 ? { cachedInputTokens } : {}
  };
}
function mergeUsage(previous, next) {
  return next ? { ...previous, ...next } : previous;
}
function createOpenAIChatProvider(options) {
  const fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  const base = options.baseUrl.replace(/\/+$/, "");
  const headers = (json) => ({
    ...json ? { "Content-Type": "application/json" } : {},
    ...options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {},
    ...options.headers
  });
  return {
    api: "openai-chat",
    images: true,
    async listModels(signal) {
      if (!options.listModels) throw new ProviderError("Native model discovery is unavailable.");
      return options.listModels(signal);
    },
    async complete(request) {
      const messages = toChatMessages(request.system, request.messages);
      const tools = request.tools.length ? {
        tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }))
      } : {};
      const send = (includeUsage) => fetchImpl(`${base}/chat/completions`, {
        method: "POST",
        headers: headers(true),
        body: JSON.stringify({
          model: options.model,
          messages,
          stream: true,
          // Ask for the final usage chunk; servers that reject the option get one plain retry.
          ...includeUsage ? { stream_options: { include_usage: true } } : {},
          ...tools
        }),
        ...request.signal ? { signal: request.signal } : {}
      });
      const requestsUsage = !streamOptionsRejected.has(base);
      let response = await send(requestsUsage);
      let failureText;
      if (!response.ok && requestsUsage && response.status === 400) {
        failureText = await readText(response);
        if (STREAM_OPTIONS_REJECTED.test(errorDetail(failureText))) {
          response = await send(false);
          if (response.ok) streamOptionsRejected.add(base);
          failureText = void 0;
        }
      }
      if (!response.ok) throw await errorFrom(response, failureText);
      let text = "";
      let finish;
      let usage;
      let model;
      const calls = /* @__PURE__ */ new Map();
      const absorb = (chunk) => {
        if (chunk.error?.message) throw new ProviderError(chunk.error.message, void 0, isQuotaMessage(chunk.error.message));
        if (chunk.model) model = chunk.model;
        usage = mergeUsage(usage, toUsage(chunk.usage));
        for (const choice of chunk.choices ?? []) {
          usage = mergeUsage(mergeUsage(usage, toUsage(choice.usage)), toUsage(choice.delta?.usage));
          if (choice.finish_reason) finish = choice.finish_reason;
          if (choice.message) {
            if (choice.message.content) {
              text += choice.message.content;
              request.onText?.(choice.message.content);
            }
            choice.message.tool_calls?.forEach((call, index) => calls.set(index, { id: call.id, name: call.function.name, args: call.function.arguments }));
          }
          const delta = choice.delta;
          if (delta?.content) {
            text += delta.content;
            request.onText?.(delta.content);
          }
          for (const part of delta?.tool_calls ?? []) {
            const index = part.index ?? calls.size;
            const current = calls.get(index) ?? { id: "", name: "", args: "" };
            if (part.id) current.id = part.id;
            if (part.function?.name) current.name += part.function.name;
            if (part.function?.arguments) current.args += part.function.arguments;
            calls.set(index, current);
          }
        }
      };
      if ((response.headers.get("content-type") ?? "").includes("application/json")) absorb(await response.json());
      else if (response.body) {
        for await (const message of readSse(response.body, request.signal)) {
          if (message.data === "[DONE]") break;
          let chunk;
          try {
            chunk = JSON.parse(message.data);
          } catch {
            continue;
          }
          absorb(chunk);
        }
      }
      const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([index, call]) => {
        const parsed = parseArguments(call.args);
        return { id: call.id || `call_${index}`, name: call.name, ...parsed };
      });
      const finalUsage = normalizeUsage(usage);
      return {
        text,
        toolCalls,
        stop: stopReason(finish, toolCalls.length > 0),
        ...model ? { model } : {},
        ...finalUsage ? { usage: finalUsage } : {},
        // `prompt_tokens` already includes cached tokens (OpenAI-compatible servers).
        ...finalUsage?.inputTokens !== void 0 ? { promptTokens: finalUsage.inputTokens } : {},
        ...finish === "content_filter" ? { refusal: "The provider filtered this response." } : {}
      };
    }
  };
}
export {
  createOpenAIChatProvider,
  toChatMessages
};
