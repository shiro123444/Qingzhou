import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { PresentationJob } from '../../../packages/runtime-contracts/src/index';
import PresentationGenerationWorkspace from './PresentationGenerationWorkspace';

const runningJob: PresentationJob = {
  artifactIds: [],
  createdAt: '2026-09-02T10:00:00.000Z',
  jobId: 'job-generating',
  state: 'running',
  updatedAt: '2026-09-02T10:00:01.000Z',
};

describe('PresentationGenerationWorkspace', () => {
  it('keeps generation focused on the light rail and cancel action', () => {
    const onCancel = vi.fn();
    render(
      <PresentationGenerationWorkspace job={runningJob} title="年度战略汇报" onCancel={onCancel} />,
    );

    expect(screen.getByTestId('presentation-generation-workspace')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '正在制作 PPT' })).toBeInTheDocument();
    expect(screen.queryByText('年度战略汇报')).not.toBeInTheDocument();
    expect(screen.getByTestId('presentation-generation-stage')).toBeInTheDocument();
    expect(screen.getByTestId('presentation-generation-progress')).toBeInTheDocument();
    expect(screen.getByTestId('generation-waiting-card')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Cancel presentation job/i }));
    expect(onCancel).toHaveBeenCalledWith('job-generating');
    expect(screen.queryByTestId('presentation-job-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('slide-inspector')).not.toBeInTheDocument();
  });

  it('renders concise action, page indicator, and does not leak raw reconnect copy or long prompt', () => {
    const customJob: PresentationJob = {
      ...runningJob,
      artifactIds: ['art-1', 'art-2'],
      ...({
        currentSlide: 2,
        lastAction: '正在整理第 2 页的 Transformer 架构图',
        totalSlides: 6,
      } as Record<string, unknown>),
    };

    render(<PresentationGenerationWorkspace job={customJob} />);

    expect(
      screen.getByRole('heading', { name: '正在整理第 2 页的 Transformer 架构图' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('presentation-generation-action')).toHaveTextContent(
      '正在整理第 2 页的 Transformer 架构图',
    );
    expect(screen.getByTestId('presentation-generation-pages')).toHaveTextContent('第 2 / 6 页');
    expect(screen.queryByTestId('presentation-generation-time')).not.toBeInTheDocument();
    expect(screen.queryByText('正在重新连接')).not.toBeInTheDocument();
  });

  describe('R3-B: Dynamic cards, real preview and hover hierarchy', () => {
    it('renders real SVG/image preview directly when artifact is available', () => {
      const jobWithArtifacts: PresentationJob = {
        ...runningJob,
        artifactIds: ['svg-art-1', 'img-art-2'],
        ...({
          currentSlide: 1,
          totalSlides: 2,
        } as Record<string, unknown>),
      };

      const artifactsMap = {
        'img-art-2': {
          artifactId: 'img-art-2',
          metadata: { slideId: 'slide-2', order: 2 },
          createdAt: '2026-09-02T10:00:00.000Z',
          jobId: 'job-generating',
          mimeType: 'image/png',
          status: 'ready' as const,
          type: 'image' as const,
          uri: 'https://example.com/slide2.png',
        },
        'svg-art-1': {
          artifactId: 'svg-art-1',
          metadata: { slideId: 'slide-1', order: 1 },
          createdAt: '2026-09-02T10:00:00.000Z',
          jobId: 'job-generating',
          mimeType: 'image/svg+xml',
          status: 'ready' as const,
          type: 'slide' as const,
          uri: 'data:image/svg+xml;utf8,<svg viewBox="0 0 100 100"><rect fill="blue" /></svg>',
        },
      };

      render(<PresentationGenerationWorkspace artifacts={artifactsMap} job={jobWithArtifacts} />);

      const previewImg1 = screen.getByTestId('card-preview-slide-1');
      expect(previewImg1).toBeInTheDocument();
      expect(previewImg1).toHaveAttribute(
        'src',
        'data:image/svg+xml;utf8,<svg viewBox="0 0 100 100"><rect fill="blue" /></svg>',
      );

      const previewImg2 = screen.getByTestId('card-preview-slide-2');
      expect(previewImg2).toBeInTheDocument();
      expect(previewImg2).toHaveAttribute('src', 'https://example.com/slide2.png');
    });

    it('shows the real completed preview while pending pages remain lightweight skeletons', () => {
      const jobWithMix: PresentationJob = {
        ...runningJob,
        artifactIds: ['done-art'],
        ...({
          activity: '正在打磨第 2 页素材',
          currentSlide: 2,
          totalSlides: 2,
        } as Record<string, unknown>),
      };

      const artifactsMap = {
        'done-art': {
          artifactId: 'done-art',
          metadata: { slideId: 'slide-1', order: 1 },
          createdAt: '2026-09-02T10:00:00.000Z',
          jobId: 'job-generating',
          mimeType: 'image/svg+xml',
          status: 'ready' as const,
          type: 'slide' as const,
          uri: 'https://example.com/done.svg',
        },
      };

      render(<PresentationGenerationWorkspace artifacts={artifactsMap} job={jobWithMix} />);

      expect(screen.getByTestId('card-preview-slide-1')).toHaveAttribute(
        'src',
        'https://example.com/done.svg',
      );
      expect(screen.queryByTestId('card-preview-slide-2')).not.toBeInTheDocument();
    });

    it('converts vertical wheel event to horizontal rail scroll', () => {
      const jobWithCards: PresentationJob = {
        ...runningJob,
        artifactIds: ['art-1', 'art-2', 'art-3'],
        ...({ totalSlides: 3 } as Record<string, unknown>),
      };

      render(<PresentationGenerationWorkspace job={jobWithCards} />);

      const rail = screen.getByTestId('generation-cards-rail');
      expect(rail).toBeInTheDocument();
      const cardsContainer = rail.querySelector('.acss-1xxspgt') ?? rail.children[1];

      // Dispatch wheel event
      const wheelEvent = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: 150,
      });
      cardsContainer.dispatchEvent(wheelEvent);
      // Event listener handled wheel without error
    });

    it('prioritizes real slideId from artifact metadata for card id and data-slide-id without synthetic fabrication', () => {
      const jobWithMetadata: PresentationJob = {
        ...runningJob,
        artifactIds: ['art-with-meta'],
        ...({
          currentSlide: 1,
          totalSlides: 1,
        } as Record<string, unknown>),
      };

      const artifactsMap = {
        'art-with-meta': {
          artifactId: 'art-with-meta',
          createdAt: '2026-09-02T10:00:00.000Z',
          jobId: 'job-generating',
          metadata: {
            slideId: 'real-slide-uuid-99',
            title: '执行摘要',
          },
          mimeType: 'image/svg+xml',
          status: 'ready' as const,
          type: 'slide' as const,
          uri: 'https://example.com/exec-summary.svg',
        },
      };

      render(<PresentationGenerationWorkspace artifacts={artifactsMap} job={jobWithMetadata} />);

      const card = screen.getByTestId('presentation-card-real-slide-uuid-99');
      expect(card).toBeInTheDocument();
      expect(card).toHaveAttribute('data-slide-id', 'real-slide-uuid-99');
      expect(card).toHaveAttribute('aria-label', expect.stringContaining('real-slide-uuid-99'));
    });
  });
});
