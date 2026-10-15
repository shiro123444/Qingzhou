import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { expect, it, vi } from 'vitest';

import type { PresentationMaterials } from '@/types/presentationMaterial';

import { PresentationAgentFlow } from './index';
import type { PresentationAgentClient } from './presentationAgentClient';

// Exercise orchestration without mounting the unrelated rich editor and chat history stores.
vi.mock('@/features/Conversation', () => ({
  ChatList: ({ welcome }: { welcome: React.ReactNode }) => welcome,
  ConversationProvider: ({ children }: { children: React.ReactNode }) => children,
  MessageItem: () => null,
}));
vi.mock('@/features/QingzhouBrand', () => ({ QingzhouPresentationScene: () => null }));
vi.mock('./PresentationChatInput', () => ({
  default: function MockPresentationChatInput({
    onSend,
  }: {
    onSend: (input: { text: string; references: [] }) => void;
  }) {
    const [text, setText] = useState('');
    return (
      <>
        <textarea
          aria-label="creative request"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button onClick={() => onSend({ text, references: [] })}>Send request</button>
      </>
    );
  },
}));

it('carries teaching intent from the first conversation into the actual lesson workspace', async () => {
  const client: PresentationAgentClient = {
    outline: vi.fn(),
    turn: vi.fn(async () => ({
      brief: { topic: '实验预测', audience: '本科生' },
      message: '规划好了',
      phase: 'outline' as const,
      slides: [{ id: 's1', title: '实验预测', keyPoints: ['先预测，再揭示'] }],
    })),
  };
  render(
    <PresentationAgentFlow agentClient={client} onCreate={vi.fn()} onOutlineAiRewrite={vi.fn()} />,
  );
  fireEvent.click(screen.getByText('presentationCreation.lesson'));
  fireEvent.change(screen.getByLabelText('creative request'), {
    target: { value: '先让学生预测，再展示实验结果' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
  expect(await screen.findByTestId('lesson-workspace')).toBeInTheDocument();
  expect(screen.getByRole('textbox')).toHaveValue('先让学生预测，再展示实验结果');
  expect(vi.mocked(client.turn).mock.calls[0][0].messages.at(-1)?.content).toContain(
    '创作场景：备课',
  );
  expect(client.outline).not.toHaveBeenCalled();
});

it('keeps document evidence, download artifacts and slide citations when continuing from storyboard to generation', async () => {
  const materials: PresentationMaterials = {
    documents: [
      {
        sourceId: 'a',
        name: 'research.pdf',
        fingerprint: 'a'.repeat(64),
        format: 'pdf',
        totalSegments: 3,
        totalCharacters: 30,
        emptyPages: [],
        segments: [
          { id: 'a-page3', locator: { page: 3, chunk: 1 }, heading: '预算', characters: 8 },
        ],
      },
    ],
    segments: [
      { id: 'a-page3', sourceId: 'a', locator: { page: 3, chunk: 1 }, text: '预算37万元' },
    ],
    artifacts: [
      {
        id: 'attachment-a',
        name: 'research-2-3.pdf',
        url: '/api/runtime/presentation/artifacts/attachment-a?raw=true',
      },
    ],
  };
  const sourceRefs = [{ sourceId: 'a', segmentId: 'a-page3' }];
  const onCreate = vi.fn();
  const client: PresentationAgentClient = {
    outline: vi.fn(),
    turn: vi.fn(async () => ({
      brief: { topic: '科研预算', audience: '高校教师', style: '水彩', materials },
      message: '已完成分镜',
      phase: 'outline' as const,
      slides: [{ id: 'slide-1', title: '科研预算', keyPoints: ['预算37万元'], sourceRefs }],
    })),
  };
  render(
    <PresentationAgentFlow agentClient={client} onCreate={onCreate} onOutlineAiRewrite={vi.fn()} />,
  );
  fireEvent.change(screen.getByLabelText('creative request'), {
    target: { value: '根据资料制作报告' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
  expect(await screen.findByText('research.pdf', { exact: false })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'research-2-3.pdf', hidden: true })).toHaveAttribute(
    'href',
    materials.artifacts![0].url,
  );
  fireEvent.click(screen.getByRole('button', { name: '确认大纲，继续生成' }));
  await waitFor(() => expect(onCreate).toHaveBeenCalled());
  expect(onCreate.mock.calls[0][0].options).toMatchObject({ materials, outline: [{ sourceRefs }] });
});
