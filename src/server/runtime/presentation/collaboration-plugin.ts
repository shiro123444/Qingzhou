import { z } from 'zod';

import type {
  PresentationDecision,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import type { AtomicPlugin } from '../atomic-runtime';
import type { PresentationPresenceTab } from './file-storage';

const inputSchema = z
  .object({
    code: z.string().max(120),
    mode: z.enum(['adaptive', 'ask', 'auto']),
    foreground: z.boolean(),
    automaticAttempts: z.number().int().min(0).max(100),
  })
  .strict();
export type PresentationCollaborationInput = z.infer<typeof inputSchema>;
export interface PresentationCollaborationResolution {
  action: 'retry' | 'ask' | 'fail';
  category: PresentationDecision['category'];
}
export type PresentationCollaborationHook = (
  input: PresentationCollaborationInput,
  context: { scope: RuntimeScope; jobId: string },
) => Promise<PresentationCollaborationResolution>;

/** Presence tabs expire after this window; a stale tab never counts as foreground. */
export const PRESENTATION_PRESENCE_TTL_MS = 45_000;

/** A tab counts as foreground only while it is active and fresh. */
export function presenceIsForeground(
  tabs: Iterable<{ active: boolean; seenAt: number }>,
  now: number,
  ttlMs = PRESENTATION_PRESENCE_TTL_MS,
): boolean {
  return [...tabs].some(
    (tab) =>
      tab.active && Number.isFinite(tab.seenAt) && now >= tab.seenAt && now - tab.seenAt < ttlMs,
  );
}

/** A stale shared heartbeat must never replace a newer in-memory observation. */
export function mergePresenceTabs(
  local: Map<string, { active: boolean; seenAt: number }>,
  shared: PresentationPresenceTab[],
) {
  const merged = new Map(local);
  for (const tab of shared) {
    const current = merged.get(tab.tabId);
    if (Number.isFinite(tab.seenAt) && (!current || tab.seenAt >= current.seenAt))
      merged.set(tab.tabId, { active: tab.active, seenAt: tab.seenAt });
  }
  return merged;
}

/** Pure policy plugin: neither presence nor an answer can waive publishability checks. */
export function decidePresentationCollaboration(
  raw: PresentationCollaborationInput,
): PresentationCollaborationResolution {
  const input = inputSchema.parse(raw);
  const category: PresentationDecision['category'] = /QUALITY|LEGIBILITY|VISUAL|REVIEW/.test(
    input.code,
  )
    ? 'quality'
    : /CHAT|IMAGE|PROVIDER|TIMEOUT|EMPTY/.test(input.code)
      ? 'provider'
      : /CONFLICT|INTERRUPTED/.test(input.code)
        ? 'conflict'
        : 'input';
  const recoverable =
    /QUALITY|LEGIBILITY|VISUAL|REVIEW|CHAT|IMAGE_UNAVAILABLE|PLAN_INVALID|PROVIDER_UNAVAILABLE|TIMEOUT|EMPTY|CONFLICT|INTERRUPTED|INPUT_REQUIRED/.test(
      input.code,
    );
  if (!recoverable) return { action: 'fail', category };
  const requiresFacts = /INPUT_REQUIRED|CONFLICT|PROVIDER_UNAVAILABLE/.test(input.code);
  if (requiresFacts || input.mode === 'ask' || (input.mode === 'adaptive' && input.foreground))
    return { action: 'ask', category };
  return { action: input.automaticAttempts < 2 ? 'retry' : 'ask', category };
}

export const createPresentationCollaborationPlugin = (): AtomicPlugin => ({
  id: 'presentation-collaboration',
  version: '1.0.0',
  operations: [
    {
      name: 'presentation-collaboration.decide',
      description:
        'Choose bounded recovery or a durable user question from trusted task presence and failure state. Never bypass quality gates.',
      input: inputSchema,
      execute: decidePresentationCollaboration,
    },
  ],
});

export function createPresentationDecision(
  category: PresentationDecision['category'],
  id: string,
  createdAt: string,
): PresentationDecision {
  const copy = {
    quality: {
      detail: '有几处版式需要修正，当前草稿已保留。',
      reviseLabel: '补充后继续',
      title: '版式需要取舍',
    },
    provider: {
      detail: '这一步未完成，当前进度已保留。',
      reviseLabel: '补充后继续',
      title: '需要恢复制作',
    },
    input: {
      detail: '补充一个决定即可继续。',
      reviseLabel: '提交后继续',
      title: '需要你的决定',
    },
    conflict: {
      detail: '确认继续方向，当前草稿已保留。',
      reviseLabel: '确认后继续',
      title: '确认继续方向',
    },
  } as const;
  const retryOption = {
    id: 'retry',
    label: '自动修复',
    description: '沿用当前草稿重试。',
  } as const;
  const reviseOption = {
    id: 'revise',
    label: copy[category].reviseLabel,
    description: '补充具体取舍、风格或内容要求。',
  } as const;
  const deferOption = {
    id: 'defer',
    label: '稍后决定',
    description: '保留问题和进度，返回时继续。',
  } as const;

  return {
    id,
    createdAt,
    category,
    title: copy[category].title,
    detail: copy[category].detail,
    status: 'pending',
    options:
      category === 'quality' || category === 'provider'
        ? [retryOption, reviseOption, deferOption]
        : [reviseOption, deferOption],
  };
}
