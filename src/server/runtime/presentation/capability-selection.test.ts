import { describe, expect, it, vi } from 'vitest';

import type { CapabilityCapsule } from './capability-memory';
import { createPresentationCapabilitySelector } from './capability-selection';
import type { MultimodalChatPort } from './multimodal-chat-provider';

const capsule = (id: string, kind: CapabilityCapsule['kind']): CapabilityCapsule => ({
  id,
  kind,
  name: id,
  schemaVersion: 1,
  createdAt: '2026-10-15',
  palette: [],
  rules: [],
  triggers: [],
  source: { evidencePages: [] },
});
const candidates = [
  capsule('style-a', 'style'),
  capsule('style-b', 'style'),
  capsule('layout-c', 'layout'),
  capsule('recipe-d', 'render-recipe'),
];
const scope = { userId: 'user', sessionId: 'session' };
const input = {
  title: '商务汇报',
  prompt: '两大板块均衡汇报',
  slideCount: 18,
  aspectRatio: '16:9' as const,
  language: 'zh-CN',
  notebookId: 'notebook',
  sourceVersionIds: [],
};
const port = (ids: string[]): MultimodalChatPort => ({
  providerId: 'test',
  manifest: {
    providerId: 'test',
    model: 'test',
    displayName: 'Test',
    supportsVision: false,
    supportsIdempotency: true,
  },
  chat: vi.fn(async () => ({
    id: 'selection',
    created: 0,
    model: 'test',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant' as const,
          content: JSON.stringify({ ids, rationale: '选择适合当前汇报的设计能力' }),
        },
      },
    ],
  })),
});

describe('PPT capability selection recovery', () => {
  it('excludes observed dark-background methods from an explicit white-background brief', async () => {
    const dark = {
      ...capsule('manual', 'style'),
      designReference: {
        style: {
          id: 'custom',
          flat: true,
          grid: true,
          sparseDecoration: false,
          squareCorners: true,
          background: 'dark',
        },
      },
    } as CapabilityCapsule;
    const chat = port(['style-a']);
    expect(
      await createPresentationCapabilitySelector(chat).select(
        { ...input, prompt: '白色背景、青绿色重点的方案' },
        [dark, ...candidates],
        { scope },
      ),
    ).toEqual(['style-a']);
    expect(JSON.stringify(vi.mocked(chat.chat).mock.calls[0][0].messages)).not.toContain('manual');
  });
  it('reserves both parallel layouts when a new brief mixes comparison and three-column content', async () => {
    const parallel = (id: string, count: number) =>
      ({
        ...capsule(id, 'layout'),
        layout: { roles: [count === 2 ? 'comparison' : 'content'] },
        designReference: {
          slots: Array.from({ length: count }, (_, i) => ({
            id: `slot-${i}`,
            kind: 'object',
            box: { x: i / count, y: 0.2, width: 0.9 / count, height: 0.6 },
          })),
        },
      }) as CapabilityCapsule;
    const chat = port(['style-a', 'recipe-d']);
    const result = await createPresentationCapabilitySelector(chat).select(
      { ...input, prompt: '交接方案采用双栏对比和三栏并列说明' },
      [...candidates, parallel('two', 2), parallel('three', 3)],
      { scope },
    );
    expect(result).toEqual(['style-a', 'two', 'three', 'recipe-d']);
  });
  it('keeps the preferred style and methods from other templates without aborting generation', async () => {
    const chat = port(['style-b', 'layout-c', 'style-a', 'recipe-d']);
    expect(
      await createPresentationCapabilitySelector(chat).select(input, candidates, { scope }),
    ).toEqual(['style-b', 'layout-c', 'recipe-d']);
    expect(chat.chat).toHaveBeenCalledTimes(1);
  });
  it('still rejects capabilities outside the offered owned candidates', async () => {
    await expect(
      createPresentationCapabilitySelector(port(['unknown'])).select(input, candidates, { scope }),
    ).rejects.toThrow('offered owned candidates');
  });
  it('allows layout and rendering composition without a historical primary style', async () => {
    expect(
      await createPresentationCapabilitySelector(port(['layout-c', 'recipe-d'])).select(
        input,
        candidates,
        { scope },
      ),
    ).toEqual(['layout-c', 'recipe-d']);
  });
  it('reserves executable layouts for required evidence instead of selecting only a cover and recipes', async () => {
    const method = capsule('method', 'style');
    method.source.workspaceKind = 'style';
    const table = capsule('table', 'layout');
    const process = capsule('process', 'layout');
    const base = {
      id: 'layout',
      familyId: 'source',
      name: 'Source',
      regions: [],
      evidencePages: [1],
      readingFlow: 'Top to bottom',
      whitespace: 'Content aware',
      compositionRules: ['Grid'],
      assetPolicy: [],
    };
    table.layout = { ...base, roles: ['data'] };
    process.layout = { ...base, roles: ['process'] };
    const box = { x: 0.1, y: 0.2, width: 0.8, height: 0.6 };
    table.designReference = { slots: [{ id: 'source-table', kind: 'table', box }] };
    process.designReference = { slots: [{ id: 'source-object', kind: 'object', box }] };
    const all = [method, table, process, ...candidates.filter((c) => c.kind !== 'style')];
    const selected = await createPresentationCapabilitySelector(
      port(['method', 'layout-c', 'recipe-d']),
    ).select({ ...input, prompt: '采购审批流程与库存表格' }, all, { scope });
    expect(selected).toEqual(['method', 'table', 'process', 'layout-c', 'recipe-d']);
  });
  it('reserves typed picture and heterogeneous object lanes even when the model offers only a style', async () => {
    const style = capsule('grid-style', 'style');
    style.source.workspaceKind = 'style';
    const source = (id: string, kind: 'picture' | 'object', count: number) =>
      ({
        ...capsule(id, 'layout'),
        layout: { roles: ['content'] },
        designReference: {
          slots: Array.from({ length: count }, (_, i) => ({
            id: `${id}-${i}`,
            kind,
            box: { x: 0.1 + i * 0.25, y: 0.3, width: 0.2, height: 0.5 },
          })),
        },
      }) as CapabilityCapsule;
    const offered = [
      style,
      source('single-picture', 'picture', 1),
      source('two-pictures', 'picture', 2),
      source('two-objects', 'object', 2),
      source('three-objects', 'object', 3),
    ];
    const selected = await createPresentationCapabilitySelector(port(['grid-style'])).select(
      { ...input, prompt: '图片与公式混排，另一页两幅原图并列' },
      offered,
      { scope },
    );
    expect(selected).toEqual([
      'grid-style',
      'single-picture',
      'two-pictures',
      'two-objects',
      'three-objects',
    ]);
  });
  it('keeps a broad picture lane available when the proposed side caption has less capacity', async () => {
    const style = capsule('method', 'style');
    style.source.workspaceKind = 'style';
    const narrow = {
      ...capsule('sidebar-picture', 'layout'),
      designReference: {
        slots: [{ id: 'pic', kind: 'picture', box: { x: 0.1, y: 0.2, width: 0.4, height: 0.5 } }],
      },
    } as CapabilityCapsule;
    const broad = {
      ...capsule('full-picture', 'layout'),
      designReference: {
        slots: [{ id: 'pic', kind: 'picture', box: { x: 0.1, y: 0.2, width: 0.8, height: 0.6 } }],
      },
    } as CapabilityCapsule;
    broad.source = { templateId: 'observed', versionId: 'v1', evidencePages: [1] };
    const bleed = {
      ...capsule('unobserved-bleed', 'layout'),
      designReference: {
        slots: [{ id: 'photo', kind: 'picture', box: { x: 0, y: 0, width: 1, height: 1 } }],
      },
    } as CapabilityCapsule;
    const selected = await createPresentationCapabilitySelector(
      port(['method', 'sidebar-picture']),
    ).select({ ...input, prompt: '图片配完整说明' }, [style, narrow, broad, bleed], { scope });
    expect(selected).toEqual(['method', 'full-picture', 'sidebar-picture']);
  });
});
