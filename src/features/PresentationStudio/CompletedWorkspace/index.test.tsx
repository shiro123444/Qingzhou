import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type {
  ArtifactSnapshot,
  PresentationJob,
} from '../../../../packages/runtime-contracts/src/index';
import type { PresentationSlotState } from '../store/presentationStore';
import CompletedWorkspace from './index';

const t0 = '2026-09-04T12:00:00.000Z';

const mockJob: PresentationJob = {
  artifactIds: ['slide-1', 'slide-2', 'slide-3'],
  createdAt: t0,
  jobId: 'job-done',
  state: 'completed',
  updatedAt: t0,
};

const mockSlides: ArtifactSnapshot[] = [
  {
    artifactId: 'slide-1',
    createdAt: t0,
    metadata: {
      notes: '欢迎大家参加本次关于人工智能在产品设计中应用的分享。',
      outline: ['引言与背景', '核心议题阐述', '预期产出目标'],
      slideId: 'slide-1',
      slideNumber: 1,
      title: 'AI 驱动的产品设计创新',
    },
    mimeType: 'image/svg+xml',
    name: 'Slide 1.svg',
    sizeBytes: 1024,
    status: 'ready',
    type: 'svg',
    updatedAt: t0,
    uri: 'data:image/svg+xml,mock-svg-1',
  },
  {
    artifactId: 'slide-2',
    createdAt: t0,
    metadata: {
      slideId: 'slide-2',
      slideNumber: 2,
      title: '市场趋势与技术洞察',
    },
    mimeType: 'image/svg+xml',
    name: 'Slide 2.svg',
    sizeBytes: 2048,
    status: 'ready',
    type: 'svg',
    updatedAt: t0,
    uri: 'data:image/svg+xml,mock-svg-2',
  },
  {
    artifactId: 'slide-3',
    createdAt: t0,
    metadata: {
      slideId: 'slide-3',
      slideNumber: 3,
      title: '未来落地与生态规划',
    },
    mimeType: 'image/svg+xml',
    name: 'Slide 3.svg',
    sizeBytes: 1536,
    status: 'ready',
    type: 'svg',
    updatedAt: t0,
    uri: 'data:image/svg+xml,mock-svg-3',
  },
];

const mockSlots: PresentationSlotState[] = [
  {
    artifactIds: ['art-chart-1'],
    errorCode: null,
    label: '市场增长图表',
    lastSeq: 1,
    slideId: 'slide-1',
    slotId: 'slot-1',
    status: 'ready',
  },
];

describe('CompletedWorkspace', () => {
  it('enters a borderless focused stage with back navigation and no AI composer', () => {
    const onSelectArtifact = vi.fn();
    const onExport = vi.fn();
    const onBack = vi.fn();

    render(
      <CompletedWorkspace
        canExport={true}
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-1"
        exporting={false}
        jobTitles={{ 'job-done': 'AI 演示文稿' }}
        resolveArtifactUri={() => 'https://example.com/asset.png'}
        retryPendingKeys={{}}
        retrySlot={vi.fn()}
        selectedJob={mockJob}
        selectedJobSlots={mockSlots}
        selectedSlide={mockSlides[0]}
        slideArtifacts={mockSlides}
        selectedJobArtifacts={[
          ...mockSlides,
          { ...mockSlides[0], artifactId: 'deck-pptx', type: 'pptx' },
        ]}
        onBack={onBack}
        onExport={onExport}
        onRetryJob={vi.fn()}
        onSelectArtifact={onSelectArtifact}
      />,
    );

    expect(screen.getByTestId('presentation-completed-workspace')).toHaveAttribute(
      'data-focused',
      'true',
    );
    expect(screen.getByTestId('presentation-editor-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('presentation-completed-tag')).toHaveTextContent('已完成');
    expect(screen.getByText('AI 演示文稿')).toBeInTheDocument();
    expect(screen.queryByText('商务科技')).not.toBeInTheDocument();
    expect(screen.queryByTestId('presentation-editor-ai')).not.toBeInTheDocument();
    expect(screen.queryByTestId('presentation-conversation')).not.toBeInTheDocument();
    const back = screen.getByTestId('presentation-back-to-home');
    expect(back).toHaveTextContent(/back|返回/i);
    expect(
      within(screen.getByTestId('presentation-editor-toolbar')).getAllByRole('button'),
    ).toHaveLength(3);
    expect(screen.getByTestId('presentation-editor-export')).toBeInTheDocument();
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledOnce();

    // Central 16:9 preview
    expect(screen.getByTestId('slide-preview-image')).toHaveAttribute(
      'src',
      'data:image/svg+xml,mock-svg-1',
    );

    // Bottom paginator: 01 / 03, previous disabled, next enabled
    expect(screen.getByTestId('slide-page-counter')).toHaveTextContent('01 / 03');
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled();

    // Editing the assistant chat and navigating the canvas have independent keys.
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(onSelectArtifact).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('slide-preview-image'));
    expect(screen.getByTestId('presentation-architecture-drawer')).toHaveAttribute(
      'data-open',
      'false',
    );
    fireEvent.keyDown(screen.getByTestId('spatial-canvas'), { key: 'ArrowRight' });
    expect(onSelectArtifact).toHaveBeenCalledWith('slide-2');
    onSelectArtifact.mockClear();

    // Navigate to next slide
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(onSelectArtifact).toHaveBeenCalledWith('slide-2');
  });

  it('starts full-window playback on the current page and returns to its camera and selection', async () => {
    const onSelectArtifact = vi.fn();
    render(
      <CompletedWorkspace
        canExport
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-2"
        exporting={false}
        jobTitles={{}}
        retryPendingKeys={{}}
        retrySlot={vi.fn()}
        selectedJob={mockJob}
        selectedJobArtifacts={mockSlides}
        selectedJobSlots={[]}
        selectedSlide={mockSlides[1]}
        slideArtifacts={mockSlides}
        onExport={vi.fn()}
        onRetryJob={vi.fn()}
        onSelectArtifact={onSelectArtifact}
      />,
    );
    const cameraScale = screen.getByTestId('spatial-canvas').dataset.scale;
    const present = screen.getByRole('button', {
      name: /presentationCanvas.present|Present slideshow|Play slideshow|放映幻灯片/i,
    });
    present.focus();
    fireEvent.click(present);
    const show = screen.getByTestId('deck-playback');
    expect(show).toHaveAttribute('aria-modal', 'true');
    expect(within(show).getByText('2 / 3')).toBeInTheDocument();
    expect(within(show).getByRole('img')).toHaveAttribute('src', mockSlides[1].uri);
    fireEvent.keyDown(show, { key: 'ArrowRight' });
    expect(within(show).getByText('3 / 3')).toBeInTheDocument();
    expect(
      within(show).getByRole('button', { name: /presentationCanvas.next|Next slide|下一页/i }),
    ).toBeDisabled();
    fireEvent.keyDown(show, { key: 'ArrowRight' });
    expect(within(show).getByText('3 / 3')).toBeInTheDocument();
    fireEvent.keyDown(show, { key: 'Home' });
    expect(
      within(show).getByRole('button', {
        name: /presentationCanvas.previous|Previous slide|上一页/i,
      }),
    ).toBeDisabled();
    fireEvent.keyDown(show, { key: 'Escape' });
    expect(screen.queryByTestId('deck-playback')).not.toBeInTheDocument();
    expect(screen.getByTestId('slide-page-counter')).toHaveTextContent('02 / 03');
    expect(screen.getByTestId('spatial-canvas').dataset.scale).toBe(cameraScale);
    expect(onSelectArtifact).not.toHaveBeenCalled();
    expect(present).toHaveFocus();
  });

  it('toggles Panorama Lightbox Mode with Bento grid and returns to Focus Mode on card click', async () => {
    const onSelectArtifact = vi.fn();

    render(
      <CompletedWorkspace
        canExport={true}
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-1"
        exporting={false}
        jobTitles={{ 'job-done': 'AI 演示文稿' }}
        retryPendingKeys={{}}
        retrySlot={vi.fn()}
        selectedJob={mockJob}
        selectedJobSlots={mockSlots}
        selectedSlide={mockSlides[0]}
        slideArtifacts={mockSlides}
        selectedJobArtifacts={[
          ...mockSlides,
          { ...mockSlides[0], artifactId: 'deck-pptx', type: 'pptx' },
        ]}
        onExport={vi.fn()}
        onRetryJob={vi.fn()}
        onSelectArtifact={onSelectArtifact}
      />,
    );

    // Toggle to Panorama Bento Grid
    fireEvent.click(screen.getByTestId('presentation-editor-more'));
    fireEvent.click(
      await screen.findByRole('menuitem', { name: /gridView|Slide overview|全景网格/i }),
    );
    expect(screen.getByTestId('presentation-bento-grid')).toBeInTheDocument();
    expect(screen.getByTestId('bento-card-slide-1')).toBeInTheDocument();
    expect(screen.getByTestId('bento-card-slide-2')).toBeInTheDocument();
    expect(screen.getByTestId('bento-card-slide-3')).toBeInTheDocument();

    // Click slide-2 card: should select slide-2 and switch back to Focus Mode
    fireEvent.click(screen.getByTestId('bento-card-slide-2'));
    expect(onSelectArtifact).toHaveBeenCalledWith('slide-2');
    expect(screen.queryByTestId('presentation-bento-grid')).not.toBeInTheDocument();
    expect(screen.getByTestId('slide-preview')).toBeInTheDocument();
  });

  it('opens Architecture and Assets drawer showing 3 sections strictly for current slide', async () => {
    render(
      <CompletedWorkspace
        canExport={true}
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-1"
        exporting={false}
        jobTitles={{ 'job-done': 'AI 演示文稿' }}
        resolveArtifactUri={() => 'https://example.com/asset.png'}
        retryPendingKeys={{}}
        retrySlot={vi.fn()}
        selectedJob={mockJob}
        selectedJobSlots={mockSlots}
        selectedSlide={mockSlides[0]}
        slideArtifacts={mockSlides}
        selectedJobArtifacts={[
          ...mockSlides,
          { ...mockSlides[0], artifactId: 'deck-pptx', type: 'pptx' },
        ]}
        onExport={vi.fn()}
        onRetryJob={vi.fn()}
        onSelectArtifact={vi.fn()}
      />,
    );

    const drawer = screen.getByTestId('presentation-architecture-drawer');
    expect(drawer).toHaveAttribute('data-open', 'false');

    // Click "架构与资产" button in header
    fireEvent.click(screen.getByTestId('presentation-editor-more'));
    fireEvent.click(
      await screen.findByRole('menuitem', {
        name: /assetsOpen|architecture and assets|查看架构与资产/i,
      }),
    );
    expect(drawer).toHaveAttribute('data-open', 'true');

    // 3 sections present
    expect(screen.getByTestId('drawer-outline-section')).toBeInTheDocument();
    expect(screen.getByTestId('drawer-assets-section')).toBeInTheDocument();
    expect(screen.getByTestId('drawer-notes-section')).toBeInTheDocument();

    // Outline content for slide 1
    expect(screen.getByText('引言与背景')).toBeInTheDocument();

    // Assets content for slide 1
    expect(screen.getAllByText('市场增长图表').length).toBeGreaterThanOrEqual(1);

    // Speaker notes content for slide 1
    expect(screen.getByText(/欢迎大家参加本次关于人工智能/)).toBeInTheDocument();

    const strip = screen.getByRole('button', { name: '展开胶卷' });
    fireEvent.click(strip);
    expect(drawer).toHaveAttribute('data-open', 'true');
    // Closing the drawer must not close the strip or strand focus in the hidden drawer.
    fireEvent.click(screen.getByRole('button', { name: '关闭抽屉' }));
    expect(strip).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('presentation-editor-more')).toHaveFocus();
    expect(drawer).toHaveAttribute('data-open', 'false');
  });

  it('triggers quick export for PPTX format', () => {
    const onExport = vi.fn();

    render(
      <CompletedWorkspace
        canExport={true}
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-1"
        exporting={false}
        jobTitles={{ 'job-done': 'AI 演示文稿' }}
        retryPendingKeys={{}}
        retrySlot={vi.fn()}
        selectedJob={mockJob}
        selectedJobSlots={mockSlots}
        selectedSlide={mockSlides[0]}
        slideArtifacts={mockSlides}
        selectedJobArtifacts={[
          ...mockSlides,
          { ...mockSlides[0], artifactId: 'deck-pptx', type: 'pptx' },
        ]}
        onExport={onExport}
        onRetryJob={vi.fn()}
        onSelectArtifact={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('presentation-editor-export'));
    expect(onExport).toHaveBeenCalledWith('deck-pptx', 'pptx');
  });

  it('supports toggling the collapsible slide filmstrip', () => {
    render(
      <CompletedWorkspace
        canExport={true}
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-1"
        exporting={false}
        jobTitles={{ 'job-done': 'AI 演示文稿' }}
        retryPendingKeys={{}}
        retrySlot={vi.fn()}
        selectedJob={mockJob}
        selectedJobSlots={mockSlots}
        selectedSlide={mockSlides[0]}
        slideArtifacts={mockSlides}
        selectedJobArtifacts={[
          ...mockSlides,
          { ...mockSlides[0], artifactId: 'deck-pptx', type: 'pptx' },
        ]}
        onExport={vi.fn()}
        onRetryJob={vi.fn()}
        onSelectArtifact={vi.fn()}
      />,
    );

    const toggleBtn = screen.getByRole('button', { name: '展开胶卷' });
    expect(toggleBtn).toBeInTheDocument();

    fireEvent.click(toggleBtn);
    expect(screen.getByRole('button', { name: '收起胶卷' })).toBeInTheDocument();
    expect(screen.queryByText('缩略胶卷')).not.toBeInTheDocument();
    expect(screen.queryByText('幻灯片列表')).not.toBeInTheDocument();
    expect(screen.getByTestId('slide-navigator')).toHaveAttribute('data-compact', 'true');
    expect(screen.getByTestId('slide-navigator-item-slide-1')).toHaveTextContent('01');
    expect(screen.getByTestId('slide-navigator-item-slide-1')).not.toHaveTextContent('ready');
  });

  it('keeps direct canvas annotation without rendering a general AI composer', () => {
    const onSend = vi.fn(async () => true);

    render(
      <CompletedWorkspace
        canExport={true}
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-1"
        exporting={false}
        jobTitles={{ 'job-done': 'AI 演示文稿' }}
        retryPendingKeys={{}}
        retrySlot={vi.fn()}
        selectedJob={{ ...mockJob, versionId: 'v1' }}
        selectedJobArtifacts={mockSlides}
        selectedJobSlots={mockSlots}
        selectedSlide={mockSlides[0]}
        slideArtifacts={mockSlides}
        onExport={vi.fn()}
        onRetryJob={vi.fn()}
        onSelectArtifact={vi.fn()}
        onSendMessage={onSend}
      />,
    );

    expect(screen.getByTestId('slide-command-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('presentation-editor-ai')).not.toBeInTheDocument();
    expect(screen.queryByTestId('presentation-conversation')).not.toBeInTheDocument();
    expect(screen.queryByTestId('presentation-conversation-input')).not.toBeInTheDocument();
    const readPage = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 404 }));
    try {
      fireEvent.click(
        screen.getByRole('button', { name: /Annotate slide|presentationCanvas.annotate|标注修改/ }),
      );
      const dock = screen.getByTestId('annotation-dock');
      expect(screen.getByTestId('spatial-canvas')).not.toContainElement(dock);
      fireEvent.click(
        within(dock).getByRole('button', {
          name: /presentationAnnotation.cancel|退出标注|Exit annotation/i,
        }),
      );
      expect(onSend).not.toHaveBeenCalled();
    } finally {
      readPage.mockRestore();
    }
  });

  it('keeps retained previews readable with a generation status while regeneration is running', async () => {
    render(
      <CompletedWorkspace
        activity="第 1 页 · 第 1 张素材 · 正在处理素材的透明背景"
        canExport={true}
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-1"
        exporting={false}
        jobTitles={{ 'job-done': 'AI 演示文稿' }}
        resolveArtifactUri={() => 'https://example.com/asset.png'}
        retryPendingKeys={{}}
        retrySlot={vi.fn()}
        selectedJob={{ ...mockJob, state: 'running' }}
        selectedJobSlots={[{ ...mockSlots[0], status: 'generating', artifactIds: ['art-chart-1'] }]}
        selectedSlide={mockSlides[0]}
        slideArtifacts={mockSlides}
        activityHistory={[
          { id: 'draw', text: '第 1 页 · 第 1 张素材 · 绘画已完成' },
          { id: 'cutout', text: '第 1 页 · 第 1 张素材 · 正在处理素材的透明背景' },
        ]}
        selectedJobArtifacts={[
          ...mockSlides,
          { ...mockSlides[0], artifactId: 'deck-pptx', type: 'pptx' },
        ]}
        onExport={vi.fn()}
        onRetryJob={vi.fn()}
        onSelectArtifact={vi.fn()}
      />,
    );

    expect(screen.getByTestId('slide-generation-overlay')).toBeInTheDocument();
    expect(screen.queryByTestId('paint-brush')).not.toBeInTheDocument();
    expect(screen.getByTestId('slide-preview-image')).toHaveAttribute('src', mockSlides[0].uri);
    expect(screen.getByTestId('slide-preview')).toHaveTextContent('正在更新');
    expect(screen.getByLabelText(/第 1 页/)).toHaveAttribute('data-painting', 'true');
    expect(screen.getByTestId('presentation-completed-tag')).toHaveTextContent(
      '第 1 页 · 第 1 张素材 · 正在处理素材的透明背景',
    );

    fireEvent.click(screen.getByTestId('presentation-editor-more'));
    fireEvent.click(
      await screen.findByRole('menuitem', { name: /activityHistory|activity history|活动记录/i }),
    );
    expect(screen.getByTestId('presentation-activity-history')).toHaveTextContent(
      '第 1 页 · 第 1 张素材 · 绘画已完成',
    );
    expect(screen.getByTestId('presentation-activity-history')).toHaveTextContent(
      '第 1 页 · 第 1 张素材 · 正在处理素材的透明背景',
    );

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /close/i }));
    fireEvent.click(screen.getByTestId('presentation-editor-more'));
    fireEvent.click(
      await screen.findByRole('menuitem', { name: /gridView|Slide overview|全景网格/i }),
    );
    expect(screen.getAllByTestId('slide-generation-overlay')).toHaveLength(mockSlides.length);
  });

  it('preserves an interrupted status and readable previews across page navigation', () => {
    const interruptedJob: PresentationJob = {
      ...mockJob,
      error: { code: 'IMAGE_UNAVAILABLE', message: 'Image provider failed' },
      messages: [
        {
          content: '继续优化整套页面',
          createdAt: t0,
          error: 'Image provider failed',
          requestId: 'edit-1',
          status: 'failed',
          target: { type: 'deck' },
        },
      ],
      state: 'failed',
    };
    const props = {
      canExport: true,
      dismissSlotError: vi.fn(),
      effectiveSelectedArtifactId: 'slide-1',
      exported: null,
      exporting: false,
      jobTitles: { 'job-done': 'AI 演示文稿' },
      onExport: vi.fn(),
      onRetryJob: vi.fn(),
      onSelectArtifact: vi.fn(),
      retryPendingKeys: {},
      retrySlot: vi.fn(),
      selectedJob: interruptedJob,
      selectedJobArtifacts: mockSlides,
      selectedJobSlots: [],
      slideArtifacts: mockSlides,
    };
    const { rerender } = render(<CompletedWorkspace {...props} selectedSlide={mockSlides[0]} />);

    expect(screen.getByTestId('slide-generation-overlay')).toHaveTextContent('已保留，等待继续');
    expect(screen.getByTestId('slide-generation-overlay')).toHaveAttribute(
      'data-state',
      'interrupted',
    );
    expect(within(screen.getByTestId('slide-generation-overlay')).queryByRole('img')).toBeNull();

    rerender(
      <CompletedWorkspace
        {...props}
        effectiveSelectedArtifactId="slide-2"
        selectedSlide={mockSlides[1]}
      />,
    );
    expect(screen.getByTestId('slide-generation-overlay')).toHaveTextContent('已保留，等待继续');
    expect(screen.getByTestId('slide-generation-overlay')).toHaveAttribute(
      'data-state',
      'interrupted',
    );
    expect(screen.getByTestId('slide-preview-image')).toHaveAttribute(
      'src',
      'data:image/svg+xml,mock-svg-2',
    );
  });

  it('shows a complete Chinese status for IMAGE_PLAN_INVALID instead of truncated English', () => {
    render(
      <CompletedWorkspace
        canExport={true}
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-1"
        exporting={false}
        jobTitles={{ 'job-done': 'AI 演示文稿' }}
        retryPendingKeys={{}}
        retrySlot={vi.fn()}
        selectedJobSlots={mockSlots}
        selectedSlide={mockSlides[0]}
        slideArtifacts={mockSlides}
        selectedJob={{
          ...mockJob,
          error: {
            code: 'IMAGE_PLAN_INVALID',
            message: 'Asset intent analysis returned invalid JSON',
          },
          state: 'failed',
        }}
        selectedJobArtifacts={[
          ...mockSlides,
          { ...mockSlides[0], artifactId: 'deck-pptx', type: 'pptx' },
        ]}
        onExport={vi.fn()}
        onRetryJob={vi.fn()}
        onSelectArtifact={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('slide-generation-overlay')).not.toBeInTheDocument();
    expect(screen.getByTestId('presentation-completed-tag')).toHaveTextContent(
      '素材规划未完成，请再试一次',
    );
    expect(screen.getByTestId('presentation-completed-tag')).not.toHaveTextContent('invalid J');
  });

  it('shows a complete Chinese status for an empty planner response', () => {
    render(
      <CompletedWorkspace
        canExport={true}
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-1"
        exporting={false}
        jobTitles={{ 'job-done': 'AI 演示文稿' }}
        retryPendingKeys={{}}
        retrySlot={vi.fn()}
        selectedJobSlots={mockSlots}
        selectedSlide={mockSlides[0]}
        slideArtifacts={mockSlides}
        selectedJob={{
          ...mockJob,
          error: {
            code: 'PRESENTATION_INTERNAL_ERROR',
            message: 'Multimodal planner returned empty response',
          },
          state: 'failed',
        }}
        selectedJobArtifacts={[
          ...mockSlides,
          { ...mockSlides[0], artifactId: 'deck-pptx', type: 'pptx' },
        ]}
        onExport={vi.fn()}
        onRetryJob={vi.fn()}
        onSelectArtifact={vi.fn()}
      />,
    );

    expect(screen.getByTestId('presentation-completed-tag')).toHaveTextContent(
      '排版未完成，请再试一次',
    );
    expect(screen.getByTestId('presentation-completed-tag')).not.toHaveTextContent('empty respon');
  });
});
