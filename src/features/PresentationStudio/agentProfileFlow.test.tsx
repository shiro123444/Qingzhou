import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type {
  ArtifactSnapshot,
  PresentationJob,
} from '../../../packages/runtime-contracts/src/index';
import PresentationStudio from './PresentationStudio';

const t0 = '2026-08-30T10:00:00.000Z';

const completedJob = (artifactIds: string[]): PresentationJob => ({
  artifactIds,
  createdAt: t0,
  jobId: 'job-done',
  state: 'completed',
  updatedAt: t0,
});

const slide = (artifactId: string, n: number): ArtifactSnapshot => ({
  artifactId,
  createdAt: t0,
  metadata: { slideNumber: n },
  mimeType: 'image/svg+xml',
  name: `Slide ${n}.svg`,
  sizeBytes: 256,
  status: 'ready',
  type: 'svg',
  updatedAt: t0,
  uri: `data:image/svg+xml,sample-${n}`,
});

describe('PresentationStudio Full-Width Centered Agent Flow (A-1 / A-2 / A-3 / C-109 / C-111)', () => {
  it('renders single centered empty shell with typewriter title and walks through the creation flow', async () => {
    const createPresentationJob = vi.fn(async () => completedJob([]));
    const outlineSlides = Array.from({ length: 12 }, (_, index) => ({
      id: `slide-${index + 1}`,
      keyPoints: [`要点 ${index + 1}`],
      title: index === 0 ? '2026年企业数字化转型战略规划' : `战略章节 ${index + 1}`,
    }));
    const agentClient = {
      outline: vi.fn(async () => ({
        slides: outlineSlides,
      })),
      turn: vi.fn(async () => ({
        brief: {
          aspectRatio: '16:9' as const,
          audience: '商务汇报',
          language: 'zh-CN',
          slideCount: 12,
          style: '科技极简',
          topic: '2026年企业数字化转型战略规划',
        },
        message: '信息完整，开始生成大纲。',
        phase: 'outline' as const,
        slides: outlineSlides,
      })),
    };
    const client = {
      cancelPresentationJob: vi.fn(),
      createPresentationJob,
      exportArtifact: vi.fn(),
      getArtifact: vi.fn(async () => slide('slide-1', 1)),
      getPresentationJob: vi.fn(async () => null),
      retryPresentationJob: vi.fn(),
      subscribePresentationJob: vi.fn(),
    };

    render(
      <PresentationStudio
        agentClient={agentClient}
        client={client as never}
        initialTopic="2026年企业数字化转型战略规划"
        pollIntervalMs={50}
      />,
    );

    // 1. Verify Full-width Centered Empty Shell is rendered instead of a 3-column grid
    const emptyShell = screen.getByTestId('presentation-empty-shell');
    expect(emptyShell).toBeInTheDocument();

    const agentFlow = await screen.findByTestId('presentation-agent-flow');
    expect(agentFlow).toBeInTheDocument();
    expect(emptyShell).toContainElement(agentFlow);

    // Verify A-1: No PPT 创作专家 avatar/title
    expect(screen.queryByText('PPT 创作专家')).not.toBeInTheDocument();

    // The Cordis agent decides when the brief is complete and supplies the outline.
    await waitFor(() => {
      expect(screen.getByTestId('presentation-agent-outline')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('audience-options-group')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /确认大纲，继续生成/ }));

    // Verify createJob dispatch
    await waitFor(() => {
      expect(createPresentationJob).toHaveBeenCalledWith(
        expect.objectContaining({
          aspectRatio: '16:9',
          language: 'zh-CN',
          prompt: expect.stringContaining('2026年企业数字化转型战略规划'),
          slideCount: 12,
          title: '2026年企业数字化转型战略规划',
        }),
      );
    });
  }, 60000);

  it('renders completed PPT editor shell with real SVG canvas when selected job is completed', async () => {
    const client = {
      cancelPresentationJob: vi.fn(),
      createPresentationJob: vi.fn(),
      exportArtifact: vi.fn(),
      getArtifact: vi.fn(async (id: string) => (id === 's1' ? slide('s1', 1) : slide('s2', 2))),
      getPresentationJob: vi.fn(async (id: string) =>
        id === 'job-done' ? completedJob(['s1', 's2']) : null,
      ),
      retryPresentationJob: vi.fn(),
      subscribePresentationJob: vi.fn(),
    };

    render(
      <PresentationStudio
        client={client as never}
        initialJobIds={['job-done']}
        pollIntervalMs={50}
      />,
    );

    // Completed state renders toolbar, canvas, and side panels
    await waitFor(() => {
      expect(screen.getByTestId('presentation-editor-toolbar')).toBeInTheDocument();
    });

    expect(screen.getByTestId('presentation-completed-tag')).toHaveTextContent('已完成');
    expect(screen.getByRole('button', { name: /Continue prompting AI/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Quick export presentation/i })).toBeInTheDocument();
    expect(screen.getByTestId('slide-preview-image')).toBeInTheDocument();
    expect(screen.getByTestId('slide-navigator-grid')).toBeInTheDocument();
    expect(screen.queryByTestId('presentation-empty-shell')).not.toBeInTheDocument();
  }, 60000);
});
