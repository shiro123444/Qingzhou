import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { TeachingRecord, TeachingSelection } from '@/types/presentationTeaching';

import { TeachingMemoryWorkspace } from './TeachingMemoryWorkspace';

const record: TeachingRecord = {
  id: `teaching-${'a'.repeat(40)}`,
  schemaVersion: 1,
  createdAt: '2026-09-22',
  revision: 0,
  status: 'pending',
  source: {
    templateId: 't',
    versionId: 'v',
    name: '模板',
    sha256: 'b'.repeat(64),
    pageCount: 2,
    analysis: 'ooxml-sequence-v1',
  },
  pattern: {
    name: '先观察后解释',
    observation: '第1页是问题，第2页是解释',
    inference: '可能用于先预测',
    confidence: 'medium',
    applicability: '需要预测时',
    prerequisites: '已知变量',
    teacherAction: '等待回应',
    learnerAction: '提出预测',
    sequence: ['观察', '解释'],
    limitations: '不适用于首次认识变量',
    evidence: [
      { page: 1, field: 'text', quote: '观察实验现象' },
      { page: 2, field: 'notes', quote: '解释变化机制' },
    ],
  },
};
describe('teaching memory review', () => {
  it('does not confirm on load, requires acknowledgment, and passes explicit revision and edited conditions', async () => {
    const client = {
      list: vi.fn(async () => [record]),
      analyze: vi.fn(async () => [record]),
      review: vi.fn(async () => record),
    };
    const onChange = vi.fn();
    render(
      <TeachingMemoryWorkspace
        client={client}
        selection={{ course: '', ids: [] }}
        onChange={onChange}
      />,
    );
    await screen.findByDisplayValue('需要预测时');
    expect(client.review).not.toHaveBeenCalled();
    expect(screen.queryByText(/presentationTeaching.use:/u)).not.toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: 'presentationTeaching.confirm' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByDisplayValue('需要预测时'), {
      target: { value: '本课仅用于迁移练习' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'presentationTeaching.acknowledge' }));
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(client.review).toHaveBeenCalledWith(
        expect.objectContaining({
          id: record.id,
          expectedRevision: 0,
          action: 'confirm',
          applicability: '本课仅用于迁移练习',
        }),
      ),
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ course: '', ids: [] }));
  });
  it('reuses confirmed account patterns without a template and invalidates selection on course changes', async () => {
    const confirmed: TeachingRecord = {
      ...record,
      status: 'confirmed',
      revision: 1,
      review: { at: 'now', course: '', applicability: '已确认条件', limitations: '已确认限制' },
    };
    const client = {
      list: vi.fn(async () => [confirmed]),
      analyze: vi.fn(async () => []),
      review: vi.fn(async () => confirmed),
    };
    const onChange = vi.fn<(selection: TeachingSelection) => void>();
    render(
      <TeachingMemoryWorkspace
        client={client}
        selection={{ course: '', ids: [] }}
        onChange={onChange}
      />,
    );
    const use = await screen.findByRole('checkbox', {
      name: 'presentationTeaching.use: 先观察后解释',
    });
    await waitFor(() => expect(use).not.toBeDisabled());
    fireEvent.click(use);
    expect(onChange).toHaveBeenLastCalledWith({ course: '', ids: [record.id] });
    expect(screen.getByRole('button', { name: /presentationTeaching.analyze/u })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('presentationTeaching.currentCourse'), {
      target: { value: '认知课' },
    });
    expect(onChange).toHaveBeenLastCalledWith({ course: '认知课', ids: [] });
    expect(client.review).not.toHaveBeenCalled();
  });
});
