import type { PresentationActivity } from '@/types/presentationActivity';
import type { PresentationCreativePlan } from '@/types/presentationPlan';

import type { OutlineSlide } from './OutlineWorkspace';
import type { PresentationReferenceInput } from './types';

export interface PresentationAgentMessage {
  readonly content: string;
  readonly role: 'assistant' | 'user';
}

export interface PresentationAgentBrief {
  aspectRatio?: '16:9' | '4:3';
  assets?: string[];
  audience?: string;
  language?: string;
  plan?: PresentationCreativePlan;
  research?: string;
  slideCount?: number;
  style?: string;
  topic?: string;
}

export interface PresentationAgentTurnInput {
  brief?: PresentationAgentBrief;
  messages: PresentationAgentMessage[];
  references: PresentationReferenceInput[];
  template?: { templateId: string; versionId?: string };
  threadId: string;
  tools?: { search: boolean; skillIds: string[] };
}

export interface PresentationAgentTurnResult {
  brief: PresentationAgentBrief;
  execution?: { operation: string; state: string }[];
  message: string;
  phase: 'intake' | 'outline' | 'complete';
  question?: PresentationAgentQuestion;
  questionId?: string;
  slides?: OutlineSlide[];
}

export interface PresentationAgentQuestionChoice {
  description?: string;
  id: string;
  label: string;
}

export interface PresentationAgentQuestion {
  choices?: PresentationAgentQuestionChoice[];
  context?: string[];
  prompt: string;
  title?: string;
}

export interface PresentationAgentClient {
  outline: (input: {
    brief: PresentationAgentBrief;
    currentSlides?: OutlineSlide[];
  }) => Promise<{ slides: OutlineSlide[] }>;
  turn: (
    input: PresentationAgentTurnInput,
    options?: {
      onActivity?: (activity: PresentationActivity) => void;
      onCheckpoint?: (checkpoint: Pick<PresentationAgentTurnResult, 'brief' | 'slides'>) => void;
      onMessageDelta?: (delta: string, content: string) => void;
      signal?: AbortSignal;
    },
  ) => Promise<PresentationAgentTurnResult>;
}

const jsonRequest = async <T>(url: string, body: unknown): Promise<T> => {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new Error(body?.error?.message ?? `Presentation agent unavailable (${response.status})`);
  }
  return (await response.json()) as T;
};

export const createPresentationAgentClient = (): PresentationAgentClient => ({
  outline: (input) =>
    jsonRequest('/api/runtime/presentation/outline?mode=propose', {
      ...input,
      operation: 'propose',
    }),
  turn: async (input, options) => {
    const response = await fetch('/api/runtime/presentation/conversation', {
      method: 'POST',
      body: JSON.stringify({ ...input, operation: 'turn' }),
      headers: { 'content-type': 'application/json', 'accept': 'application/x-ndjson' },
      signal: options?.signal,
    });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(error?.error?.message ?? 'PPT Agent 暂时不可用');
    }
    if (!response.headers.get('content-type')?.includes('application/x-ndjson'))
      return response.json();
    if (!response.body) throw new Error('PPT Agent 未返回数据流');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: PresentationAgentTurnResult | undefined;
    const consume = (line: string) => {
      if (!line.trim()) return;
      const event = JSON.parse(line);
      if (event.type === 'activity') options?.onActivity?.(event.activity);
      if (event.type === 'checkpoint') options?.onCheckpoint?.(event.checkpoint);
      if (event.type === 'message_delta' && typeof event.delta === 'string')
        options?.onMessageDelta?.(
          event.delta,
          typeof event.content === 'string' ? event.content : event.delta,
        );
      if (event.type === 'result') result = event.result;
      if (event.type === 'error') throw new Error(event.message);
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        lines.forEach(consume);
        if (done) break;
      }
      consume(buffer);
      if (!result) throw new Error('连接已中断，请重试当前请求');
      return result;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  },
});
