import type {
  GLMChatContext,
  GLMChatRequest,
  GLMChatResult,
  GLMMultimodalChatPort,
} from './multimodal-chat-provider-glm';

type ChatPort = GLMMultimodalChatPort;

const tryParseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** Extract a JSON value from fences, think-tags, or mixed model prose. */
export const extractModelJson = (content: string): unknown => {
  const cleaned = content
    .replaceAll(/<think>[\s\S]*?<\/think>/giu, '')
    .replaceAll(/<thinking>[\s\S]*?<\/thinking>/giu, '')
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim();
  const direct = tryParseJson(cleaned);
  if (direct !== undefined) return direct;
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const extracted = tryParseJson(cleaned.slice(start, end + 1));
    if (extracted !== undefined) return extracted;
  }
  throw new SyntaxError('Model response was not valid JSON');
};

const DEFAULT_MAX_TOKENS = 16_000;
const HARVEST_MAX_TOKENS = 32_000;
const JSON_PROTOCOL_INSTRUCTION = 'Return one complete, valid JSON object.';

const contentMentionsJson = (content: GLMChatRequest['messages'][number]['content']): boolean =>
  typeof content === 'string'
    ? /json/iu.test(content)
    : content.some((part) => part.type === 'text' && /json/iu.test(part.text));

/** OpenAI-compatible providers reject json_object requests without this prompt sentinel. */
const ensureJsonProtocolInstruction = (
  messages: GLMChatRequest['messages'],
): GLMChatRequest['messages'] => {
  if (messages.some((message) => contentMentionsJson(message.content))) return messages;
  const systemIndex = messages.findIndex((message) => message.role === 'system');
  if (systemIndex < 0) {
    return [{ content: JSON_PROTOCOL_INSTRUCTION, role: 'system' }, ...messages];
  }
  return messages.map((message, index) => {
    if (index !== systemIndex) return message;
    return {
      ...message,
      content:
        typeof message.content === 'string'
          ? `${message.content}\n${JSON_PROTOCOL_INSTRUCTION}`
          : [...message.content, { text: JSON_PROTOCOL_INSTRUCTION, type: 'text' as const }],
    };
  });
};

const readJsonCandidate = (content?: string, reasoning?: string): unknown | undefined => {
  for (const text of [content, reasoning]) {
    if (!text?.trim()) continue;
    try {
      return extractModelJson(text);
    } catch {
      // Keep scanning: thinking models often wrap the object in prose.
    }
  }
};

const assistantEcho = (content: string, reasoning?: string): string => {
  if (content.trim()) return content;
  if (reasoning?.trim())
    return `[reasoning only; content empty]\n${reasoning.trim().slice(0, 6000)}`;
  return '[empty]';
};

const harvestPrompt = (truncated: boolean, reasoning?: string): string => {
  const thought = reasoning?.trim()
    ? `\n已完成的思考摘要：\n${reasoning.trim().slice(0, 6000)}`
    : '';
  if (truncated) {
    return `上一轮输出在 JSON 完成前被截断。请承接未完成部分，输出完整可解析的 JSON 对象。不要只返回思维链，不要 markdown。${thought}`;
  }
  return `上一轮只完成了思考，没有给出最终 JSON。请基于已有思考输出完整可解析的 JSON 对象。不要只返回思维链，不要 markdown。${thought}`;
};

export interface CompleteStructuredJsonOptions<T> {
  readonly chat: ChatPort;
  readonly context: GLMChatContext;
  readonly emptyError?: string;
  readonly parse?: (value: unknown, raw: string) => T;
  readonly request: GLMChatRequest;
}

export interface CompleteStructuredJsonResult<T> {
  readonly raw: string;
  readonly result: GLMChatResult;
  readonly value: T;
}

/**
 * Completes a JSON chat turn against thinking-capable models.
 * Thinking stays enabled; empty or truncated content is harvested in a
 * follow-up that reuses the prior chain of thought instead of disabling it.
 */
export const completeStructuredJson = async <T = unknown>(
  options: CompleteStructuredJsonOptions<T>,
): Promise<CompleteStructuredJsonResult<T>> => {
  const { chat, context, request } = options;
  const emptyError = options.emptyError ?? 'Structured chat returned empty JSON';
  const baseKey = context.idempotencyKey?.trim() || `structured-json:${crypto.randomUUID()}`;
  const initialTokens = Math.max(request.max_tokens ?? DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS);
  const messages = ensureJsonProtocolInstruction(request.messages);

  const call = async (
    messages: GLMChatRequest['messages'],
    idempotencyKey: string,
    maxTokens: number,
  ): Promise<GLMChatResult> =>
    chat.chat(
      {
        ...request,
        max_tokens: maxTokens,
        messages,
        response_format: request.response_format ?? { type: 'json_object' },
      },
      { ...context, idempotencyKey },
    );

  const read = (result: GLMChatResult) => {
    const choice = result.choices[0];
    const content = choice?.message.content ?? '';
    const reasoning = choice?.message.reasoning_content;
    return {
      choice,
      content,
      parsed: readJsonCandidate(content, reasoning),
      reasoning,
      truncated: choice?.finish_reason === 'length',
    };
  };

  let result = await call(messages, baseKey, initialTokens);
  let current = read(result);

  if (current.parsed === undefined) {
    result = await call(
      [
        ...messages,
        { content: assistantEcho(current.content, current.reasoning), role: 'assistant' },
        { content: harvestPrompt(current.truncated, current.reasoning), role: 'user' },
      ],
      `${baseKey}:harvest`,
      current.truncated ? HARVEST_MAX_TOKENS : initialTokens,
    );
    current = read(result);
  }

  if (current.parsed === undefined) throw new Error(emptyError);

  if (!options.parse) {
    return { raw: current.content, result, value: current.parsed as T };
  }

  try {
    return { raw: current.content, result, value: options.parse(current.parsed, current.content) };
  } catch (error) {
    result = await call(
      [
        ...messages,
        { content: assistantEcho(current.content, current.reasoning), role: 'assistant' },
        {
          content: `上一轮 JSON 未通过校验。请保留已确认的事实，输出完整纠正后的 JSON 对象。错误：${String(error).slice(0, 4000)}`,
          role: 'user',
        },
      ],
      `${baseKey}:repair`,
      initialTokens,
    );
    current = read(result);
    if (current.parsed === undefined) throw new Error(emptyError, { cause: error });
    return { raw: current.content, result, value: options.parse(current.parsed, current.content) };
  }
};
