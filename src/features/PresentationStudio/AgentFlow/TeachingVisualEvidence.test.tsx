import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { TeachingRecord } from '@/types/presentationTeaching';

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
    name: '实际截图',
    sha256: 'b'.repeat(64),
    pageCount: 2,
    analysis: 'native-static-sequence-v1',
    visualPages: [1, 2].map((page) => ({
      page,
      ref: `teaching-page-${String(page).repeat(40)}`,
      sha256: 'c'.repeat(64),
      width: 320,
      height: 180,
      builds: [],
      buildsTruncated: false,
    })),
  },
  pattern: {
    name: '焦点迁移',
    observation: '服务器原文证据',
    inference: '可能支持定位',
    confidence: 'medium',
    applicability: '章节转换时',
    prerequisites: '已见过总览',
    teacherAction: '指出当前分支',
    learnerAction: '解释位置',
    sequence: ['总览', '聚焦'],
    limitations: '不是动画验证',
    evidence: [
      { page: 1, field: 'text', quote: '原文证据一' },
      { page: 2, field: 'text', quote: '原文证据二' },
    ],
    visualComparisons: [
      {
        fromPage: 1,
        toPage: 2,
        kind: 'focus-shift',
        visibleChange: '右侧颜色变化',
        alternativeExplanation: '模板变化',
        uncertainty: '不可确定点击时序',
        regions: [1, 2].map((page) => ({
          page,
          x: 0.1,
          y: 0.1,
          width: 0.3,
          height: 0.3,
          description: `第${page}页节点`,
        })),
      },
    ],
  },
};

describe('visual teaching review UI', () => {
  it('shows original snapshots and keeps approval disabled until every image is available', async () => {
    const client = {
      list: vi.fn(async () => [record]),
      analyze: vi.fn(async () => []),
      review: vi.fn(async () => record),
    };
    render(
      <TeachingMemoryWorkspace
        client={client}
        selection={{ ids: [], course: '' }}
        onChange={vi.fn()}
      />,
    );
    const images = await screen.findAllByRole('img', { name: 'presentationTeaching.sourceImage' });
    expect(images).toHaveLength(2);
    const checkbox = screen.getByRole('checkbox', { name: 'presentationTeaching.acknowledge' });
    expect(checkbox).toBeDisabled();
    expect(screen.getByText('右侧颜色变化')).toBeInTheDocument();
    expect(images[0]).toHaveAttribute(
      'src',
      `/api/runtime/presentation/artifacts/${record.source.visualPages![0].ref}?raw=true`,
    );
    fireEvent.load(images[0]);
    expect(checkbox).toBeDisabled();
    fireEvent.error(images[1]);
    expect(screen.getByText('presentationTeaching.visualUnavailable')).toBeInTheDocument();
    expect(checkbox).toBeDisabled();
    fireEvent.load(images[1]);
    await waitFor(() => expect(checkbox).not.toBeDisabled());
    fireEvent.click(checkbox);
    const confirm = screen.getByRole('button', { name: 'presentationTeaching.confirm' });
    expect(confirm).not.toBeDisabled();
    fireEvent.error(images[1]);
    await waitFor(() => expect(confirm).toBeDisabled());
    expect(client.review).not.toHaveBeenCalled();
  });
  it('submits explicit non-adjacent page comparison and never sends image URLs from the client', async () => {
    const client = {
      list: vi.fn(async () => []),
      analyze: vi.fn(async () => []),
      review: vi.fn(async () => record),
    };
    render(
      <TeachingMemoryWorkspace
        client={client}
        selection={{ ids: [], course: '' }}
        template={{ templateId: 't', versionId: 'v' }}
        onChange={vi.fn()}
      />,
    );
    const mode = screen.getByRole('checkbox', { name: 'presentationTeaching.visualMode' });
    await waitFor(() => expect(mode).not.toBeDisabled());
    fireEvent.click(mode);
    const button = screen.getByRole('button', { name: /presentationTeaching.analyze/u });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText('presentationTeaching.pageList'), {
      target: { value: '36,37,49,56' },
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(client.analyze).toHaveBeenCalledWith({
        templateId: 't',
        versionId: 'v',
        visual: true,
        pages: [36, 37, 49, 56],
      }),
    );
  });
});
