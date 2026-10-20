import { describe, expect, it, vi } from 'vitest';

import type { PresentationJob } from '../../../../packages/runtime-contracts/src/index';
import type { PresentationJobEvent } from '../../../services/runtime/client';
import type { PresentationStreamClient } from './presentationStore';
import { createPresentationStudioStore, projectPresentationEventData } from './presentationStore';

const t0 = '2026-08-30T10:00:00.000Z';

const baseClient = (): PresentationStreamClient => ({
  createPresentationJob: vi.fn(),
  getPresentationJob: vi.fn(async () => null),
  cancelPresentationJob: vi.fn(),
  retryPresentationJob: vi.fn(),
  getArtifact: vi.fn(),
  exportArtifact: vi.fn(),
});

const event = (jobId: string, seq: number, data: unknown, type = 'job'): PresentationJobEvent => ({
  data,
  job_id: jobId,
  protocol_version: 'runtime.v1',
  seq,
  type,
});

const jobShape = (
  jobId: string,
  state: PresentationJob['state'] = 'running',
  extra: Record<string, unknown> = {},
): PresentationJob => ({
  jobId,
  state,
  createdAt: t0,
  updatedAt: t0,
  ...extra,
});

const artifactShape = (artifactId: string, extra: Record<string, unknown> = {}) => ({
  artifactId,
  type: 'svg',
  status: 'ready',
  createdAt: t0,
  updatedAt: t0,
  ...extra,
});

describe('PresentationStudio event payload projection (C-68)', () => {
  it('consumes an old failure replay without replacing a newer completed snapshot', () => {
    const store = createPresentationStudioStore(baseClient());
    const completed = jobShape('j', 'completed', {
      artifactIds: ['new-slide'],
      updatedAt: '2026-09-21T06:10:00Z',
    });
    store.setState({ jobs: { j: completed } });
    store.getState().applyPresentationEvent(
      event('j', 12, {
        job: jobShape('j', 'failed'),
        activity: 'old failure',
        artifactIds: ['old-slide'],
      }),
    );
    expect(store.getState().jobs.j).toEqual(completed);
    expect(store.getState().lastSeqByJob.j).toBe(12);
    expect(store.getState().generationProgressByJob.j).toBeUndefined();
  });

  it('accepts a newer HTTP result even if an older event arrives while fetching', async () => {
    let resolve!: (job: PresentationJob) => void;
    const client = baseClient();
    client.getPresentationJob = vi.fn(
      () =>
        new Promise<PresentationJob>((done) => {
          resolve = done;
        }),
    );
    const store = createPresentationStudioStore(client);
    store.setState({ jobs: { j: jobShape('j') } });
    const fetching = store.getState().refreshJob('j');
    store.getState().applyPresentationEvent(event('j', 13, jobShape('j', 'failed')));
    const completed = jobShape('j', 'completed', { updatedAt: '2026-09-21T06:10:00Z' });
    resolve(completed);
    await fetching;
    expect(store.getState().jobs.j).toEqual(completed);
  });

  it('classifies legacy top-level shapes and the C-63 nested bundle', () => {
    expect(projectPresentationEventData(jobShape('j'))?.kind).toBe('job');
    expect(projectPresentationEventData(artifactShape('a'))?.kind).toBe('artifact');
    expect(
      projectPresentationEventData({ job: jobShape('j'), artifact: artifactShape('a') })?.kind,
    ).toBe('bundle');
    expect(projectPresentationEventData({ artifactIds: ['a1', 'a2'] })?.kind).toBe('bundle');
    expect(projectPresentationEventData({ work: 1 })?.kind).toBe('invalid');
    expect(projectPresentationEventData(42)?.kind).toBe('invalid');
  });

  it('projects a nested bundle: job + artifact updates, artifact linked to the event job', () => {
    const store = createPresentationStudioStore(baseClient());

    store.getState().applyPresentationEvent(
      event(
        'job-ev',
        1,
        {
          job: jobShape('job-ev', 'completed', {
            artifactIds: ['slide-per-job-1'],
            bytes: Uint8Array.from([1]),
            path: '/tmp/evil',
          }),
          artifact: artifactShape('slide-per-job-1', {
            bytes: [1, 2, 3],
            workspacePath: '/home/evil/workspace',
            metadata: { bytes: [9], path: '/x', workspace: '/y', slide: 1 },
          }),
          artifactIds: ['slide-per-job-1', 'deck.pptx'],
        },
        'pipeline_state',
      ),
    );

    const state = store.getState();
    // job snapshot projected: no bytes/path, artifactIds intact
    expect(state.jobs['job-ev'].state).toBe('completed');
    expect(state.jobs['job-ev'].artifactIds).toEqual(['slide-per-job-1', 'deck.pptx']);
    // artifact stored, binary/path keys stripped everywhere
    expect(state.artifacts['slide-per-job-1'].status).toBe('ready');
    expect(state.artifacts['slide-per-job-1'].metadata).toEqual({ slide: 1 });
    expect(JSON.stringify(state.artifacts)).not.toContain('bytes');
    expect(JSON.stringify(state.artifacts)).not.toContain('workspacePath');
    expect(JSON.stringify(state.jobs)).not.toContain('path');
    // seq bookkeeping monotonic
    expect(state.lastSeqByJob['job-ev']).toBe(1);
  });

  it('applies nested artifactIds to a known job without a job snapshot', () => {
    const store = createPresentationStudioStore(baseClient());
    store.setState({
      jobs: { 'job-ev': { ...jobShape('job-ev', 'running') } },
      jobOrder: ['job-ev'],
      selectedJobId: 'job-ev',
    });

    store
      .getState()
      .applyPresentationEvent(event('job-ev', 2, { artifactIds: ['a-1', 'a-2'] }, 'artifacts'));

    const state = store.getState();
    expect(state.jobs['job-ev'].artifactIds).toEqual(['a-1', 'a-2']);
    expect(state.jobs['job-ev'].state).toBe('running');
    expect(state.selectedJobId).toBe('job-ev');
  });

  it('uses event.job_id as the only owner when a nested job id disagrees', () => {
    const store = createPresentationStudioStore(baseClient());
    store.setState({
      jobs: { 'job-ev': { ...jobShape('job-ev', 'running') } },
      jobOrder: ['job-ev'],
      selectedJobId: 'job-ev',
    });

    store.getState().applyPresentationEvent(
      event('job-ev', 1, {
        job: jobShape('other-job', 'completed', { artifactIds: ['foreign-artifact'] }),
        artifact: artifactShape('event-artifact'),
        artifactIds: ['event-artifact'],
      }),
    );

    const state = store.getState();
    expect(state.jobs['other-job']).toBeUndefined();
    expect(state.jobs['job-ev'].state).toBe('running');
    expect(state.jobs['job-ev'].artifactIds).toEqual(['event-artifact']);
    expect(state.artifacts['event-artifact']).toBeDefined();
    expect(state.ignoredEvents).toBe(1);
  });

  it('keeps idempotency and never regresses on out-of-order events', () => {
    const store = createPresentationStudioStore(baseClient());

    store.getState().applyPresentationEvent(event('job-ev', 5, jobShape('job-ev', 'completed')));
    // Late/duplicate older event must not roll the state back.
    store.getState().applyPresentationEvent(event('job-ev', 5, jobShape('job-ev', 'running')));
    store.getState().applyPresentationEvent(event('job-ev', 4, jobShape('job-ev', 'queued')));

    const state = store.getState();
    expect(state.jobs['job-ev'].state).toBe('completed');
    expect(state.lastSeqByJob['job-ev']).toBe(5);
  });

  it('isolates events per job: cross-job artifacts never pollute other jobs', () => {
    const store = createPresentationStudioStore(baseClient());
    store.setState({
      jobs: {
        'job-a': { ...jobShape('job-a', 'running') },
        'job-b': { ...jobShape('job-b', 'running') },
      },
      jobOrder: ['job-a', 'job-b'],
    });

    store.getState().applyPresentationEvent(event('job-a', 1, artifactShape('art-a')));
    store.getState().applyPresentationEvent(event('job-b', 1, artifactShape('art-b')));

    const state = store.getState();
    expect(state.artifacts['art-a'].status).toBe('ready');
    expect(state.artifacts['art-b'].status).toBe('ready');
    expect(state.jobs['job-a'].artifactIds).toEqual(['art-a']);
    expect(state.jobs['job-b'].artifactIds).toEqual(['art-b']);
  });

  it('ignores invalid payloads observably without fabricating state', () => {
    const store = createPresentationStudioStore(baseClient());

    store.getState().applyPresentationEvent(event('job-ev', 1, { work: 1 }, 'unknown'));
    store.getState().applyPresentationEvent(event('job-ev', 2, 'not-an-object', 'unknown'));

    const state = store.getState();
    expect(state.ignoredEvents).toBe(2);
    expect(Object.keys(state.jobs)).toHaveLength(0);
    expect(Object.keys(state.artifacts)).toHaveLength(0);
    expect(state.lastSeqByJob['job-ev']).toBe(2);
  });

  it('never fabricates a job for artifactIds-only bundles targeting unknown jobs', () => {
    const store = createPresentationStudioStore(baseClient());

    store
      .getState()
      .applyPresentationEvent(event('unknown-job', 1, { artifactIds: ['a-1'] }, 'artifacts'));

    const state = store.getState();
    expect(state.jobs['unknown-job']).toBeUndefined();
    expect(state.ignoredEvents).toBe(0);
  });

  it('keeps legacy top-level artifact association to the event job', () => {
    const store = createPresentationStudioStore(baseClient());
    store.setState({
      jobs: { 'job-ev': { ...jobShape('job-ev', 'running') } },
      jobOrder: ['job-ev'],
      selectedJobId: 'job-ev',
    });

    store.getState().applyPresentationEvent(event('job-ev', 1, artifactShape('legacy-a')));

    expect(store.getState().jobs['job-ev'].artifactIds).toEqual(['legacy-a']);
    expect(store.getState().selectedArtifactId).toBeNull();
  });
});

describe('PresentationStudio nested event job ownership (C-72)', () => {
  const baseClient = (): PresentationStreamClient => ({
    createPresentationJob: vi.fn(),
    getPresentationJob: vi.fn(async () => null),
    cancelPresentationJob: vi.fn(),
    retryPresentationJob: vi.fn(),
    getArtifact: vi.fn(),
    exportArtifact: vi.fn(),
  });

  const event = (
    jobId: string,
    seq: number,
    data: unknown,
    type = 'job',
  ): PresentationJobEvent => ({
    data,
    job_id: jobId,
    protocol_version: 'runtime.v1',
    seq,
    type,
  });

  const jobShape = (
    jobId: string,
    state: PresentationJob['state'] = 'running',
    extra: Record<string, unknown> = {},
  ): PresentationJob => ({
    jobId,
    state,
    createdAt: t0,
    updatedAt: t0,
    ...extra,
  });

  const artifactShape = (artifactId: string, extra: Record<string, unknown> = {}) => ({
    artifactId,
    type: 'svg',
    status: 'ready',
    createdAt: t0,
    updatedAt: t0,
    ...extra,
  });

  it('rewrites a mismatched nested jobId onto the event job and never creates the claimed job', () => {
    const store = createPresentationStudioStore(baseClient());
    store.setState({
      jobs: { 'job-ev': { ...jobShape('job-ev', 'running') } },
      jobOrder: ['job-ev'],
    });

    store.getState().applyPresentationEvent(
      event(
        'job-ev',
        3,
        {
          job: jobShape('job-other', 'completed', { artifactIds: ['a-other'] }),
          artifact: artifactShape('art-ev'),
          artifactIds: ['deck.pptx'],
        },
        'pipeline_state',
      ),
    );

    const state = store.getState();
    // The claimed job is never fabricated from a foreign snapshot.
    expect(state.jobs['job-other']).toBeUndefined();
    // Mismatched snapshot is observable as ignored; artifact/artifactIds stay
    // linked to the wire event's job only.
    expect(state.ignoredEvents).toBe(1);
    expect(state.jobs['job-ev'].state).toBe('running');
    expect(state.jobs['job-ev'].artifactIds).toEqual(['art-ev', 'deck.pptx']);
    expect(state.artifacts['art-ev'].status).toBe('ready');
    expect(state.lastSeqByJob['job-ev']).toBe(3);
    expect(state.jobOrder).not.toContain('job-other');
  });

  it('stores a mismatched bundle artifact without fabricating an unknown event job', () => {
    const store = createPresentationStudioStore(baseClient());

    store
      .getState()
      .applyPresentationEvent(event('job-ev', 1, { job: jobShape('job-other', 'failed') }));

    const state = store.getState();
    expect(state.jobs['job-other']).toBeUndefined();
    expect(state.jobs['job-ev']).toBeUndefined();
    expect(state.ignoredEvents).toBe(1);
    expect(state.lastSeqByJob['job-ev']).toBe(1);
  });

  it('never pollutes an existing other job when a bundle claims its id', () => {
    const store = createPresentationStudioStore(baseClient());
    store.setState({
      jobs: {
        'job-a': { ...jobShape('job-a', 'running') },
        'job-b': { ...jobShape('job-b', 'running') },
      },
      jobOrder: ['job-a', 'job-b'],
    });

    store.getState().applyPresentationEvent(
      event(
        'job-a',
        1,
        {
          job: jobShape('job-b', 'failed', { artifactIds: ['evil-1'] }),
          artifactIds: ['evil-2'],
        },
        'pipeline_state',
      ),
    );

    const state = store.getState();
    expect(state.jobs['job-b'].state).toBe('running');
    expect(state.jobs['job-b'].artifactIds).toBeUndefined();
    expect(state.ignoredEvents).toBe(1);
    expect(state.lastSeqByJob['job-ev']).toBeUndefined();
    expect(state.lastSeqByJob['job-a']).toBe(1);
  });

  it('applies a nested bundle whose jobId matches the event job (regression)', () => {
    const store = createPresentationStudioStore(baseClient());

    store.getState().applyPresentationEvent(
      event(
        'job-ev',
        1,
        {
          job: jobShape('job-ev', 'completed', { artifactIds: [] }),
          artifact: artifactShape('art-ok'),
        },
        'pipeline_state',
      ),
    );

    const state = store.getState();
    expect(state.jobs['job-ev'].state).toBe('completed');
    expect(state.jobs['job-ev'].artifactIds).toEqual(['art-ok']);
    expect(state.ignoredEvents).toBe(0);
  });

  it('keeps duplicate/out-of-order ownership under the event job', () => {
    const store = createPresentationStudioStore(baseClient());

    store
      .getState()
      .applyPresentationEvent(event('job-ev', 5, { job: jobShape('job-ev', 'completed') }));
    // Replay at the same or lower seq must be a no-op, foreign payload or not.
    store
      .getState()
      .applyPresentationEvent(event('job-ev', 5, { job: jobShape('job-other', 'failed') }));
    store
      .getState()
      .applyPresentationEvent(event('job-ev', 4, { job: jobShape('job-other', 'queued') }));

    const state = store.getState();
    expect(state.jobs['job-ev'].state).toBe('completed');
    expect(state.jobs['job-other']).toBeUndefined();
    expect(state.ignoredEvents).toBe(0);
    expect(state.lastSeqByJob['job-ev']).toBe(5);
  });

  describe('R1-B: Real-time generation progress projection and forbidden key protection', () => {
    it('projects stage, activity, currentSlide, totalSlides, and progress from wire events without guessing', () => {
      const store = createPresentationStudioStore(baseClient());

      // Wire event arrives with real progress
      store.getState().applyPresentationEvent(
        event(
          'job-progress',
          1,
          {
            job: jobShape('job-progress', 'running'),
            stage: 'planning',
            activity: '正在分析参考材料',
            currentSlide: 2,
            totalSlides: 8,
            progress: 25,
          },
          'job',
        ),
      );

      const state = store.getState();
      const progress = state.generationProgressByJob['job-progress'];
      expect(progress).toBeDefined();
      expect(progress.stage).toBe('planning');
      expect(progress.activity).toBe('正在分析参考材料');
      expect(progress.currentSlide).toBe(2);
      expect(progress.totalSlides).toBe(8);
      expect(progress.progress).toBe(25);
      expect(state.lastSeqByJob['job-progress']).toBe(1);
    });

    it('defensively strips prompt, bytes, path, workspace, and secret keys from event projection', () => {
      const store = createPresentationStudioStore(baseClient());

      store.getState().applyPresentationEvent(
        event(
          'job-secure',
          1,
          {
            job: jobShape('job-secure', 'running'),
            activity: '正在规划第 3 页',
            currentSlide: 3,
            totalSlides: 10,
            progress: 30,
            prompt: 'TOP SECRET PROMPT TEXT',
            secret: 'sk-1234567890',
            apiKey: 'secret_key',
            bytes: [1, 2, 3],
            path: '/etc/shadow',
            workspace: '/private/workspace',
          },
          'job',
        ),
      );

      const state = store.getState();
      const progressRecord = state.generationProgressByJob['job-secure'] as Record<string, unknown>;
      expect(progressRecord.activity).toBe('正在规划第 3 页');
      expect(progressRecord.currentSlide).toBe(3);
      expect(progressRecord.prompt).toBeUndefined();
      expect(progressRecord.secret).toBeUndefined();
      expect(progressRecord.apiKey).toBeUndefined();
      expect(progressRecord.bytes).toBeUndefined();
      expect(progressRecord.path).toBeUndefined();
      expect(progressRecord.workspace).toBeUndefined();

      const serialized = JSON.stringify(state);
      expect(serialized).not.toContain('TOP SECRET PROMPT TEXT');
      expect(serialized).not.toContain('sk-1234567890');
      expect(serialized).not.toContain('/etc/shadow');
    });

    it('safely ignores invalid events and increments counter without fabricating progress', () => {
      const store = createPresentationStudioStore(baseClient());

      store
        .getState()
        .applyPresentationEvent(event('job-invalid', 1, { unrecognisedField: 'xyz' }));

      const state = store.getState();
      expect(state.ignoredEvents).toBe(1);
      expect(state.generationProgressByJob['job-invalid']).toBeUndefined();
      // Monotonic sequence is still recorded
      expect(state.lastSeqByJob['job-invalid']).toBe(1);
    });
  });

  describe('R2-B: Event protocol projection and short progress broadcast', () => {
    it('supports phase, activity, slideId, currentSlide, totalSlides, progress, and artifactIds whitelist projection', () => {
      const store = createPresentationStudioStore(baseClient());

      store.getState().applyPresentationEvent(
        event('job-r2b', 1, {
          activity: '正在生成第 2 页版式与视觉素材',
          artifactIds: ['slide-svg-1', 'slide-svg-2'],
          currentSlide: 2,
          phase: 'generating',
          progress: 50,
          slideId: 'slide-02',
          totalSlides: 6,
        }),
      );

      const state = store.getState();
      const progress = state.generationProgressByJob['job-r2b'];
      expect(progress).toBeDefined();
      expect(progress.phase).toBe('generating');
      expect(progress.activity).toBe('正在生成第 2 页版式与视觉素材');
      expect(progress.slideId).toBe('slide-02');
      expect(progress.currentSlide).toBe(2);
      expect(progress.totalSlides).toBe(6);
      expect(progress.progress).toBe(50);
      expect(progress.artifactIds).toEqual(['slide-svg-1', 'slide-svg-2']);
    });

    it('deduplicates artifactIds across multiple SSE events and does not duplicate artifacts', () => {
      const store = createPresentationStudioStore(baseClient());

      // Event 1 with slide-1
      store.getState().applyPresentationEvent(
        event('job-dedupe', 1, {
          activity: '生成第 1 页',
          artifactIds: ['slide-1'],
          currentSlide: 1,
          progress: 25,
        }),
      );

      // Event 2 with slide-1 and slide-2 (replaying slide-1)
      store.getState().applyPresentationEvent(
        event('job-dedupe', 2, {
          activity: '生成第 2 页',
          artifactIds: ['slide-1', 'slide-2'],
          currentSlide: 2,
          progress: 50,
        }),
      );

      const progress = store.getState().generationProgressByJob['job-dedupe'];
      expect(progress.artifactIds).toEqual(['slide-1', 'slide-2']);
      expect(progress.currentSlide).toBe(2);
      expect(progress.progress).toBe(50);
    });

    it('keeps bounded activity feeds, cursors and artifacts isolated between parallel jobs', () => {
      const store = createPresentationStudioStore(baseClient());

      store
        .getState()
        .applyPresentationEvent(
          event('job-a', 1, { activity: '正在绘画第一张素材', artifactIds: ['asset-a'] }),
        );
      store
        .getState()
        .applyPresentationEvent(
          event('job-b', 9, { activity: '正在处理透明度', artifactIds: ['asset-b'] }),
        );
      store
        .getState()
        .applyPresentationEvent(
          event('job-a', 2, { activity: '正在剪切第一张素材', artifactIds: ['asset-a-cut'] }),
        );

      const state = store.getState();
      expect(state.lastSeqByJob).toMatchObject({ 'job-a': 2, 'job-b': 9 });
      expect(state.generationProgressByJob['job-a']).toMatchObject({
        activity: '正在剪切第一张素材',
        artifactIds: ['asset-a', 'asset-a-cut'],
        activityHistory: [
          { id: 'job:1', text: '正在绘画第一张素材' },
          { id: 'job:2', text: '正在剪切第一张素材' },
        ],
      });
      expect(state.generationProgressByJob['job-b']).toMatchObject({
        activity: '正在处理透明度',
        artifactIds: ['asset-b'],
        activityHistory: [{ id: 'job:9', text: '正在处理透明度' }],
      });
    });

    it('recovers from lastSeq + 1 and safely ignores replayed or out-of-order events', () => {
      const store = createPresentationStudioStore(baseClient());

      store.getState().applyPresentationEvent(
        event('job-reconnect', 3, {
          activity: '完成第 3 页',
          currentSlide: 3,
          progress: 75,
        }),
      );

      expect(store.getState().lastSeqByJob['job-reconnect']).toBe(3);

      // Replayed event seq <= 3 is ignored
      store.getState().applyPresentationEvent(
        event('job-reconnect', 2, {
          activity: '过期的第 2 页',
          currentSlide: 2,
          progress: 50,
        }),
      );

      // State did not regress
      const progress = store.getState().generationProgressByJob['job-reconnect'];
      expect(progress.currentSlide).toBe(3);
      expect(progress.progress).toBe(75);
      expect(progress.activity).toBe('完成第 3 页');
      expect(store.getState().lastSeqByJob['job-reconnect']).toBe(3);
    });
  });
});
