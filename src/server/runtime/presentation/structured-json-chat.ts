import { extractModelJson } from './model-json';
import type {
  GLMChatContext,
  GLMChatRequest,
  GLMChatResult,
  GLMMultimodalChatPort,
} from './multimodal-chat-provider-glm';

export { extractModelJson } from './model-json';

type ChatPort = GLMMultimodalChatPort;

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
  const syntax =
    '\n严格 JSON：所有键和字符串都用双引号，不能使用单引号、注释、尾随逗号或未加引号的键。';
  if (truncated) {
    return `上一轮输出在 JSON 完成前被截断。请承接未完成部分，输出完整可解析的 JSON 对象。不要只返回思维链，不要 markdown。${syntax}${thought}`;
  }
  return `上一轮只完成了思考，没有给出最终 JSON。请基于已有思考输出完整可解析的 JSON 对象。不要只返回思维链，不要 markdown。${syntax}${thought}`;
};

export interface CompleteStructuredJsonOptions<T> {
  readonly chat: ChatPort;
  readonly context: GLMChatContext;
  readonly emptyError?: string;
  /** An already configured alternate model, used only after empty JSON continuations. */
  readonly fallbackChat?: ChatPort;
  readonly parse?: (value: unknown, raw: string) => T | Promise<T>;
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
  let activeChat = chat;
  const emptyError = options.emptyError ?? 'Structured chat returned empty JSON';
  const baseKey = context.idempotencyKey?.trim() || `structured-json:${crypto.randomUUID()}`;
  const initialTokens = Math.max(request.max_tokens ?? DEFAULT_MAX_TOKENS, DEFAULT_MAX_TOKENS);
  const messages = ensureJsonProtocolInstruction(request.messages);

  const call = async (
    messages: GLMChatRequest['messages'],
    idempotencyKey: string,
    maxTokens: number,
  ): Promise<GLMChatResult> => {
    try {
      return await activeChat.chat(
        {
          ...request,
          ...(activeChat !== chat ? { model: activeChat.manifest.model } : {}),
          max_tokens: maxTokens,
          messages,
          response_format: request.response_format ?? { type: 'json_object' },
        },
        { ...context, idempotencyKey },
      );
    } catch (error) {
      // The transport may reject an entirely empty response before the JSON reader
      // gets a result. Use the same bounded fallback as a reasoning-only response.
      if (
        (error as { code?: string })?.code !== 'CHAT_PAYLOAD_INVALID' ||
        !options.fallbackChat ||
        activeChat === options.fallbackChat
      )
        throw error;
      context.signal?.throwIfAborted();
      activeChat = options.fallbackChat;
      return call(messages, `${idempotencyKey}:fallback`, HARVEST_MAX_TOKENS);
    }
  };

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

  const harvest = async (
    result: GLMChatResult,
    continuationMessages: GLMChatRequest['messages'],
    key: string,
  ) => {
    let current = read(result);
    for (let attempt = 0; current.parsed === undefined && attempt < 2; attempt += 1) {
      continuationMessages = [
        ...continuationMessages,
        { content: assistantEcho(current.content, current.reasoning), role: 'assistant' },
        { content: harvestPrompt(current.truncated, current.reasoning), role: 'user' },
      ];
      result = await call(
        continuationMessages,
        attempt === 0 ? `${key}:harvest` : `${key}:harvest-${attempt + 1}`,
        current.truncated || attempt > 0 ? HARVEST_MAX_TOKENS : initialTokens,
      );
      current = read(result);
    }
    if (
      current.parsed === undefined &&
      options.fallbackChat &&
      options.fallbackChat !== activeChat
    ) {
      context.signal?.throwIfAborted();
      activeChat = options.fallbackChat;
      result = await call(
        [
          ...continuationMessages,
          { content: assistantEcho(current.content, current.reasoning), role: 'assistant' },
          { content: harvestPrompt(current.truncated, current.reasoning), role: 'user' },
        ],
        `${key}:fallback`,
        HARVEST_MAX_TOKENS,
      );
      current = read(result);
    }
    return { result, current };
  };
  let { result, current } = await harvest(
    await call(messages, baseKey, initialTokens),
    messages,
    baseKey,
  );
  if (current.parsed === undefined) throw new Error(emptyError);

  if (!options.parse) {
    return { raw: current.content, result, value: current.parsed as T };
  }

  try {
    return {
      raw: current.content,
      result,
      value: await options.parse(current.parsed, current.content),
    };
  } catch (error) {
    const repairMessages: GLMChatRequest['messages'] = [
      ...messages,
      { content: assistantEcho(current.content, current.reasoning), role: 'assistant' },
      {
        content: `上一轮 JSON 未通过校验。请保留已确认的事实，输出完整纠正后的 JSON 对象。错误：${String(error).slice(0, 4000)}`,
        role: 'user',
      },
    ];
    ({ result, current } = await harvest(
      await call(repairMessages, `${baseKey}:repair`, initialTokens),
      repairMessages,
      `${baseKey}:repair`,
    ));
    if (current.parsed === undefined) throw new Error(emptyError, { cause: error });
    try {
      return {
        raw: current.content,
        result,
        value: await options.parse(current.parsed, current.content),
      };
    } catch (repairError) {
      if (!options.fallbackChat || activeChat === options.fallbackChat) throw repairError;
      context.signal?.throwIfAborted();
      activeChat = options.fallbackChat;
      const fallbackMessages: GLMChatRequest['messages'] = [
        ...repairMessages,
        { role: 'assistant', content: assistantEcho(current.content, current.reasoning) },
        {
          role: 'user',
          content: `修复后的结果仍未通过校验。请依据同一份事实与约束输出完整 JSON。不得删除必需内容来规避校验。错误：${String(repairError).slice(0, 4000)}`,
        },
      ];
      ({ result, current } = await harvest(
        await call(fallbackMessages, `${baseKey}:validation-fallback`, HARVEST_MAX_TOKENS),
        fallbackMessages,
        `${baseKey}:validation-fallback`,
      ));
      if (current.parsed === undefined) throw new Error(emptyError, { cause: repairError });
      return {
        raw: current.content,
        result,
        value: await options.parse(current.parsed, current.content),
      };
    }
  }
};
