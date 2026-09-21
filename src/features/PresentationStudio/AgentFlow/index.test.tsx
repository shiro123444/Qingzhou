import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PresentationAgentFlow } from './index';
import type { PresentationAgentClient } from './presentationAgentClient';

const outlineSlides = (count: number, topic: string) =>
  Array.from({ length: count }, (_, index) => ({
    id: `slide-${index + 1}`,
    keyPoints: [`${topic}要点 ${index + 1}`],
    objective: `目标 ${index + 1}`,
    title: index === 0 ? topic : `${topic}章节 ${index + 1}`,
    visualSuggestion: '现代构图',
  }));

const readyClient = (
  brief: Awaited<ReturnType<PresentationAgentClient['turn']>>['brief'],
): PresentationAgentClient => ({
  outline: vi.fn(async () => ({
    slides: outlineSlides(brief.slideCount ?? 3, brief.topic ?? '演示文稿'),
  })),
  turn: vi.fn(async () => ({
    brief,
    message: '信息已经足够，我来整理逐页大纲。',
    phase: 'outline' as const,
    slides: outlineSlides(brief.slideCount ?? 3, brief.topic ?? '演示文稿'),
  })),
});

const rewriteOutline = vi.fn(async ({ allSlides }) => allSlides);

describe('PresentationAgentFlow (A-1 / A-2 / A-3)', () => {
  it.each([
    '工具调用次数已达本轮上限',
    'Conversation response message is required',
    'Failed to parse multimodal chat response JSON',
  ])('resumes a legacy failure (%s) without clearing the existing conversation', async (error) => {
    const turn = vi
      .fn<PresentationAgentClient['turn']>()
      .mockImplementationOnce(async (_input, options) => {
        options?.onCheckpoint?.({
          brief: { topic: '模型发布', assets: ['saved-artwork'], research: '已经核实的资料' },
        });
        throw new Error(error);
      })
      .mockResolvedValueOnce({
        brief: { topic: '模型发布' },
        message: '已从保存的模板分析继续。',
        phase: 'intake',
      });

    render(
      <PresentationAgentFlow
        agentClient={{ outline: vi.fn(async () => ({ slides: [] })), turn }}
        initialTopic="模型发布"
        onCreate={vi.fn()}
        onOutlineAiRewrite={rewriteOutline}
      />,
    );

    await waitFor(() => expect(turn).toHaveBeenCalledTimes(2));
    expect(turn.mock.calls[1][0].messages.at(-1)?.content).toContain('[恢复执行]');
    expect(turn.mock.calls[1][0].brief).toMatchObject({
      assets: ['saved-artwork'],
      research: '已经核实的资料',
    });
    expect(await screen.findByText('已从保存的模板分析继续。')).toBeInTheDocument();
    expect(screen.getByTestId('presentation-agent-transcript')).toHaveTextContent('模型发布');
    expect(screen.queryByText('工具调用次数已达本轮上限')).not.toBeInTheDocument();
  });

  it('does not loop automatic recovery when the provider keeps failing', async () => {
    let rejectRecovery!: (error: Error) => void;
    const recovery = new Promise<never>((_resolve, reject) => {
      rejectRecovery = reject;
    });
    const turn = vi
      .fn<PresentationAgentClient['turn']>()
      .mockRejectedValueOnce(new Error('Conversation response message is required'))
      .mockReturnValue(recovery);
    render(
      <PresentationAgentFlow
        agentClient={{ outline: vi.fn(async () => ({ slides: [] })), turn }}
        initialTopic="保留这次创作"
        onCreate={vi.fn()}
        onOutlineAiRewrite={rewriteOutline}
      />,
    );
    await waitFor(() => expect(turn).toHaveBeenCalledTimes(2));
    await act(async () =>
      rejectRecovery(new Error('Failed to parse multimodal chat response JSON')),
    );
    expect(screen.getByTestId('presentation-agent-error')).toHaveTextContent(
      'Failed to parse multimodal chat response JSON',
    );
    expect(turn).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('presentation-agent-transcript')).toHaveTextContent('保留这次创作');
  });

  it('moves imported template learning into the main conversation with live Cordis activity', async () => {
    let resolveTurn!: (value: Awaited<ReturnType<PresentationAgentClient['turn']>>) => void;
    const turn = vi.fn<PresentationAgentClient['turn']>(
      () =>
        new Promise((resolve) => {
          resolveTurn = resolve;
        }),
    );
    const client: PresentationAgentClient = {
      outline: vi.fn(async () => ({ slides: [] })),
      turn,
    };

    render(
      <PresentationAgentFlow
        agentClient={client}
        initialTopic="秋季招新计划"
        selectedTemplate={{
          name: '招新',
          templateId: 'template-recruit',
          versionId: 'version-1',
        }}
        onCreate={vi.fn()}
        onOutlineAiRewrite={rewriteOutline}
      />,
    );

    expect(
      await screen.findByText(
        '模板「招新」已保存。我正在查看真实页面、媒体和组件；需要你决定的地方会直接在这里询问。',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '联网搜索与技能（联网搜索已开启）' })).toBeVisible();
    expect(screen.getByTestId('presentation-agent-transcript')).toHaveTextContent('秋季招新计划');
    expect(screen.queryByText(/界面事件：模板已由当前用户选择/u)).not.toBeInTheDocument();
    expect(turn).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.stringContaining('模板已由当前用户选择'),
            role: 'user',
          }),
        ],
        template: { templateId: 'template-recruit', versionId: 'version-1' },
        tools: expect.objectContaining({ search: true }),
      }),
      expect.objectContaining({
        onActivity: expect.any(Function),
        onMessageDelta: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    );

    act(() => {
      turn.mock.calls[0][1]?.onActivity?.({
        operation: 'presentation.template.observeMedia',
        state: 'started',
        text: '正在观察模板中的视频与音频',
      });
    });
    expect(screen.getByTestId('presentation-agent-activity-wave').children).toHaveLength(3);
    expect(
      screen.getByRole('status', { name: '正在观察模板中的视频与音频' }).querySelector('svg'),
    ).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('presentation-agent-thinking')).toHaveTextContent(
        '正在观察模板中的视频与音频',
      );
    });

    await act(async () => {
      resolveTurn({
        brief: {},
        message: '第 12 页的视频在新版本中需要保留吗？',
        phase: 'intake',
        questionId: 'media-video-12',
      });
    });
    expect(await screen.findByTestId('presentation-agent-question')).toHaveTextContent(
      '第 12 页的视频在新版本中需要保留吗？',
    );
    expect(screen.queryByTestId('presentation-agent-thinking')).not.toBeInTheDocument();
    expect(screen.queryByTestId('presentation-chat-input-adapter')).not.toBeInTheDocument();
    expect(screen.getByTestId('presentation-agent-question')).toHaveTextContent('Jumi 已暂停执行');

    fireEvent.click(screen.getByRole('button', { name: /其他，我自己填写/u }));
    fireEvent.change(screen.getByRole('textbox', { name: '回答当前问题' }), {
      target: { value: '保留视频，但用新的字幕。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认并继续' }));
    await waitFor(() => expect(turn).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('presentation-agent-transcript')).toHaveTextContent(
      '保留视频，但用新的字幕。',
    );
    expect(turn.mock.calls[1][0].messages.at(-1)).toEqual({
      content:
        '[回答问题 media-video-12]\n问题：第 12 页的视频在新版本中需要保留吗？\n用户决定：保留视频，但用新的字幕。',
      role: 'user',
    });

    await act(async () => {
      resolveTurn({
        brief: {
          audience: '新生',
          slideCount: 6,
          style: '暖白珊瑚色',
          topic: '秋季招新计划',
        },
        message: '信息已齐，我整理好了逐页大纲。',
        phase: 'outline',
        slides: outlineSlides(6, '秋季招新计划'),
      });
    });

    expect(await screen.findByTestId('presentation-agent-brief-confirmation')).toHaveTextContent(
      '信息概述',
    );
    expect(screen.getByTestId('presentation-agent-brief-confirmation')).toHaveTextContent(
      '保留视频，但用新的字幕。',
    );
    fireEvent.click(screen.getByRole('button', { name: '确认信息，查看大纲' }));
    expect(await screen.findByText('秋季招新计划章节 2')).toBeInTheDocument();
  }, 20_000);

  it('renders the agent-produced outline without triggering a fixed frontend outline call', async () => {
    let resolveTurn!: (value: Awaited<ReturnType<PresentationAgentClient['turn']>>) => void;
    const turnPromise = new Promise((resolve) => {
      resolveTurn = resolve;
    });
    const client: PresentationAgentClient = {
      outline: vi.fn(async () => ({
        slides: [
          {
            id: 'slide-1',
            keyPoints: ['关键判断'],
            objective: '支持管理层决策',
            title: 'AI 生成的决策大纲',
            visualSuggestion: '趋势图',
          },
        ],
      })),
      turn: vi.fn(() => turnPromise as ReturnType<PresentationAgentClient['turn']>),
    };
    const onOutlineAiRewrite = vi.fn(async ({ allSlides }) => allSlides);

    render(
      <PresentationAgentFlow
        agentClient={client}
        initialTopic="年度经营计划"
        onCreate={vi.fn()}
        onOutlineAiRewrite={onOutlineAiRewrite}
      />,
    );

    expect(await screen.findByTestId('presentation-agent-thinking')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('presentation-agent-thinking')).toHaveTextContent(
        '正在理解你的要求',
      );
    });
    expect(screen.getByTestId('presentation-agent-transcript')).toHaveTextContent('年度经营计划');
    expect(screen.queryByTestId('presentation-chat-input-adapter')).not.toBeInTheDocument();
    expect(screen.getByTestId('presentation-agent-flow')).toContainElement(
      screen.getByTestId('presentation-agent-thinking'),
    );
    expect(client.turn).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [expect.objectContaining({ content: '年度经营计划', role: 'user' })],
      }),
      expect.objectContaining({
        onActivity: expect.any(Function),
        onMessageDelta: expect.any(Function),
        signal: expect.any(AbortSignal),
      }),
    );

    await act(async () => {
      resolveTurn({
        brief: { audience: '管理层', slideCount: 8, topic: '年度经营计划' },
        message: '信息已经足够，我来整理逐页大纲。',
        phase: 'outline',
        slides: [
          {
            id: 'slide-1',
            keyPoints: ['关键判断'],
            title: 'AI 生成的决策大纲',
            objective: '支持管理层决策',
            visualSuggestion: '趋势图',
          },
        ],
      });
    });

    expect(await screen.findByText('AI 生成的决策大纲')).toBeInTheDocument();
    expect(client.outline).not.toHaveBeenCalled();
    expect(onOutlineAiRewrite).not.toHaveBeenCalled();
  }, 20_000);

  it('renders typewriter title, fills template without auto-submitting, and walks through the state machine', async () => {
    const onCreate = vi.fn();

    render(
      <PresentationAgentFlow
        agentClient={readyClient({ topic: '模板测试' })}
        onCreate={onCreate}
        onOutlineAiRewrite={rewriteOutline}
      />,
    );

    // Step 1: Typewriter title is present (A-1: No PPT icon or "PPT 创作专家")
    expect(screen.getByTestId('presentation-typewriter-title')).toBeInTheDocument();
    expect(screen.queryByText('PPT 创作专家')).not.toBeInTheDocument();
    expect(screen.getByTestId('presentation-chat-input-adapter')).toBeInTheDocument();
    expect(screen.queryByTestId('presentation-agent-thinking')).not.toBeInTheDocument();

    // A-1 / A-3: Click template chip only fills the draft and DOES NOT auto-submit; no emoji prefix
    const templateChip = screen.getByText('企业战略规划 · 2026年企业数字化转型战略规划');
    expect(templateChip).toBeInTheDocument();
    fireEvent.click(templateChip);

    // Assert that we are still on the welcome / topic step (audience options have not appeared yet)
    expect(screen.queryByTestId('audience-options-group')).not.toBeInTheDocument();
    expect(screen.getByTestId('presentation-typewriter-title')).toBeInTheDocument();
  }, 60000);

  it('uses the Agent brief and outline as the only generation input', async () => {
    const onCreate = vi.fn();
    const client = readyClient({
      aspectRatio: '16:9',
      audience: '行业演讲',
      language: 'zh-CN',
      slideCount: 12,
      style: '科技极简',
      topic: '2026年企业数字化转型战略规划',
    });

    render(
      <PresentationAgentFlow
        agentClient={client}
        initialTopic="2026年企业数字化转型战略规划"
        onCreate={onCreate}
        onOutlineAiRewrite={rewriteOutline}
      />,
    );

    // User message for topic is shown
    await waitFor(() => {
      expect(screen.getAllByText('2026年企业数字化转型战略规划').length).toBeGreaterThan(0);
    });

    // The capability result opens the editable outline directly; no fixed
    // audience/count/style questionnaire is rendered by React.
    await waitFor(() => {
      expect(screen.getByTestId('presentation-agent-outline')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('audience-options-group')).not.toBeInTheDocument();
    expect(screen.getAllByText('2026年企业数字化转型战略规划').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /确认大纲，继续生成/ }));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        aspectRatio: '16:9',
        language: 'zh-CN',
        options: expect.objectContaining({
          audience: '行业演讲',
          style: '科技极简',
        }),
        prompt: expect.stringContaining('2026年企业数字化转型战略规划'),
        slideCount: 12,
        title: '2026年企业数字化转型战略规划',
      }),
    );
    const submitted = onCreate.mock.calls[0][0];
    // Asset decisions belong to the server's generated page plan.
    expect(submitted.options).not.toHaveProperty('imageSlots');
  }, 60000);

  it('forwards the notebook context required by the runtime contract', async () => {
    const onCreate = vi.fn();
    const client = readyClient({
      audience: '商务汇报',
      slideCount: 8,
      style: '科技极简',
      topic: '真实 Notebook 内容',
    });

    render(
      <PresentationAgentFlow
        agentClient={client}
        defaultNotebookId="notebook-real"
        defaultSourceVersionIds={['version-real']}
        initialTopic="真实 Notebook 内容"
        onCreate={onCreate}
        onOutlineAiRewrite={rewriteOutline}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /确认大纲，继续生成/ }));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        notebookId: 'notebook-real',
        sourceVersionIds: ['version-real'],
      }),
    );
  }, 60000);
});
