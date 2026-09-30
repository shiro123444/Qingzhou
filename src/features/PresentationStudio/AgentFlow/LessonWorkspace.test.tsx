import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { LessonPlan, TeacherBrief } from '@/types/presentationLesson';

import { LessonWorkspace } from './LessonWorkspace';

const fixture = (brief: TeacherBrief, title = '预测'): LessonPlan => ({
  schemaVersion: 1,
  brief,
  beats: [
    {
      id: 'b1',
      title,
      objective: '理解方向',
      teacherCue: '等待学生解释',
      studentAction: '画方向',
      checkForUnderstanding: '说明理由',
      durationMinutes: 2,
      locked: false,
      frames: [
        {
          id: 'f1',
          title: '往哪里走？',
          kind: 'question',
          visibleContent: [],
          visualCue: '等高线',
          withheldContent: ['答案'],
          boardSpace: 'none',
        },
      ],
    },
  ],
});
const send = (message: string) => {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: message } });
  fireEvent.click(screen.getByTestId('lesson-plan-propose'));
};
describe('conversational teacher workspace', () => {
  it('uses one composer and requires acceptance before generating; supports focused revisions and undo', async () => {
    const onChange = vi.fn();
    const onPlan = vi.fn(async (brief: TeacherBrief, current?: LessonPlan) =>
      fixture(brief, current ? '实验之后预测' : '预测'),
    );
    render(
      <LessonWorkspace audience="本科生" topic="最优化" onChange={onChange} onPlan={onPlan} />,
    );
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(onPlan).not.toHaveBeenCalled();
    send('先预测再揭示');
    await screen.findByTestId('lesson-accept');
    expect(onChange.mock.lastCall?.[0]).toBeUndefined();
    expect(onPlan.mock.calls[0][0].opening).toBe('cover');
    fireEvent.click(screen.getByTestId('lesson-accept'));
    expect(onChange.mock.lastCall?.[0].beats[0].title).toBe('预测');
    fireEvent.click(screen.getByRole('button', { name: /往哪里走/ }));
    expect(screen.getByText(/等待学生解释/)).toBeInTheDocument();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    send('这里先做实验');
    await screen.findByTestId('lesson-accept');
    expect(onPlan.mock.calls[1][1]?.beats[0].title).toBe('预测');
    expect(onPlan.mock.calls[1][0]).toEqual(onPlan.mock.calls[0][0]);
    fireEvent.click(screen.getByTestId('lesson-accept'));
    expect(onChange.mock.lastCall?.[0].beats[0].title).toBe('实验之后预测');
    fireEvent.click(screen.getByRole('button', { name: 'presentationLesson.undo' }));
    expect(onChange.mock.lastCall?.[0].beats[0].title).toBe('预测');
  });
  it('preserves accepted work after a failed request and supports teacher locking', async () => {
    const onChange = vi.fn();
    const onPlan = vi.fn(async (brief: TeacherBrief) => fixture(brief));
    render(<LessonWorkspace onChange={onChange} onPlan={onPlan} />);
    send('逐步解释方向');
    fireEvent.click(await screen.findByTestId('lesson-accept'));
    fireEvent.click(screen.getByRole('button', { name: 'presentationLesson.lock' }));
    expect(onChange.mock.lastCall?.[0].beats[0].locked).toBe(true);
    onPlan.mockRejectedValueOnce(new Error('network failed'));
    send('加一个例子');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('network failed'));
    expect(onChange.mock.lastCall?.[0].beats[0].locked).toBe(true);
    expect(screen.getByRole('textbox')).toHaveValue('加一个例子');
  });
  it('keeps the old plan when a proposed rewrite is discarded', async () => {
    const onChange = vi.fn();
    const onPlan = vi.fn(async (brief: TeacherBrief, current?: LessonPlan) =>
      fixture(brief, current ? '新讲法' : '原讲法'),
    );
    render(<LessonWorkspace onChange={onChange} onPlan={onPlan} />);
    send('先提问');
    fireEvent.click(await screen.findByTestId('lesson-accept'));
    send('换讲法');
    await screen.findByTestId('lesson-accept');
    fireEvent.click(screen.getByRole('button', { name: 'presentationLesson.discard' }));
    expect(onChange.mock.lastCall?.[0].beats[0].title).toBe('原讲法');
  });
});
