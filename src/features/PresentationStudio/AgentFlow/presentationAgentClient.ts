import type { PresentationActivity } from '@/types/presentationActivity';
import type { LessonPlan, TeacherBrief } from '@/types/presentationLesson';
import type { PresentationCreativePlan } from '@/types/presentationPlan';
import type { TeachingSelection } from '@/types/presentationTeaching';

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
  teacherBrief?: TeacherBrief;
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
    currentLessonPlan?: LessonPlan;
    instruction?: string;
    teachingSelection?: TeachingSelection;
  }) => Promise<{ slides: OutlineSlide[]; lessonPlan?: LessonPlan }>;
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

/** Race reads as well as fetch: an unresponsive transport must not keep the UI pending forever. */
const abortable = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
};

export const createPresentationAgentClient = (
  timing: { idleTimeoutMs?: number; totalTimeoutMs?: number } = {},
): PresentationAgentClient => ({
  outline: (input) =>
    jsonRequest('/api/runtime/presentation/outline?mode=propose', {
      ...input,
      operation: 'propose',
    }),
  turn: async (input, options) => {
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, ...(options?.signal ? [options.signal] : [])]);
    let idle: ReturnType<typeof setTimeout>;
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => abort.abort(new Error('连接长时间无响应，请重试；已保存的学习进度会保留')),
        timing.idleTimeoutMs ?? 120_000,
      );
    };
    const deadline = setTimeout(
      () => abort.abort(new Error('本轮处理超时，请从已保存进度重试')),
      timing.totalTimeoutMs ?? 15 * 60_000,
    );
    resetIdle();
    try {
      const response = await abortable(
        fetch('/api/runtime/presentation/conversation', {
          method: 'POST',
          body: JSON.stringify({ ...input, operation: 'turn' }),
          headers: { 'content-type': 'application/json', 'accept': 'application/x-ndjson' },
          signal,
        }),
        signal,
      );
      if (!response.ok) {
        const error = await abortable(response.json(), signal).catch(() => null);
        throw new Error(error?.error?.message ?? 'PPT Agent 暂时不可用');
      }
      if (!response.headers.get('content-type')?.includes('application/x-ndjson'))
        return await abortable(response.json(), signal);
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
          const { done, value } = await abortable(reader.read(), signal);
          resetIdle();
          buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          lines.forEach(consume);
          if (done || result) break;
        }
        consume(buffer);
        if (!result) throw new Error('连接已中断，请重试当前请求');
        return result;
      } finally {
        void reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    } finally {
      clearTimeout(idle!);
      clearTimeout(deadline);
    }
  },
});
