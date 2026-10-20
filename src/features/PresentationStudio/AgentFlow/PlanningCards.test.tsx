import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AgentQuestionCard } from './PlanningCards';

describe('AgentQuestionCard', () => {
  it('separates context, predicted choices and the final custom answer field', () => {
    const onAnswerChange = vi.fn();
    render(
      <AgentQuestionCard
        answerCount={0}
        value=""
        question={{
          choices: [
            { id: 'recruit', label: '社团招新宣讲', description: '面向新生' },
            { id: 'course', label: '课程介绍' },
          ],
          context: ['**已观察** 6 张真实页面', '第 13 页包含视频'],
          prompt: '**这次主要用于什么场合？**',
          title: '确认使用场景',
        }}
        onAnswerChange={onAnswerChange}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByText('这次主要用于什么场合？')).toBeInTheDocument();
    expect(screen.getByText('已观察 6 张真实页面')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: '回答当前问题' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /社团招新宣讲/u }));
    expect(onAnswerChange).toHaveBeenLastCalledWith('社团招新宣讲');

    fireEvent.click(screen.getByRole('button', { name: /其他，我自己填写/u }));
    expect(screen.getByRole('textbox', { name: '回答当前问题' })).toBeInTheDocument();
    expect(onAnswerChange).toHaveBeenLastCalledWith('');
  });
});
