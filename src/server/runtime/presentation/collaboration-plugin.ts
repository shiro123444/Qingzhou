import { z } from 'zod';

import type {
  PresentationDecision,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import type { AtomicPlugin } from '../atomic-runtime';

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
  const labels = {
    quality: [
      '有几处版式需要取舍',
      '自动检查仍发现需要修正的页面。已保留资料、大纲和草稿；可以继续修复，也可以补充你希望保留的风格或布局。',
    ],
    provider: [
      '模型服务暂时没有完成这一步',
      '已完成的内容已保存。可以继续重试，或补充制作要求后再继续；不会把空响应当成完成。',
    ],
    input: [
      '这里需要补充一个决定',
      '当前步骤需要你的信息或偏好。已保留完成的步骤，补充要求后可从这里继续。',
    ],
    conflict: [
      '继续前需要确认任务方向',
      '任务版本或运行状态发生了变化。先保留当前草稿，请选择继续修复或补充接下来的要求。',
    ],
  } as const;
  return {
    id,
    createdAt,
    category,
    title: labels[category][0],
    detail: labels[category][1],
    status: 'pending',
    options: [
      {
        id: 'retry',
        label: '自动修复并继续',
        description: '沿用资料、大纲和已完成页面，再检查当前步骤。',
      },
      { id: 'revise', label: '按我的补充继续', description: '填写具体取舍、风格或内容要求。' },
      { id: 'defer', label: '暂存，稍后决定', description: '保留问题和进度，返回时继续。' },
    ],
  };
}
