import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ArtifactSnapshot } from '../../../../packages/runtime-contracts/src/index';
import ArchitectureDrawer, { type ArchitectureDrawerProps } from './ArchitectureDrawer';

const timestamp = '2026-09-12T00:00:00.000Z';
const image = (
  artifactId: string,
  overrides: Partial<ArtifactSnapshot> = {},
): ArtifactSnapshot => ({
  artifactId,
  createdAt: timestamp,
  mimeType: 'image/png',
  name: `${artifactId}.png`,
  status: 'ready',
  type: 'image',
  uri: 'file:///must-not-use-artifact-uri-directly',
  ...overrides,
});
const slide = (page: number, refs: unknown[]): ArtifactSnapshot => ({
  artifactId: `slide-artifact-${page}`,
  createdAt: timestamp,
  metadata: { generatedAssetRefs: refs, slideId: `slide-${page}`, slideNumber: page },
  mimeType: 'image/svg+xml',
  status: 'ready',
  type: 'svg',
});
const props = (overrides: Partial<ArchitectureDrawerProps> = {}): ArchitectureDrawerProps => ({
  currentIndex: 1,
  dismissSlotError: vi.fn(),
  jobId: 'job',
  jobState: 'completed',
  onClose: vi.fn(),
  onExport: vi.fn(),
  onSelectArtifact: vi.fn(),
  open: true,
  retryPendingKeys: {},
  retrySlot: vi.fn(async () => {}),
  selectedArtifactId: 'slide-artifact-2',
  selectedJobArtifacts: [],
  selectedJobSlots: [],
  selectedSlide: slide(2, []),
  showInspector: false,
  ...overrides,
});

describe('ArchitectureDrawer generated page assets', () => {
  it('explains the current page visual decision and clears it when selecting an older page', () => {
    const selected = slide(2, []);
    selected.metadata = {
      ...selected.metadata,
      autonomousVisualDecision: {
        strategy: 'mixed',
        reason: '原创场景帮助解释双导师协作，事实表格保持可编辑',
        composition: '表格占左侧，插画按主体比例置右侧',
      },
      illustrationStyle: '统一水墨肌理与主色',
    };
    const view = render(<ArchitectureDrawer {...props({ selectedSlide: selected })} />);
    const section = within(screen.getByTestId('drawer-visual-decision-section'));
    expect(section.getByText('原创场景帮助解释双导师协作，事实表格保持可编辑')).toBeInTheDocument();
    expect(section.getByText('表格占左侧，插画按主体比例置右侧')).toBeInTheDocument();
    expect(section.getByText(/统一水墨肌理与主色/)).toBeInTheDocument();
    view.rerender(
      <ArchitectureDrawer {...props({ currentIndex: 2, selectedSlide: slide(3, []) })} />,
    );
    expect(screen.queryByTestId('drawer-visual-decision-section')).not.toBeInTheDocument();
  });
  it('shows only ready images referenced by the current page and present in its scoped job artifacts', () => {
    const resolveArtifactUri = vi.fn(
      (id: string) => `/api/runtime/presentation/artifacts/${id}?raw=true`,
    );
    const onSelectArtifact = vi.fn();
    const retrySlot = vi.fn(async () => {});
    const shared = props({
      onSelectArtifact,
      resolveArtifactUri,
      retrySlot,
      selectedJobArtifacts: [
        image('image-product'),
        image('image-other-page'),
        image('image-failed', { status: 'failed' }),
        image('fake-deck', { mimeType: 'application/pdf', type: 'pdf' }),
      ],
      selectedSlide: slide(2, [
        'image-product',
        'image-product',
        'image-missing',
        'image-failed',
        'fake-deck',
        { ref: 'forged-ref' },
      ]),
    });
    const { rerender } = render(<ArchitectureDrawer {...shared} />);
    const section = within(screen.getByTestId('drawer-assets-section'));
    expect(section.getAllByRole('img', { name: '配图' })).toHaveLength(1);
    expect(section.getByRole('img', { name: '配图' })).toHaveAttribute(
      'src',
      '/api/runtime/presentation/artifacts/image-product?raw=true',
    );
    expect(section.queryByText('当前页暂无素材插图槽位')).not.toBeInTheDocument();
    expect(section.queryByText(/image-product/)).not.toBeInTheDocument();
    expect(section.queryByTestId('drawer-image-image-other-page')).not.toBeInTheDocument();
    expect(section.queryByTestId('drawer-image-image-missing')).not.toBeInTheDocument();
    expect(section.queryByTestId('drawer-image-image-failed')).not.toBeInTheDocument();
    expect(section.queryByRole('button', { name: /重新生成/ })).not.toBeInTheDocument();
    fireEvent.click(section.getByRole('img', { name: '配图' }));
    expect(onSelectArtifact).not.toHaveBeenCalled();
    expect(retrySlot).not.toHaveBeenCalled();
    expect(resolveArtifactUri).not.toHaveBeenCalledWith('image-missing');

    rerender(
      <ArchitectureDrawer
        {...shared}
        currentIndex={2}
        selectedSlide={slide(3, ['image-other-page'])}
      />,
    );
    expect(section.queryByTestId('drawer-image-image-product')).not.toBeInTheDocument();
    expect(section.getByRole('img', { name: '配图' })).toHaveAttribute(
      'src',
      '/api/runtime/presentation/artifacts/image-other-page?raw=true',
    );
    expect(section.getByRole('group', { name: '第 3 页配图' })).toBeInTheDocument();
  });

  it('does not turn missing refs into images or fall back to raw artifact URIs', () => {
    const shared = props({
      selectedJobArtifacts: [image('image-owned')],
      selectedSlide: slide(2, ['image-missing']),
    });
    const { rerender } = render(<ArchitectureDrawer {...shared} />);
    const section = within(screen.getByTestId('drawer-assets-section'));
    expect(section.getByText('当前页暂无素材插图槽位')).toBeInTheDocument();
    expect(section.queryByRole('img', { name: '配图' })).not.toBeInTheDocument();

    rerender(
      <ArchitectureDrawer
        {...shared}
        resolveArtifactUri={() => 'javascript:alert(1)'}
        selectedSlide={slide(2, ['image-owned'])}
      />,
    );
    expect(section.getByRole('group', { name: '第 2 页配图' })).toBeInTheDocument();
    expect(section.queryByRole('img', { name: '配图' })).not.toBeInTheDocument();
    expect(section.queryByText('当前页暂无素材插图槽位')).not.toBeInTheDocument();
  });

  it('does not duplicate an image already represented by a ready current-page slot', () => {
    render(
      <ArchitectureDrawer
        {...props({
          resolveArtifactUri: () => 'https://example.test/image.png',
          selectedJobArtifacts: [image('image-owned')],
          selectedJobSlots: [
            {
              artifactIds: ['image-owned'],
              errorCode: null,
              label: '产品照片',
              lastSeq: 1,
              slideId: 'slide-2',
              slotId: 'hero',
              status: 'ready',
            },
          ],
          selectedSlide: slide(2, ['image-owned']),
        })}
      />,
    );
    const section = within(screen.getByTestId('drawer-assets-section'));
    expect(section.getAllByRole('img', { name: '产品照片' })).toHaveLength(1);
    expect(section.getByTestId('drawer-slot-slide-2-hero')).toBeInTheDocument();
    expect(section.queryByTestId('drawer-image-image-owned')).not.toBeInTheDocument();
    expect(section.queryByRole('button', { name: /重新生成/ })).not.toBeInTheDocument();
  });
});
