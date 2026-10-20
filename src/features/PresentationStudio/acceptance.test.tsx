import { readFileSync } from 'node:fs';
import path from 'node:path';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ArtifactSnapshot,
  PresentationJob,
  PresentationJobInput,
} from '../../../packages/runtime-contracts/src/index';
import type {
  CreateImageGenerationInput,
  PresentationJobEvent,
} from '../../services/runtime/client';
import { createPresentationDemoClient } from './demo/presentationDemoClient';
import PresentationStudio from './PresentationStudio';
import type { PresentationStreamClient } from './store/presentationStore';

const readStyleSource = (relative: string): string =>
  readFileSync(path.join(process.cwd(), relative), 'utf8');

const FIXTURE = 'src/features/PresentationStudio';

// Intake conversation has its own suite; these cases exercise the job lifecycle.
vi.mock('./AgentFlow', () => ({ default: () => null }));

// C-112 persists the active job and stream cursor in sessionStorage so a
// route re-entry can resume work. Keep acceptance cases isolated from one
// another; each case owns its persistence scenario explicitly.
beforeEach(() => {
  window.sessionStorage.clear();
});

describe('PresentationStudio acceptance (C-58 phase 1)', () => {
  it('renders the responsive empty state with an honest demo transport badge', async () => {
    const client = createPresentationDemoClient();
    render(<PresentationStudio client={client} transportMode="demo" />);

    expect(screen.getByTestId('presentation-studio')).toBeInTheDocument();
    expect(await screen.findByTestId('studio-empty-state')).toBeInTheDocument();
    expect(screen.getByTestId('presentation-demo-badge')).toHaveTextContent(
      'Demo data — fake transport',
    );
    expect(screen.getByTestId('presentation-composer')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Focus the presentation creator/i }),
    ).toBeInTheDocument();
  }, 15000);

  it('shows an honest HTTP badge when using the real transport seam', () => {
    // No client → the default HTTP RuntimeClient seam serves as transport.
    render(<PresentationStudio transportMode="http" />);

    expect(screen.getByTestId('presentation-transport-badge')).toHaveTextContent(
      'Runtime HTTP transport',
    );
  });

  it('wires demo mode explicitly: no client + transportMode=demo runs the demo flow with the demo badge', async () => {
    // The default demo transport drives interactive timings (1.2s queued + 2.4s running).
    render(<PresentationStudio pollIntervalMs={50} transportMode="demo" />);

    expect(screen.getByTestId('presentation-demo-badge')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Presentation title'), {
      target: { value: 'Explicit demo deck' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));

    await waitFor(
      () => {
        expect(screen.getByTestId('presentation-completed-tag')).toHaveTextContent('已完成');
      },
      { timeout: 8000 },
    );

    fireEvent.click(screen.getByRole('button', { name: /Export presentation artifact/i }));
    const menuItem = await screen.findByText('Export 矢量切片 (.svg)');
    fireEvent.click(menuItem.closest('li') ?? menuItem);

    await waitFor(() => {
      expect(screen.getByTestId('presentation-export-notice')).toBeInTheDocument();
    });
  }, 20000);

  it('shows the loading state while restoring persisted jobs, then resolves', async () => {
    const client = createPresentationDemoClient({ queuedMs: 120, runningMs: 120 });
    render(
      <PresentationStudio
        client={client}
        initialJobIds={['demo-restored']}
        pollIntervalMs={50}
        transportMode="demo"
      />,
    );

    // demo client returns null for unknown ids → loading completes honestly
    expect(screen.getByTestId('studio-loading')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.queryByTestId('studio-loading')).not.toBeInTheDocument();
      expect(screen.getByTestId('studio-empty-state')).toBeInTheDocument();
    });
  }, 15000);

  // The closed loop performs several real-timer waitFor stages (demo timings +
  // export menu interactions); the harness default 5s budget is too tight when
  // the whole suite runs under host load, so an explicit timeout is set.
  it('runs the create → queued → running → completed → preview → export closed loop', async () => {
    let demoTime = Date.now();
    const client = createPresentationDemoClient({
      now: () => demoTime,
      queuedMs: 150,
      runningMs: 150,
    });
    render(<PresentationStudio client={client} pollIntervalMs={50} transportMode="demo" />);

    fireEvent.change(screen.getByLabelText('Presentation title'), {
      target: { value: 'Q3 Report' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));

    // queued
    await waitFor(() => {
      expect(screen.getByTestId('presentation-generation-workspace')).toBeInTheDocument();
    });

    demoTime += 150;
    await waitFor(() => {
      expect(screen.getByTestId('presentation-conversation')).toBeInTheDocument();
    });

    // completed + artifacts discovered via polling
    demoTime += 150;
    await waitFor(
      () => {
        expect(screen.getByTestId('presentation-completed-tag')).toHaveTextContent('已完成');
      },
      { timeout: 8000 },
    );
    await waitFor(
      () => {
        expect(screen.getByTestId('presentation-completed-workspace')).toBeInTheDocument();
        expect(screen.getAllByRole('img').length).toBeGreaterThanOrEqual(3);
      },
      { timeout: 8000 },
    );

    expect(screen.getByTestId('slide-preview-image')).toHaveAttribute(
      'src',
      expect.stringContaining('data:image/svg+xml'),
    );

    // export is enabled for a completed job with a ready artifact
    fireEvent.click(screen.getByRole('button', { name: /Export presentation artifact/i }));
    const menuItem = await screen.findByText('Export 矢量切片 (.svg)');
    fireEvent.click(menuItem.closest('li') ?? menuItem);

    await waitFor(() => {
      expect(screen.getByTestId('presentation-export-notice')).toBeInTheDocument();
      expect(screen.getByTestId('presentation-export-download')).toHaveAttribute('download');
    });
  }, 15000);

  it('supports cancel while running and keeps exports unavailable after cancel', async () => {
    const client = createPresentationDemoClient({ queuedMs: 120, runningMs: 60000 });
    render(<PresentationStudio client={client} pollIntervalMs={50} transportMode="demo" />);

    fireEvent.change(screen.getByLabelText('Presentation title'), {
      target: { value: 'Long deck' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));

    await waitFor(
      () => {
        expect(
          screen.getByRole('button', { name: /Cancel presentation job/i }),
        ).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    fireEvent.click(screen.getByRole('button', { name: /Cancel presentation job/i }));

    await waitFor(() => {
      expect(screen.getByTestId('presentation-recovery-workspace')).toHaveAttribute(
        'data-state',
        'cancelled',
      );
    });
    expect(screen.getByRole('button', { name: /Retry presentation job/i })).toBeInTheDocument();
    // No artifacts for a cancelled job → export surface stays empty/disabled
    expect(
      screen.queryByRole('button', { name: /Export presentation artifact/i }),
    ).not.toBeInTheDocument();
  }, 15000);

  it('shows interrupted creation and retry without the legacy diagnostic panels', async () => {
    const client = createPresentationDemoClient({ fail: true, queuedMs: 90, runningMs: 90 });
    render(<PresentationStudio client={client} pollIntervalMs={40} transportMode="demo" />);

    fireEvent.change(screen.getByLabelText('Presentation title'), {
      target: { value: 'Broken deck' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));

    await waitFor(
      () => {
        expect(screen.getByTestId('presentation-recovery-workspace')).toHaveAttribute(
          'data-state',
          'failed',
        );
      },
      { timeout: 4000 },
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Retry presentation job/i })).toBeInTheDocument();
    });
    expect(screen.queryByTestId('artifact-panel-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('presentation-job-error')).not.toBeInTheDocument();
    expect(screen.getByTestId('presentation-conversation-trigger')).toBeInTheDocument();
  }, 15000);

  it('exposes accessible landmarks and keyboard contract for the studio shell', async () => {
    const client = createPresentationDemoClient({ queuedMs: 60, runningMs: 60000 });
    render(<PresentationStudio client={client} pollIntervalMs={50} transportMode="demo" />);

    fireEvent.change(screen.getByLabelText('Presentation title'), {
      target: { value: 'Accessible deck' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));

    await waitFor(
      () => {
        expect(
          screen.getByRole('region', { name: /Presentation job status/i }),
        ).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    expect(screen.getByRole('region', { name: /Presentation creator/i })).toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: /Presentation job list/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Slide navigator/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Slide preview/i })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: /Artifacts/i })).toBeInTheDocument();
    // The job selection row is keyboard focusable and announces selection
    const option = screen.getByRole('option', {
      name: /Accessible deck, state: (queued|running)/i,
    });
    expect(option).toHaveAttribute('tabindex', '0');
  }, 15000);

  it('keeps a reduced-motion and responsive CSS contract for 1440×900 / 390×844', () => {
    const styles = readStyleSource(path.join(FIXTURE, 'style.ts'));
    const workspaceStyles = readStyleSource(path.join(FIXTURE, 'CompletedWorkspace', 'style.ts'));
    const navigatorStyles = readStyleSource(path.join(FIXTURE, 'SlideNavigator', 'style.ts'));
    const panelStyles = readStyleSource(path.join(FIXTURE, 'ArtifactPanel', 'style.ts'));
    const composerStyles = readStyleSource(path.join(FIXTURE, 'PresentationComposer', 'style.ts'));
    const progressStyles = readStyleSource(path.join(FIXTURE, 'PresentationProgress', 'style.ts'));

    // The stage owns the viewport; its overview grid adapts to available width.
    expect(workspaceStyles).toContain('stageArea: css');
    expect(workspaceStyles).toContain('grid-template-columns: repeat(4, 1fr)');

    // Tablet 1200 collapses the rail; phones 390×844 stack to one column
    expect(styles).toContain('@media (width <= 1200px)');
    expect(styles).toContain('@media (width <= 768px)');
    expect(styles).toContain('@media (width <= 480px)');

    // Page navigation remains vertical; the overview collapses on phones.
    expect(navigatorStyles).toContain('grid-template-columns: minmax(0, 1fr)');
    expect(workspaceStyles).toContain('@media (width <= 480px)');
    expect(workspaceStyles).toContain('grid-template-columns: 1fr');

    // Every interactive surface honours prefers-reduced-motion
    for (const source of [styles, navigatorStyles, panelStyles, composerStyles, progressStyles]) {
      expect(source).toContain('prefers-reduced-motion: reduce');
    }

    // Progress buttons stretch full width on phones for touch targets
    expect(progressStyles).toContain('@media (width <= 768px)');
    expect(progressStyles).toContain('flex: 1');
  });
});

const t0 = '2026-08-31T00:00:00.000Z';

const mockJob = (
  jobId: string,
  state: PresentationJob['state'] = 'running',
  artifactIds: string[] = [],
): PresentationJob => ({
  artifactIds,
  createdAt: t0,
  jobId,
  state,
  updatedAt: t0,
});

const mockArtifact = (artifactId: string, uri?: string): ArtifactSnapshot => ({
  artifactId,
  createdAt: t0,
  mimeType: 'image/png',
  name: `${artifactId}.png`,
  sizeBytes: 1024,
  status: 'ready',
  type: 'image',
  updatedAt: t0,
  ...(uri ? { uri } : {}),
});

const mockJobEvent = (
  jobId: string,
  seq: number,
  state: PresentationJob['state'] = 'running',
  artifactIds: string[] = [],
): PresentationJobEvent => ({
  data: mockJob(jobId, state, artifactIds),
  job_id: jobId,
  protocol_version: 'runtime.v1',
  seq,
  type: 'job',
});

const mockSlotEvent = (
  jobId: string,
  seq: number,
  data: Record<string, unknown>,
  type = 'image.generation.progress',
): PresentationJobEvent => ({
  data,
  job_id: jobId,
  protocol_version: 'runtime.v1',
  seq,
  type,
});

const baseStreamClient = (
  overrides: Partial<PresentationStreamClient> = {},
): PresentationStreamClient => ({
  cancelPresentationJob: vi.fn(async (id: string) => mockJob(id, 'cancelled')),
  createImageGeneration: vi.fn(async ({ jobId, slots }: CreateImageGenerationInput) => ({
    jobId,
    slots: slots.map((s) => ({
      slideId: s.slideId,
      slotId: s.slotId,
      status: 'accepted' as const,
    })),
  })),
  createPresentationJob: vi.fn(async () => mockJob('job-1', 'queued')),
  exportArtifact: vi.fn(),
  getArtifact: vi.fn(async (id: string) => mockArtifact(id, `https://assets.example/${id}.png`)),
  getPresentationJob: vi.fn(async (id: string) => mockJob(id, 'completed', ['art-1'])),
  retryPresentationJob: vi.fn(async (id: string) => mockJob(id, 'queued')),
  subscribePresentationJob: vi.fn((jobId: string) =>
    (async function* () {
      yield mockJobEvent(jobId, 1, 'running');
      await new Promise<void>(() => undefined);
    })(),
  ),
  ...overrides,
});

describe('PresentationStudio real-chain and E2E acceptance (C-104)', () => {
  it('verifies image-generation request dispatch, prompt injection, and strict DOM isolation', async () => {
    const SECRET_PROMPT = 'CONFIDENTIAL_SLOT_PROMPT_RETRY_CHART_2026';
    const createImageGeneration = vi.fn(async ({ jobId, slots }: CreateImageGenerationInput) => ({
      jobId,
      slots: slots.map((s) => ({
        slideId: s.slideId,
        slotId: s.slotId,
        status: 'accepted' as const,
      })),
    }));

    const resolveSlotPrompt = vi.fn(({ slotId }) =>
      slotId === 'chart-slot' ? SECRET_PROMPT : undefined,
    );

    const client: PresentationStreamClient = baseStreamClient({
      createImageGeneration,
      createPresentationJob: vi.fn(async () => mockJob('job-1', 'running')),
      subscribePresentationJob: vi.fn((jobId: string) =>
        (async function* () {
          yield mockJobEvent(jobId, 1, 'running');
          yield mockSlotEvent(jobId, 2, {
            errorCode: 'IMAGE_UNAVAILABLE',
            label: 'Financial Chart',
            slideId: 'slide-1',
            slotId: 'chart-slot',
            status: 'failed',
          });
          await new Promise<void>(() => undefined);
        })(),
      ),
    });

    const { container } = render(
      <PresentationStudio
        client={client}
        pollIntervalMs={50}
        resolveSlotPrompt={resolveSlotPrompt}
      />,
    );

    fireEvent.change(screen.getByLabelText('Presentation title'), {
      target: { value: 'Finance Deck' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));

    await waitFor(
      () => {
        expect(screen.getByTestId('asset-slot-panel')).toBeInTheDocument();
        expect(screen.getByTestId('slot-slide-1-chart-slot')).toBeInTheDocument();
        expect(screen.getByTestId('slot-retry-slide-1-chart-slot')).toBeInTheDocument();
      },
      { timeout: 8000 },
    );

    expect(screen.getByText('IMAGE_UNAVAILABLE')).toBeInTheDocument();
    expect(container.textContent).not.toContain(SECRET_PROMPT);
    expect(document.body.innerHTML).not.toContain(SECRET_PROMPT);

    const retryBtn = screen.getByTestId('slot-retry-slide-1-chart-slot');
    fireEvent.click(retryBtn);

    await waitFor(
      () => {
        expect(resolveSlotPrompt).toHaveBeenCalledWith({
          jobId: 'job-1',
          slideId: 'slide-1',
          slotId: 'chart-slot',
        });
      },
      { timeout: 5000 },
    );

    expect(createImageGeneration).toHaveBeenCalledWith({
      jobId: 'job-1',
      slots: [
        {
          idempotencyKey: 'job-1:slide-1:chart-slot',
          prompt: SECRET_PROMPT,
          slideId: 'slide-1',
          slotId: 'chart-slot',
        },
      ],
    });

    expect(container.textContent).not.toContain(SECRET_PROMPT);
    expect(document.body.innerHTML).not.toContain(SECRET_PROMPT);
  }, 15000);

  it('verifies SSE slot events lifecycle and thumbnail projection', async () => {
    const queue: PresentationJobEvent[] = [];
    const resolvers: ((value: PresentationJobEvent) => void)[] = [];

    const pushEvent = (event: PresentationJobEvent) => {
      const resolver = resolvers.shift();
      if (resolver) resolver(event);
      else queue.push(event);
    };

    const nextEvent = (): Promise<PresentationJobEvent> => {
      const val = queue.shift();
      if (val) return Promise.resolve(val);
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    };

    const client: PresentationStreamClient = baseStreamClient({
      createPresentationJob: vi.fn(async () => mockJob('job-1', 'running', ['art-chart'])),
      getArtifact: vi.fn(async (id: string) =>
        mockArtifact(id, 'https://assets.example/chart.png'),
      ),
      subscribePresentationJob: vi.fn((jobId: string) =>
        (async function* () {
          yield mockJobEvent(jobId, 1, 'running');
          while (true) {
            const ev = await nextEvent();
            yield ev;
          }
        })(),
      ),
    });

    render(<PresentationStudio client={client} pollIntervalMs={50} />);

    fireEvent.change(screen.getByLabelText('Presentation title'), {
      target: { value: 'Diagram Deck' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));

    await waitFor(
      () => {
        expect(screen.getByTestId('presentation-progress')).toBeInTheDocument();
      },
      { timeout: 8000 },
    );

    // 1. Generating progress event
    pushEvent(
      mockSlotEvent('job-1', 2, {
        label: 'Diagram 1',
        slideId: 'slide-1',
        slotId: 'diag-1',
        status: 'generating',
      }),
    );

    // C-112: generation mode intentionally hides the legacy slot/task panels.
    // Slot events are still projected into the store and become visible in the
    // editable workspace after the job reaches a terminal state.
    await waitFor(
      () => {
        expect(screen.getByTestId('presentation-generation-workspace')).toBeInTheDocument();
        expect(screen.queryByTestId('slot-status-generating')).not.toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    // 2. Ready asset event
    pushEvent(
      mockSlotEvent(
        'job-1',
        3,
        {
          artifactId: 'art-chart',
          label: 'Diagram 1',
          slideId: 'slide-1',
          slotId: 'diag-1',
          status: 'ready',
        },
        'image.generation.asset.ready',
      ),
    );

    await waitFor(
      () => {
        expect(screen.getByTestId('slot-status-ready')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    // 3. Artifact ready event + completed job event hydrate artifacts and render thumbnail
    pushEvent({
      data: mockArtifact('art-chart', 'https://assets.example/chart.png'),
      job_id: 'job-1',
      protocol_version: 'runtime.v1',
      seq: 4,
      type: 'artifact',
    });
    pushEvent(mockJobEvent('job-1', 5, 'completed', ['art-chart']));

    await waitFor(
      () => {
        expect(screen.getByTestId('slot-thumb-slide-1-diag-1')).toHaveAttribute(
          'src',
          'https://assets.example/chart.png',
        );
      },
      { timeout: 5000 },
    );
  }, 15000);

  it('verifies selected-job isolation for slots, retry actions, and thumbnails', async () => {
    let callCount = 0;
    const createPresentationJob = vi.fn(async (): Promise<PresentationJob> => {
      callCount += 1;
      return callCount === 1 ? mockJob('job-a', 'running') : mockJob('job-b', 'running');
    });

    const client: PresentationStreamClient = baseStreamClient({
      createPresentationJob,
      subscribePresentationJob: vi.fn((jobId: string) =>
        (async function* () {
          if (jobId === 'job-a') {
            yield mockJobEvent('job-a', 1, 'running');
            yield mockSlotEvent('job-a', 2, {
              artifactId: 'art-a1',
              label: 'Slot A1',
              slideId: 'slide-1',
              slotId: 'slot-a1',
              status: 'ready',
            });
            await new Promise<void>(() => undefined);
          } else {
            yield mockJobEvent('job-b', 1, 'running');
            yield mockSlotEvent('job-b', 2, {
              artifactId: 'art-b1',
              label: 'Slot B1',
              slideId: 'slide-1',
              slotId: 'slot-b1',
              status: 'ready',
            });
            await new Promise<void>(() => undefined);
          }
        })(),
      ),
    });

    render(<PresentationStudio client={client} pollIntervalMs={50} />);

    // Create Job A
    fireEvent.change(screen.getByLabelText('Presentation title'), { target: { value: 'Job A' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));

    await waitFor(
      () => {
        expect(screen.getByTestId('slot-slide-1-slot-a1')).toBeInTheDocument();
      },
      { timeout: 8000 },
    );
    expect(screen.queryByTestId('slot-slide-1-slot-b1')).not.toBeInTheDocument();

    // Create Job B
    fireEvent.change(screen.getByLabelText('Presentation title'), { target: { value: 'Job B' } });
    fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));

    // Job B is now created and selected
    await waitFor(
      () => {
        expect(screen.getByTestId('slot-slide-1-slot-b1')).toBeInTheDocument();
      },
      { timeout: 8000 },
    );
    expect(screen.queryByTestId('slot-slide-1-slot-a1')).not.toBeInTheDocument();

    // Switch back to Job A
    const jobAOption = screen.getByRole('option', { name: /Job Job A/i });
    fireEvent.click(jobAOption);

    await waitFor(
      () => {
        expect(screen.getByTestId('slot-slide-1-slot-a1')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
    expect(screen.queryByTestId('slot-slide-1-slot-b1')).not.toBeInTheDocument();
  }, 20000);

  it('verifies 401 authorization failure mapping without leaking sensitive credentials', async () => {
    const SENSITIVE_TOKEN = 'Bearer sk-proj-super-secret-auth-key-999';
    const createImageGeneration = vi
      .fn()
      .mockRejectedValue(
        new Error(
          `Failed to create image generation (401 Unauthorized): {"error":{"code":"IMAGE_PROVIDER_REJECTED","message":"Invalid token ${SENSITIVE_TOKEN}"}}`,
        ),
      );

    const client: PresentationStreamClient = baseStreamClient({
      createImageGeneration,
      createPresentationJob: vi.fn(async () => mockJob('job-1', 'running')),
      subscribePresentationJob: vi.fn((jobId: string) =>
        (async function* () {
          yield mockJobEvent(jobId, 1, 'running');
          yield mockSlotEvent(jobId, 2, {
            errorCode: 'IMAGE_UNAVAILABLE',
            label: 'Chart Slot',
            slideId: 'slide-1',
            slotId: 'chart-1',
            status: 'failed',
          });
          await new Promise<void>(() => undefined);
        })(),
      ),
    });

    const { container } = render(
      <PresentationStudio
        client={client}
        pollIntervalMs={50}
        resolveSlotPrompt={() => 'Generate chart image'}
      />,
    );

    fireEvent.change(screen.getByLabelText('Presentation title'), {
      target: { value: 'Auth Test' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));

    await waitFor(
      () => {
        expect(screen.getByTestId('slot-retry-slide-1-chart-1')).toBeInTheDocument();
      },
      { timeout: 8000 },
    );

    fireEvent.click(screen.getByTestId('slot-retry-slide-1-chart-1'));

    await waitFor(
      () => {
        expect(screen.getByText('IMAGE_PROVIDER_REJECTED')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    expect(container.textContent).not.toContain(SENSITIVE_TOKEN);
    expect(document.body.innerHTML).not.toContain(SENSITIVE_TOKEN);
    expect(document.body.innerHTML).not.toContain('401 Unauthorized');
  }, 15000);

  it('verifies 503 PROVIDER_UNAVAILABLE banner with try-again recovery', async () => {
    const createPresentationJob = vi.fn<(input: PresentationJobInput) => Promise<PresentationJob>>(
      async () => {
        const err = new Error('HTTP 503 PROVIDER_UNAVAILABLE: presentation backend offline');
        (err as unknown as { code: string }).code = 'PROVIDER_UNAVAILABLE';
        throw err;
      },
    );

    const client: PresentationStreamClient = baseStreamClient({
      createPresentationJob,
    });

    render(<PresentationStudio client={client} pollIntervalMs={50} />);

    fireEvent.change(screen.getByLabelText('Presentation title'), {
      target: { value: 'Executive Overview' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));

    await waitFor(
      () => {
        expect(screen.getByTestId('presentation-provider-unavailable')).toBeInTheDocument();
        expect(screen.getByTestId('presentation-provider-resubmit')).toBeInTheDocument();
      },
      { timeout: 8000 },
    );

    createPresentationJob.mockResolvedValueOnce(mockJob('job-recovered', 'queued'));

    fireEvent.click(screen.getByTestId('presentation-provider-resubmit'));

    await waitFor(
      () => {
        expect(createPresentationJob).toHaveBeenCalledTimes(2);
        expect(createPresentationJob).toHaveBeenLastCalledWith(
          expect.objectContaining({ title: 'Executive Overview' }),
        );
      },
      { timeout: 5000 },
    );
  }, 15000);

  it('verifies job cancellation while running', async () => {
    const cancelPresentationJob = vi.fn(async (id: string) => mockJob(id, 'cancelled'));
    const client: PresentationStreamClient = baseStreamClient({
      cancelPresentationJob,
      createPresentationJob: vi.fn(async () => mockJob('job-cancelling', 'running')),
      subscribePresentationJob: vi.fn((jobId: string) =>
        (async function* () {
          yield mockJobEvent(jobId, 1, 'running');
          await new Promise<void>(() => undefined);
        })(),
      ),
    });

    render(<PresentationStudio client={client} pollIntervalMs={50} />);

    fireEvent.change(screen.getByLabelText('Presentation title'), {
      target: { value: 'Cancel Test Deck' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));

    await waitFor(
      () => {
        expect(
          screen.getByRole('button', { name: /Cancel presentation job/i }),
        ).toBeInTheDocument();
      },
      { timeout: 8000 },
    );

    fireEvent.click(screen.getByRole('button', { name: /Cancel presentation job/i }));

    await waitFor(
      () => {
        expect(cancelPresentationJob).toHaveBeenCalledWith('job-cancelling');
        expect(screen.getByTestId('presentation-recovery-workspace')).toHaveAttribute(
          'data-state',
          'cancelled',
        );
        expect(screen.getByRole('button', { name: /Retry presentation job/i })).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  }, 15000);

  it('verifies SSE stream reconnect backoff with cursor preservation', async () => {
    let streamCount = 0;
    let closeFirstStream: () => void = () => undefined;
    const firstStreamClosed = new Promise<void>((res) => {
      closeFirstStream = res;
    });

    const subscribePresentationJob = vi.fn((jobId: string) => {
      streamCount += 1;
      if (streamCount === 1) {
        return (async function* () {
          yield mockJobEvent(jobId, 1, 'running');
          yield mockJobEvent(jobId, 2, 'running');
          await firstStreamClosed;
        })();
      }
      return (async function* () {
        yield mockJobEvent(jobId, 3, 'running');
        await new Promise<void>(() => undefined);
      })();
    });

    const client: PresentationStreamClient = baseStreamClient({
      createPresentationJob: vi.fn(async () => mockJob('job-recon', 'running')),
      subscribePresentationJob,
    });

    render(
      <PresentationStudio
        client={client}
        pollIntervalMs={50}
        streamReconnectOptions={{
          backoffBaseMs: 10,
          maxReconnectAttempts: 3,
          wait: async () => undefined,
        }}
      />,
    );

    fireEvent.change(screen.getByLabelText('Presentation title'), {
      target: { value: 'Reconnect Deck' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Job/i }));

    await waitFor(
      () => {
        expect(subscribePresentationJob).toHaveBeenCalledWith(
          'job-recon',
          expect.objectContaining({ afterSeq: 0 }),
        );
      },
      { timeout: 8000 },
    );

    closeFirstStream();

    await waitFor(
      () => {
        expect(subscribePresentationJob).toHaveBeenCalledTimes(2);
        expect(subscribePresentationJob).toHaveBeenLastCalledWith(
          'job-recon',
          expect.objectContaining({ afterSeq: 2 }),
        );
      },
      { timeout: 5000 },
    );
  }, 15000);
});
