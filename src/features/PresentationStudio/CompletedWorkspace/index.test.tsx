import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  it('enters Slide Focus Mode by default with 16:9 preview and bottom paginator', () => {
    const onSelectArtifact = vi.fn();
    const onExport = vi.fn();

    render(
      <CompletedWorkspace
        canExport={true}
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-1"
        exported={null}
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
        onExport={onExport}
        onRetryJob={vi.fn()}
        onSelectArtifact={onSelectArtifact}
      />,
    );

    // Top capsule floating bar
    expect(screen.getByTestId('presentation-editor-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('presentation-completed-tag')).toHaveTextContent('已完成');
    expect(screen.getByText('AI 演示文稿')).toBeInTheDocument();
    expect(screen.queryByText('商务科技')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue prompting AI' })).toHaveTextContent('');
    expect(screen.getByRole('button', { name: '全景网格' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Quick export presentation/i })).toBeInTheDocument();

    // Central 16:9 preview
    expect(screen.getByTestId('slide-preview-image')).toHaveAttribute(
      'src',
      'data:image/svg+xml,mock-svg-1',
    );

    // Bottom paginator: 01 / 03, previous disabled, next enabled
    expect(screen.getByTestId('slide-page-counter')).toHaveTextContent('01 / 03');
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled();

    // Navigate to next slide
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(onSelectArtifact).toHaveBeenCalledWith('slide-2');
  });

  it('toggles Panorama Lightbox Mode with Bento grid and returns to Focus Mode on card click', () => {
    const onSelectArtifact = vi.fn();

    render(
      <CompletedWorkspace
        canExport={true}
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-1"
        exported={null}
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
    fireEvent.click(screen.getByRole('button', { name: '全景网格' }));
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

  it('opens Architecture and Assets drawer showing 3 sections strictly for current slide', () => {
    render(
      <CompletedWorkspace
        canExport={true}
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-1"
        exported={null}
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
    fireEvent.click(screen.getByRole('button', { name: '查看架构与资产' }));
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

    // Close drawer
    fireEvent.click(screen.getByRole('button', { name: '关闭抽屉' }));
    expect(drawer).toHaveAttribute('data-open', 'false');
  });

  it('triggers quick export for PPTX format', () => {
    const onExport = vi.fn();

    render(
      <CompletedWorkspace
        canExport={true}
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-1"
        exported={null}
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

    fireEvent.click(screen.getByRole('button', { name: /Quick export presentation/i }));
    expect(onExport).toHaveBeenCalledWith('deck-pptx', 'pptx');
  });

  it('supports toggling the collapsible slide filmstrip', () => {
    render(
      <CompletedWorkspace
        canExport={true}
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-1"
        exported={null}
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

  it('opens a single in-flow composer from the header and the stage command bar', async () => {
    const onSend = vi.fn(async () => true);

    render(
      <CompletedWorkspace
        canExport={true}
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-1"
        exported={null}
        exporting={false}
        jobTitles={{ 'job-done': 'AI 演示文稿' }}
        retryPendingKeys={{}}
        retrySlot={vi.fn()}
        selectedJob={{ ...mockJob, versionId: 'v1' }}
        selectedJobSlots={mockSlots}
        selectedSlide={mockSlides[0]}
        slideArtifacts={mockSlides}
        selectedJobArtifacts={[
          ...mockSlides,
          { ...mockSlides[0], artifactId: 'deck-pptx', type: 'pptx' },
        ]}
        onCancel={vi.fn(async () => undefined)}
        onExport={vi.fn()}
        onRetryJob={vi.fn()}
        onSelectArtifact={vi.fn()}
        onSendMessage={onSend}
      />,
    );

    expect(screen.getByTestId('slide-command-bar')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '标注修改' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上一页' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '下一页' })).toBeEnabled();
    expect(screen.queryByTestId('presentation-conversation')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Continue prompting AI' }));
    expect(screen.getByTestId('presentation-conversation')).toHaveAttribute('data-open', 'true');
    expect(screen.getAllByTestId('presentation-conversation-input')).toHaveLength(1);

    fireEvent.click(screen.getByTestId('presentation-conversation-trigger'));
    expect(screen.queryByTestId('presentation-conversation')).not.toBeInTheDocument();
    expect(screen.queryByTestId('presentation-conversation-input')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('presentation-conversation-trigger'));
    expect(screen.getByTestId('presentation-conversation')).toHaveAttribute('data-open', 'true');
    expect(screen.getAllByTestId('presentation-conversation-input')).toHaveLength(1);

    fireEvent.change(screen.getByTestId('presentation-conversation-input'), {
      target: { value: '把第二页配色改成科技蓝' },
    });
    fireEvent.click(screen.getByTestId('presentation-conversation-send'));
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith(
        'job-done',
        expect.objectContaining({ content: '把第二页配色改成科技蓝' }),
      );
    });

    fireEvent.click(screen.getByTestId('presentation-conversation-collapse'));
    expect(screen.queryByTestId('presentation-conversation')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue prompting AI' }));
    fireEvent.change(screen.getByTestId('presentation-conversation-input'), {
      target: { value: '再改一次标题' },
    });
    fireEvent.click(screen.getByTestId('presentation-conversation-send'));
    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith(
        'job-done',
        expect.objectContaining({ content: '再改一次标题' }),
      );
    });
  });

  it('frosts retained slides with a live paint overlay while regeneration is running', () => {
    render(
      <CompletedWorkspace
        activity="第 1 页 · 第 1 张素材 · 正在处理素材的透明背景"
        canExport={true}
        dismissSlotError={vi.fn()}
        effectiveSelectedArtifactId="slide-1"
        exported={null}
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

    expect(screen.getByTestId('slide-paint-overlay')).toBeInTheDocument();
    expect(screen.getByTestId('slide-preview')).toHaveTextContent('正在绘制');
    expect(screen.getByLabelText(/第 1 页/)).toHaveAttribute('data-painting', 'true');
    expect(screen.getByTestId('presentation-completed-tag')).toHaveTextContent(
      '第 1 页 · 第 1 张素材 · 正在处理素材的透明背景',
    );

    fireEvent.click(screen.getByTestId('presentation-completed-tag'));
    expect(screen.getByTestId('presentation-activity-history')).toHaveTextContent(
      '第 1 页 · 第 1 张素材 · 绘画已完成',
    );
    expect(screen.getByTestId('presentation-activity-history')).toHaveTextContent(
      '第 1 页 · 第 1 张素材 · 正在处理素材的透明背景',
    );

    fireEvent.click(screen.getByRole('button', { name: '全景网格' }));
    expect(screen.getAllByTestId('slide-paint-overlay')).toHaveLength(mockSlides.length);
  });

  it('keeps the unfinished edit masked after an asset failure and across page navigation', () => {
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

    expect(screen.getByTestId('slide-paint-overlay')).toHaveTextContent('已保留，等待续绘');
    expect(within(screen.getByTestId('slide-paint-overlay')).queryByRole('img')).toBeNull();

    rerender(
      <CompletedWorkspace
        {...props}
        effectiveSelectedArtifactId="slide-2"
        selectedSlide={mockSlides[1]}
      />,
    );
    expect(screen.getByTestId('slide-paint-overlay')).toHaveTextContent('已保留，等待续绘');
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
        exported={null}
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

    expect(screen.queryByTestId('slide-paint-overlay')).not.toBeInTheDocument();
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
        exported={null}
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
