import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { AtomicRuntime } from '../atomic-runtime';
import { createPresentationContextRuntime } from './context-tools';
import { createPresentationConversationCapability } from './conversation-capability';
import { createResilientMultimodalChatPort } from './multimodal-chat-fallback';
import { type MultimodalChatPort, MultimodalChatProviderError } from './multimodal-chat-provider';

const scope = { userId: 'alice', sessionId: 'account' };
const plan = {
  goal: '管理层决定试点范围',
  narrative: '从约束到方案再到验收',
  rationale: '目前只有计划，不能声称经营成果',
  steps: [{ action: '分析材料', reason: '先核实预算与范围' }],
  successCriteria: ['数字可追溯'],
};
const slide = { id: 's1', title: '试点计划', keyPoints: ['预算37万元'] };
const response = (value: unknown) => ({
  choices: [{ index: 0, message: { content: JSON.stringify(value), role: 'assistant' as const } }],
  created: 1,
  id: 'test',
  model: 'test',
});
const chatPort = (...decisions: unknown[]): MultimodalChatPort => {
  const chat = vi.fn();
  for (const decision of decisions) chat.mockResolvedValueOnce(response(decision));
  return {
    chat,
    manifest: {
      displayName: 'Test',
      model: 'test',
      providerId: 'test',
      supportsIdempotency: true,
      supportsVision: true,
    },
    providerId: 'test',
  };
};
const command = {
  operation: 'turn' as const,
  threadId: 't',
  messages: [{ role: 'user' as const, content: '根据材料设计汇报' }],
};
const op = (operation: string, input: unknown = {}) => ({ operation, input });

describe('autonomous presentation conversation', () => {
  it('lets the agent choose file, search, skill, plan and outline order and carries real evidence forward', async () => {
    const readFile = vi.fn(async () => ({ name: 'budget.txt', content: '预算37万元，12家门店。' }));
    const search = vi.fn(async () => ({ results: [{ url: 'https://example.com/source' }] }));
    const readSkill = vi.fn(async () => ({ name: 'Evidence', content: '每个数字标注来源' }));
    const runtime = createPresentationContextRuntime({
      readFile,
      search,
      readSkill,
      listSkills: async () => [],
    });
    const chat = chatPort(
      op('context.readFile', { id: 'owned' }),
      op('context.search', { query: '参考案例' }),
      op('context.readSkill', { id: 'evidence' }),
      op('planning.update', { topic: '门店试点', plan }),
      op('planning.outline'),
      { slides: [slide] },
      { phase: 'outline', message: '已按材料完成大纲' },
    );
    try {
      const result = await createPresentationConversationCapability({ chat }).execute(
        {
          ...command,
          references: [{ id: 'owned', kind: 'text', name: 'budget.txt', status: 'ready' }],
          tools: { search: true, skillIds: ['evidence'] },
        },
        { scope, tools: runtime },
      );
      expect(result.slides).toEqual([slide]);
      expect(result.brief.plan).toEqual(plan);
      expect(result.brief.research).toContain('37万元');
      expect(result.brief.research).toContain('https://example.com/source');
      expect(result.execution?.map((event) => event.operation)).toEqual([
        'context.readFile',
        'context.search',
        'context.readSkill',
        'planning.update',
        'planning.outline',
      ]);
      expect(JSON.stringify(vi.mocked(chat.chat).mock.calls[5])).toContain('每个数字标注来源');
    } finally {
      await runtime.dispose();
    }
  });

  it('asks before downloading search results and fetches only after the teacher confirms the urls', async () => {
    const url = 'https://example.com/kkt';
    const fetchPages = vi.fn(async () => ({ pages: [{ url, content: 'KKT 条件来自 Boyd。' }] }));
    const runtime = createPresentationContextRuntime({
      readFile: vi.fn(),
      readSkill: vi.fn(),
      search: vi.fn(),
      fetchPages,
      listSkills: async () => [],
    });
    try {
      const paused = await createPresentationConversationCapability({
        chat: chatPort(op('context.fetchPages', { urls: [url] })),
      }).execute({ ...command, tools: { search: true, skillIds: [] } }, { scope, tools: runtime });
      expect(fetchPages).not.toHaveBeenCalled();
      expect(paused.question?.title).toBe('要抓取这些页面吗');
      expect(paused.question?.context).toEqual([url]);
      expect(paused.question?.choices?.map((choice) => choice.label)).toEqual([
        '抓取这些页面',
        '只用搜索摘要',
      ]);
      const confirmed = await createPresentationConversationCapability({
        chat: chatPort(op('context.fetchPages', { urls: [url] }), {
          phase: 'intake',
          message: '已把来源写进资料。',
        }),
      }).execute(
        {
          ...command,
          messages: [
            ...command.messages,
            {
              role: 'user',
              content: `确认后将下载这些链接的正文：\n${url}\n用户决定：抓取这些页面`,
            },
          ],
          tools: { search: true, skillIds: [] },
        },
        { scope, tools: runtime },
      );
      expect(fetchPages).toHaveBeenCalledWith([url]);
      expect(confirmed.brief.research).toContain('Boyd');
      expect(confirmed.message).toBe('已把来源写进资料。');
    } finally {
      await runtime.dispose();
    }
  });

  it('repairs empty decisions without rerunning already completed tools', async () => {
    const chat = chatPort(
      op('planning.update', { topic: '已确认的主题', plan }),
      {},
      { phase: 'intake' },
      { question: { prompt: '需要多少页？' } },
    );
    const checkpoint = vi.fn();
    const result = await createPresentationConversationCapability({ chat }).execute(command, {
      scope,
      onCheckpoint: checkpoint,
    });
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(checkpoint.mock.calls[0][0].brief).toMatchObject({ topic: '已确认的主题', plan });
    expect(result.question?.prompt).toBe('需要多少页？');
    expect(result.execution).toEqual([{ operation: 'planning.update', state: 'completed' }]);
    expect(chat.chat).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(vi.mocked(chat.chat).mock.calls[3])).toContain('不要重复执行');
  });

  it('repairs malformed provider envelopes, while retaining a completed plan', async () => {
    const chat = chatPort();
    vi.mocked(chat.chat)
      .mockResolvedValueOnce(response(op('planning.update', { topic: '模型发布', plan })))
      .mockRejectedValueOnce(
        new MultimodalChatProviderError(
          'CHAT_PAYLOAD_INVALID',
          'Failed to parse multimodal chat response JSON',
        ),
      )
      .mockResolvedValueOnce(response({ phase: 'intake', message: '沿用方案继续。' }));
    const result = await createPresentationConversationCapability({ chat }).execute(command, {
      scope,
    });
    expect(result.brief.plan).toEqual(plan);
    expect(result.message).toBe('沿用方案继续。');
    expect(result.execution).toHaveLength(1);
  });

  it('publishes completed work before a later provider failure', async () => {
    const chat = chatPort();
    vi.mocked(chat.chat)
      .mockResolvedValueOnce(response(op('planning.update', { topic: '继续此主题', plan })))
      .mockRejectedValueOnce(new Error('provider unavailable'));
    const checkpoint = vi.fn();
    await expect(
      createPresentationConversationCapability({ chat }).execute(command, {
        scope,
        onCheckpoint: checkpoint,
      }),
    ).rejects.toThrow('provider unavailable');
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(checkpoint.mock.calls[0][0].brief).toMatchObject({ topic: '继续此主题', plan });
  });

  it('recovers an inference on the primary channel without replaying a completed operation', async () => {
    const primary = chatPort();
    vi.mocked(primary.chat)
      .mockResolvedValueOnce(response(op('planning.update', { topic: '保留现有方案', plan })))
      .mockRejectedValueOnce(
        new MultimodalChatProviderError('CHAT_UNAVAILABLE', 'connection reset'),
      )
      .mockResolvedValueOnce(response({ phase: 'intake', message: '已继续，方案保持不变。' }));
    const activity = vi.fn();
    const checkpoint = vi.fn();
    const result = await createPresentationConversationCapability({
      chat: createResilientMultimodalChatPort(primary, { retryDelayMs: 0 }),
    }).execute(command, { scope, onActivity: activity, onCheckpoint: checkpoint });

    expect(result.brief).toMatchObject({ topic: '保留现有方案', plan });
    expect(checkpoint).toHaveBeenCalledOnce();
    expect(result.execution).toEqual([{ operation: 'planning.update', state: 'completed' }]);
    expect(activity).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'presentation.chat',
        state: 'started',
        text: '正在恢复模型连接（2/3），保留已完成的步骤',
      }),
    );
    expect(primary.chat).toHaveBeenCalledTimes(3);
  });

  it('retains usable template receipts across long briefs and multiple turns', async () => {
    const template = { templateId: 'template-1', versionId: 'version-1' };
    let brief = {
      research: JSON.stringify({
        evidence: [
          {
            operation: 'presentation.template.analyzeVisual',
            result: {
              ...template,
              learning: { status: 'ready' },
              description: '原稿风格'.repeat(6000),
            },
          },
        ],
      }),
    };
    for (let index = 0; index < 8; index++) {
      const result = await createPresentationConversationCapability({
        chat: chatPort({ message: '继续沿用原稿。' }),
      }).execute({ ...command, brief, template }, { scope });
      brief = { research: result.brief.research! };
      expect(JSON.parse(brief.research).evidence[0]).toMatchObject({
        operation: 'presentation.template.analyzeVisual',
        result: { ...template, learning: { status: 'ready' } },
      });
    }
    const result = await createPresentationConversationCapability({
      chat: chatPort(
        op('planning.update', { topic: '继续模板创作', plan }),
        op('planning.outline'),
        { slides: [slide] },
        { phase: 'outline' },
      ),
    }).execute({ ...command, brief, template }, { scope });
    expect(result.slides).toEqual([slide]);
  });

  it('can discuss a framework and revise it without invoking outline or imposing a template', async () => {
    const revised = { ...plan, narrative: '从使用者的一天展开', rationale: '用户要求故事式讲解' };
    const chat = chatPort(
      op('planning.update', { topic: '协作产品', plan }),
      op('planning.update', { plan: revised }),
      { phase: 'intake', message: '先按一天的使用旅程组织，暂不生成大纲。' },
    );
    const result = await createPresentationConversationCapability({ chat }).execute(command, {
      scope,
    });
    expect(result.brief.plan).toEqual(revised);
    expect(result.slides).toBeUndefined();
    expect(result.execution?.every((event) => event.operation === 'planning.update')).toBe(true);
  });

  it('discovers a newly installed atomic capability without changes to the agent dispatch loop', async () => {
    const execute = vi.fn(async (_input, ctx) => ({
      insight: '按时间叙事',
      owner: ctx.scope.userId,
    }));
    const runtime = new AtomicRuntime([
      {
        id: 'narrative',
        version: '1',
        operations: [
          {
            name: 'narrative.inspect',
            agent: { contexts: ['presentation.intake'] },
            description: 'Inspect narrative options',
            input: z.object({}).strict(),
            execute,
          },
        ],
      },
    ]);
    const chat = chatPort(
      op('narrative.inspect'),
      op('planning.update', { topic: '产品故事', plan }),
      { phase: 'intake', message: '采用时间叙事' },
    );
    try {
      const result = await createPresentationConversationCapability({ chat }).execute(command, {
        scope,
        capabilities: runtime,
      });
      expect(execute).toHaveBeenCalledWith({}, expect.objectContaining({ scope }));
      expect(result.brief.research).toContain('按时间叙事');
      expect(JSON.stringify(vi.mocked(chat.chat).mock.calls[0])).toContain('narrative.inspect');
    } finally {
      await runtime.dispose();
    }
  });

  it('rejects hidden capabilities and disabled search before any tool effect', async () => {
    const search = vi.fn();
    const runtime = createPresentationContextRuntime({
      readFile: vi.fn(),
      readSkill: vi.fn(),
      search,
      listSkills: async () => [],
    });
    try {
      await expect(
        createPresentationConversationCapability({
          chat: chatPort(op('context.search', { query: 'private' })),
        }).execute(command, { scope, tools: runtime }),
      ).rejects.toThrow('联网搜索不可用');
      await expect(
        createPresentationConversationCapability({
          chat: chatPort(op('presentation.job.delete')),
        }).execute(command, { scope, tools: runtime }),
      ).rejects.toThrow('unavailable');
      expect(search).not.toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });

  it('feeds tool errors back so the agent can revise the approach instead of running a fixed chain', async () => {
    const runtime = createPresentationContextRuntime({
      readFile: vi.fn(),
      readSkill: vi.fn(),
      search: vi.fn(async () => {
        throw new Error('No sources');
      }),
      listSkills: async () => [],
    });
    const chat = chatPort(
      op('context.search', { query: '试点' }),
      op('planning.update', { topic: '先做分析框架', plan }),
      { phase: 'intake', message: '暂缺可验证来源，先列待补数据。' },
    );
    try {
      const result = await createPresentationConversationCapability({ chat }).execute(
        { ...command, tools: { search: true } },
        { scope, tools: runtime },
      );
      expect(result.execution?.[0].state).toBe('failed');
      expect(JSON.stringify(vi.mocked(chat.chat).mock.calls[1])).toContain('No sources');
      expect(result.slides).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  });

  it('retires an exhausted tool while preserving completed evidence and continuing the plan', async () => {
    const inspect = vi.fn(async () => ({ finding: '已完成的模板证据' }));
    const runtime = new AtomicRuntime([
      {
        id: 'probe',
        version: '1',
        operations: [
          {
            name: 'probe.inspect',
            agent: { contexts: ['presentation.intake'], maxCalls: 1 },
            description: 'Inspect once',
            input: z.object({}).strict(),
            execute: inspect,
          },
        ],
      },
    ]);
    const chat = chatPort(
      op('probe.inspect'),
      op('probe.inspect'),
      op('planning.update', { topic: '保留进度', plan }),
      { phase: 'intake', message: '已使用现有证据继续规划。' },
    );
    try {
      const result = await createPresentationConversationCapability({ chat }).execute(command, {
        scope,
        capabilities: runtime,
      });
      expect(inspect).toHaveBeenCalledOnce();
      expect(result.message).toBe('已使用现有证据继续规划。');
      expect(result.brief.plan).toEqual(plan);
      expect(result.brief.research).toContain('已完成的模板证据');
      expect(result.execution).toEqual([
        { operation: 'probe.inspect', state: 'completed' },
        { operation: 'probe.inspect', state: 'failed' },
        { operation: 'planning.update', state: 'completed' },
      ]);
      expect(JSON.stringify(vi.mocked(chat.chat).mock.calls[2])).toContain('exhaustedTools');
      expect(JSON.stringify(vi.mocked(chat.chat).mock.calls[2])).toContain('probe.inspect');
    } finally {
      await runtime.dispose();
    }
  });

  it('restores completed template learning from the saved brief instead of starting over', async () => {
    const template = { templateId: 'template-1', versionId: 'version-1' };
    const chat = chatPort(
      op('planning.update', { topic: '继续模板创作', plan }),
      op('planning.outline'),
      { slides: [slide] },
      { phase: 'outline', message: '沿用已学模板完成大纲。' },
    );
    const result = await createPresentationConversationCapability({ chat }).execute(
      {
        ...command,
        brief: {
          research: JSON.stringify({
            evidence: [
              {
                operation: 'presentation.template.analyzeVisual',
                result: { ...template, learning: { status: 'ready' } },
              },
            ],
          }),
        },
        template,
      },
      { scope },
    );

    expect(result).toMatchObject({
      message: '沿用已学模板完成大纲。',
      phase: 'outline',
      slides: [slide],
    });
  });

  it('repairs malformed model JSON once and never fabricates an outline receipt', async () => {
    const chat = chatPort(
      { phase: 'outline', message: 'fake completion' },
      { phase: 'intake', message: '先确认目标' },
    );
    vi.mocked(chat.chat).mockResolvedValueOnce({
      ...response(null),
      choices: [{ index: 0, message: { role: 'assistant', content: '{invalid}' } }],
    });
    // The queued valid decisions precede the malformed one, so prepend explicitly.
    vi.mocked(chat.chat)
      .mockReset()
      .mockResolvedValueOnce({
        ...response(null),
        choices: [{ index: 0, message: { role: 'assistant', content: '{invalid}' } }],
      })
      .mockResolvedValueOnce(response({ phase: 'outline', message: 'fake completion' }))
      .mockResolvedValueOnce(response({ phase: 'intake', message: '先确认目标' }));
    const result = await createPresentationConversationCapability({ chat }).execute(command, {
      scope,
    });
    expect(result.phase).toBe('intake');
    expect(result.slides).toBeUndefined();
    expect(chat.chat).toHaveBeenCalledTimes(3);
  });

  it('extracts one balanced JSON object from provider prose', async () => {
    const chat = chatPort();
    vi.mocked(chat.chat).mockResolvedValueOnce({
      ...response(null),
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content:
              '<think>internal planning</think>我会先确认场景。\n```json\n{"phase":"intake","message":"这份演示主要用于什么场合？","questionId":"audience-scene"}\n```',
          },
        },
      ],
    });

    await expect(
      createPresentationConversationCapability({ chat }).execute(command, { scope }),
    ).resolves.toMatchObject({
      message: '我已梳理当前信息，接下来需要你确认一个关键决定。',
      phase: 'intake',
      question: { prompt: '这份演示主要用于什么场合？' },
      questionId: 'audience-scene',
    });
    expect(chat.chat).toHaveBeenCalledOnce();
  });

  it('keeps a structured decision question separate from the short chat message', async () => {
    const chat = chatPort({
      phase: 'intake',
      message: '模板已经看完，还需要你确认一个关键决定。',
      questionId: 'audience-scene',
      question: {
        title: '确认使用场景',
        prompt: '这次主要用于什么场合？',
        context: ['已观察 6 张真实页面', '第 13 页包含视频'],
        choices: [
          { id: 'recruit', label: '社团招新宣讲', description: '面向新生' },
          { id: 'course', label: '课程介绍' },
        ],
      },
    });

    await expect(
      createPresentationConversationCapability({ chat }).execute(command, { scope }),
    ).resolves.toMatchObject({
      message: '模板已经看完，还需要你确认一个关键决定。',
      question: {
        choices: [{ id: 'recruit', label: '社团招新宣讲' }, { id: 'course' }],
        context: ['已观察 6 张真实页面', '第 13 页包含视频'],
        prompt: '这次主要用于什么场合？',
        title: '确认使用场景',
      },
      questionId: 'audience-scene',
    });
  });

  it('recovers a usable short message when the model returns only a structured question', async () => {
    const chat = chatPort({
      phase: 'intake',
      question: {
        title: '确认事实范围',
        prompt: '是否允许联网核实学校与模型资料？',
        choices: [{ id: 'search', label: '允许联网检索' }],
      },
    });

    await expect(
      createPresentationConversationCapability({ chat }).execute(command, { scope }),
    ).resolves.toMatchObject({
      message: '我已梳理当前信息，接下来需要你确认一个关键决定。',
      phase: 'intake',
      question: { prompt: '是否允许联网核实学校与模型资料？' },
      questionId: 't-question-1',
    });
  });

  it('recovers a short completion message when an executed outline omits message', async () => {
    const chat = chatPort(
      op('planning.update', { topic: '发布演示', plan }),
      op('planning.outline'),
      { slides: [slide] },
      { phase: 'outline' },
    );

    await expect(
      createPresentationConversationCapability({ chat }).execute(command, { scope }),
    ).resolves.toMatchObject({
      message: '信息已整理完成，我已经生成了逐页大纲。',
      phase: 'outline',
      slides: [slide],
    });
  });

  it('keeps the current brief and returns a recoverable turn after repeated invalid JSON', async () => {
    const chat = chatPort();
    vi.mocked(chat.chat)
      .mockResolvedValueOnce({
        ...response(null),
        choices: [{ index: 0, message: { role: 'assistant', content: '{invalid-1}' } }],
      })
      .mockResolvedValueOnce({
        ...response(null),
        choices: [{ index: 0, message: { role: 'assistant', content: 'still invalid' } }],
      })
      .mockResolvedValueOnce({
        ...response(null),
        choices: [{ index: 0, message: { role: 'assistant', content: '```json\n[]\n```' } }],
      });

    const result = await createPresentationConversationCapability({ chat }).execute(
      { ...command, brief: { topic: '已保存主题' } },
      { scope },
    );
    expect(result).toMatchObject({
      brief: { topic: '已保存主题' },
      message: '刚才的规划结果没有完整生成。我已保留现有信息，请重试本轮或继续补充。',
      phase: 'intake',
    });
    expect(chat.chat).toHaveBeenCalledTimes(3);
  });
});

it('streams actual tool events and preserves generated asset refs outside truncated prose', async () => {
  const runtime = new AtomicRuntime([
    {
      id: 'assets',
      version: '1',
      operations: [
        {
          name: 'assets.generate',
          description: 'Create artwork',
          input: z.object({ requestId: z.string() }),
          agent: { contexts: ['presentation.intake'] },
          execute: async () => ({ ref: 'owned-watercolor', artifactId: 'owned-watercolor' }),
        },
      ],
    },
  ]);
  const activities = vi.fn();
  try {
    const result = await createPresentationConversationCapability({
      chat: chatPort(op('assets.generate'), { phase: 'intake', message: '素材已就绪' }),
    }).execute(command, { scope, capabilities: runtime, onActivity: activities });
    expect(result.brief.assets).toEqual(['owned-watercolor']);
    expect(activities.mock.calls.map(([event]) => event.state)).toEqual(['started', 'completed']);
    expect(activities.mock.calls[0][0].text).toBe('正在生成视觉素材');
  } finally {
    await runtime.dispose();
  }
});
