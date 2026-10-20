import { describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import type {
  PluginDescriptor,
  RunSnapshot,
  RuntimeEvent,
  StartRunInput,
} from '../../../packages/runtime-contracts/src/index';
import type { RuntimeClient } from '../../services/runtime/client';
import { createRuntimeStore, runtimeSelectors } from './index';

describe('RuntimeStore', () => {
  const createMockClient = (overrides: Partial<RuntimeClient> = {}): RuntimeClient => ({
    sendPresentationMessage: vi.fn().mockResolvedValue({} as any),
    cancelPresentationJob: vi.fn().mockResolvedValue({} as any),
    cancelRun: vi.fn().mockResolvedValue(undefined),
    createImageGeneration: vi.fn().mockResolvedValue({ jobId: 'job-1', slots: [] }),
    createPresentationJob: vi.fn().mockResolvedValue({} as any),
    deletePresentationJob: vi.fn().mockResolvedValue(undefined),
    downloadArtifact: vi.fn().mockResolvedValue(new Blob()),
    exportArtifact: vi.fn().mockResolvedValue({} as any),
    getArtifact: vi.fn().mockResolvedValue(null),
    getPresentationJob: vi.fn().mockResolvedValue(null),
    getRun: vi.fn().mockResolvedValue(null),
    listPlugins: vi.fn().mockResolvedValue([]),
    mountPlugin: vi.fn().mockResolvedValue('active'),
    reloadPlugin: vi.fn().mockResolvedValue('active'),
    resumeRun: vi.fn().mockResolvedValue({} as any),
    retryPresentationJob: vi.fn().mockResolvedValue({} as any),
    startRun: vi.fn().mockResolvedValue({
      createdAt: '2026-08-26T00:00:00Z',
      runId: 'run-1',
      sessionId: 'session-1',
      state: 'queued',
      updatedAt: '2026-08-26T00:00:00Z',
    }),
    subscribe: vi.fn().mockImplementation(async function* () {
      yield {
        data: { state: 'running' },
        protocol_version: 'runtime.v1',
        run_id: 'run-1',
        seq: 1,
        session_id: 'session-1',
        type: 'run_state',
      } as RuntimeEvent;
    }),
    // The C-62 presentation job stream; run-store tests don't consume events,
    // so an empty generator keeps the seam structurally complete.
    subscribePresentationJob: vi.fn().mockImplementation(async function* () {
      yield;
    }),
    unmountPlugin: vi.fn().mockResolvedValue('disabled'),
    ...overrides,
  });

  it('has correct initial state', () => {
    const store = createStore(createRuntimeStore(createMockClient()));
    expect(store.getState().activeRunId).toBeNull();
    expect(store.getState().runs).toEqual({});
    expect(store.getState().eventsByRun).toEqual({});
    expect(store.getState().pluginStates).toEqual({});
  });

  it('startRun updates runs and activeRunId', async () => {
    const mockSnapshot: RunSnapshot = {
      createdAt: '2026-08-26T00:00:00Z',
      profileId: 'agent-chat',
      runId: 'run-100',
      sessionId: 'session-100',
      state: 'queued',
      updatedAt: '2026-08-26T00:00:00Z',
    };

    const mockClient = createMockClient({
      startRun: vi.fn().mockResolvedValue(mockSnapshot),
    });

    const store = createStore(createRuntimeStore(mockClient));
    const input: StartRunInput = {
      profileId: 'agent-chat',
      sessionId: 'session-100',
      userMessage: 'hi',
    };

    const snapshot = await store.getState().startRun(input);

    expect(snapshot).toEqual(mockSnapshot);
    expect(store.getState().activeRunId).toBe('run-100');
    expect(store.getState().runs['run-100']).toEqual(mockSnapshot);
    expect(runtimeSelectors.activeRun(store.getState())).toEqual(mockSnapshot);
  });

  it('getRun updates runs in store', async () => {
    const mockSnapshot: RunSnapshot = {
      createdAt: '2026-08-26T00:00:00Z',
      runId: 'run-200',
      sessionId: 'session-200',
      state: 'running',
      updatedAt: '2026-08-26T00:00:01Z',
    };

    const mockClient = createMockClient({
      getRun: vi.fn().mockResolvedValue(mockSnapshot),
    });

    const store = createStore(createRuntimeStore(mockClient));
    const res = await store.getState().getRun('run-200');

    expect(res).toEqual(mockSnapshot);
    expect(store.getState().runs['run-200']).toEqual(mockSnapshot);
  });

  it('cancelRun calls client and marks run cancelled', async () => {
    const mockSnapshot: RunSnapshot = {
      createdAt: '2026-08-26T00:00:00Z',
      runId: 'run-300',
      sessionId: 'session-300',
      state: 'running',
      updatedAt: '2026-08-26T00:00:00Z',
    };

    const mockClient = createMockClient({
      cancelRun: vi.fn().mockResolvedValue(undefined),
    });

    const store = createStore(createRuntimeStore(mockClient));
    store.setState({ runs: { 'run-300': mockSnapshot } });

    await store.getState().cancelRun('run-300');

    expect(mockClient.cancelRun).toHaveBeenCalledWith('run-300');
    expect(store.getState().runs['run-300']?.state).toBe('cancelled');
  });

  it('handleRuntimeEvent appends events and transitions run state', () => {
    const mockSnapshot: RunSnapshot = {
      createdAt: '2026-08-26T00:00:00Z',
      runId: 'run-400',
      sessionId: 'session-400',
      state: 'running',
      updatedAt: '2026-08-26T00:00:00Z',
    };

    const store = createStore(createRuntimeStore(createMockClient()));
    store.setState({ activeRunId: 'run-400', runs: { 'run-400': mockSnapshot } });

    const textEvent: RuntimeEvent = {
      data: { delta: 'Hello' },
      protocol_version: 'runtime.v1',
      run_id: 'run-400',
      seq: 1,
      session_id: 'session-400',
      type: 'text_delta',
    };

    store.getState().handleRuntimeEvent(textEvent);
    expect(store.getState().eventsByRun['run-400']).toEqual([textEvent]);
    expect(runtimeSelectors.activeEvents(store.getState())).toEqual([textEvent]);

    const stateEvent: RuntimeEvent = {
      data: { state: 'completed' },
      protocol_version: 'runtime.v1',
      run_id: 'run-400',
      seq: 2,
      session_id: 'session-400',
      type: 'run_state',
    };

    store.getState().handleRuntimeEvent(stateEvent);
    expect(store.getState().runs['run-400']?.state).toBe('completed');
    expect(store.getState().eventsByRun['run-400']?.length).toBe(2);
  });

  it('handleRuntimeEvent deduplicates events by runId+seq to avoid replay duplication', () => {
    const store = createStore(createRuntimeStore(createMockClient()));
    const event: RuntimeEvent = {
      data: { text: 'step replay' },
      protocol_version: 'runtime.v1',
      run_id: 'run-dedup',
      seq: 1,
      session_id: 'session-1',
      type: 'step',
    };

    store.getState().handleRuntimeEvent(event);
    store.getState().handleRuntimeEvent(event); // replay duplicate
    store.getState().handleRuntimeEvent({ ...event }); // copy duplicate

    expect(store.getState().eventsByRun['run-dedup']?.length).toBe(1);
  });

  it('handleRuntimeEvent maintains strictly monotonic ascending order when events arrive out-of-order', () => {
    const store = createStore(createRuntimeStore(createMockClient()));
    const ev3: RuntimeEvent = {
      data: 'three',
      protocol_version: 'runtime.v1',
      run_id: 'run-order',
      seq: 3,
      session_id: 's-1',
      type: 'step',
    };
    const ev1: RuntimeEvent = {
      data: 'one',
      protocol_version: 'runtime.v1',
      run_id: 'run-order',
      seq: 1,
      session_id: 's-1',
      type: 'step',
    };
    const ev2: RuntimeEvent = {
      data: 'two',
      protocol_version: 'runtime.v1',
      run_id: 'run-order',
      seq: 2,
      session_id: 's-1',
      type: 'step',
    };

    store.getState().handleRuntimeEvent(ev3);
    store.getState().handleRuntimeEvent(ev1);
    store.getState().handleRuntimeEvent(ev2);

    const result = store.getState().eventsByRun['run-order'] ?? [];
    expect(result.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('handleRuntimeEvent updates payload in-place when duplicate seq has modified data', () => {
    const store = createStore(createRuntimeStore(createMockClient()));
    const initial: RuntimeEvent = {
      data: { progress: 50 },
      protocol_version: 'runtime.v1',
      run_id: 'run-update',
      seq: 1,
      session_id: 's-1',
      type: 'progress',
    };
    const updated: RuntimeEvent = {
      data: { progress: 100 },
      protocol_version: 'runtime.v1',
      run_id: 'run-update',
      seq: 1,
      session_id: 's-1',
      type: 'progress',
    };

    store.getState().handleRuntimeEvent(initial);
    expect(store.getState().eventsByRun['run-update']?.[0].data).toEqual({ progress: 50 });

    store.getState().handleRuntimeEvent(updated);
    expect(store.getState().eventsByRun['run-update']?.length).toBe(1);
    expect(store.getState().eventsByRun['run-update']?.[0].data).toEqual({ progress: 100 });
  });

  it('subscribeRun automatically uses last event seq as afterSeq for reconnection', async () => {
    const mockClient = createMockClient({
      subscribe: vi.fn().mockImplementation(async function* () {
        yield {
          data: 'resumed event',
          protocol_version: 'runtime.v1',
          run_id: 'run-resume',
          seq: 6,
          session_id: 's-1',
          type: 'step',
        };
      }),
    });

    const store = createStore(createRuntimeStore(mockClient));
    store.setState({
      eventsByRun: {
        'run-resume': [
          {
            data: 'prior event 5',
            protocol_version: 'runtime.v1',
            run_id: 'run-resume',
            seq: 5,
            session_id: 's-1',
            type: 'step',
          },
        ],
      },
    });

    await store.getState().subscribeRun('run-resume');

    expect(mockClient.subscribe).toHaveBeenCalledWith('run-resume', 5, { signal: undefined });
    expect(store.getState().eventsByRun['run-resume']?.length).toBe(2);
    expect(store.getState().eventsByRun['run-resume']?.map((e) => e.seq)).toEqual([5, 6]);
  });

  it('runtimeSelectors getLastSeqByRunId and activeLastSeq compute highest sequence number', () => {
    const store = createStore(createRuntimeStore(createMockClient()));
    store.setState({
      activeRunId: 'run-seq-test',
      eventsByRun: {
        'run-seq-test': [
          {
            data: 'a',
            protocol_version: 'runtime.v1',
            run_id: 'run-seq-test',
            seq: 10,
            session_id: 's-1',
            type: 't',
          },
          {
            data: 'b',
            protocol_version: 'runtime.v1',
            run_id: 'run-seq-test',
            seq: 20,
            session_id: 's-1',
            type: 't',
          },
        ],
      },
    });

    expect(runtimeSelectors.getLastSeqByRunId('run-seq-test')(store.getState())).toBe(20);
    expect(runtimeSelectors.activeLastSeq(store.getState())).toBe(20);
    expect(runtimeSelectors.getLastSeqByRunId('non-existent')(store.getState())).toBeUndefined();
  });

  it('subscribeRun processes streamed SSE events into store', async () => {
    const mockEvents: RuntimeEvent[] = [
      {
        data: { text: 'step 1' },
        protocol_version: 'runtime.v1',
        run_id: 'run-500',
        seq: 1,
        session_id: 'session-500',
        type: 'step',
      },
      {
        data: { state: 'completed' },
        protocol_version: 'runtime.v1',
        run_id: 'run-500',
        seq: 2,
        session_id: 'session-500',
        type: 'run_state',
      },
    ];

    const mockClient = createMockClient({
      subscribe: vi.fn().mockImplementation(async function* () {
        for (const ev of mockEvents) {
          yield ev;
        }
      }),
    });

    const store = createStore(createRuntimeStore(mockClient));
    store.setState({
      runs: {
        'run-500': {
          createdAt: '2026-08-26T00:00:00Z',
          runId: 'run-500',
          sessionId: 'session-500',
          state: 'running',
          updatedAt: '2026-08-26T00:00:00Z',
        },
      },
    });

    await store.getState().subscribeRun('run-500', 0);

    expect(store.getState().eventsByRun['run-500']).toEqual(mockEvents);
    expect(store.getState().runs['run-500']?.state).toBe('completed');
  });

  it('listPlugins and mountPlugin manage pluginStates', async () => {
    const plugins: PluginDescriptor[] = [
      { id: 'plugin-a', kind: 'capability', state: 'active', version: '1.0.0' },
      { id: 'plugin-b', kind: 'ui', state: 'installed', version: '1.0.0' },
    ];

    const mockClient = createMockClient({
      listPlugins: vi.fn().mockResolvedValue(plugins),
      mountPlugin: vi.fn().mockResolvedValue('active'),
    });

    const store = createStore(createRuntimeStore(mockClient));

    await store.getState().listPlugins();
    expect(store.getState().pluginStates).toEqual({
      'plugin-a': 'active',
      'plugin-b': 'installed',
    });

    const mounted = await store.getState().mountPlugin('plugin-b');
    expect(mounted).toBe('active');
    expect(store.getState().pluginStates['plugin-b']).toBe('active');
    expect(runtimeSelectors.getPluginState('plugin-b')(store.getState())).toBe('active');
  });

  it('clearRun and setActiveRunId modify activeRunId and state', () => {
    const store = createStore(createRuntimeStore(createMockClient()));
    store.setState({
      activeRunId: 'run-600',
      eventsByRun: { 'run-600': [] },
      runs: {
        'run-600': {
          createdAt: '2026-08-26T00:00:00Z',
          runId: 'run-600',
          sessionId: 'session-600',
          state: 'completed',
          updatedAt: '2026-08-26T00:00:00Z',
        },
      },
    });

    store.getState().clearRun('run-600');
    expect(store.getState().activeRunId).toBeNull();
    expect(store.getState().runs['run-600']).toBeUndefined();
    expect(store.getState().eventsByRun['run-600']).toBeUndefined();

    store.getState().setActiveRunId('run-700');
    expect(store.getState().activeRunId).toBe('run-700');
  });

  // --- SSE Reconnect & Resumption Tests (C-15-P) ---

  it('subscribeRun reconnects with backoff when stream fails mid-flight and resumes from highest sequence', async () => {
    let callCount = 0;
    const mockClient = createMockClient({
      subscribe: vi.fn().mockImplementation(async function* (_runId, afterSeq) {
        callCount++;
        if (callCount === 1) {
          yield {
            data: { text: 'first chunk' },
            protocol_version: 'runtime.v1',
            run_id: 'run-reconn',
            seq: 1,
            session_id: 's-1',
            type: 'text_delta',
          } as RuntimeEvent;
          yield {
            data: { text: 'second chunk' },
            protocol_version: 'runtime.v1',
            run_id: 'run-reconn',
            seq: 2,
            session_id: 's-1',
            type: 'text_delta',
          } as RuntimeEvent;
          // Simulate connection drop
          throw new Error('Connection reset by peer');
        } else {
          expect(afterSeq).toBe(2);
          yield {
            data: { state: 'completed' },
            protocol_version: 'runtime.v1',
            run_id: 'run-reconn',
            seq: 3,
            session_id: 's-1',
            type: 'run_state',
          } as RuntimeEvent;
        }
      }),
    });

    const store = createStore(createRuntimeStore(mockClient));
    store.setState({
      runs: {
        'run-reconn': {
          createdAt: '2026-08-26T00:00:00Z',
          runId: 'run-reconn',
          sessionId: 's-1',
          state: 'running',
          updatedAt: '2026-08-26T00:00:00Z',
        },
      },
    });

    await store.getState().subscribeRun('run-reconn', 0, {
      initialDelayMs: 1,
      maxDelayMs: 5,
      maxRetries: 3,
    });

    expect(callCount).toBe(2);
    expect(store.getState().eventsByRun['run-reconn']?.length).toBe(3);
    expect(store.getState().runs['run-reconn']?.state).toBe('completed');
  });

  it('subscribeRun deduplicates replayed events across reconnections', async () => {
    let callCount = 0;
    const mockClient = createMockClient({
      subscribe: vi.fn().mockImplementation(async function* () {
        callCount++;
        if (callCount === 1) {
          yield {
            data: 'part 1',
            protocol_version: 'runtime.v1',
            run_id: 'run-dup-reconn',
            seq: 1,
            session_id: 's-1',
            type: 'delta',
          } as RuntimeEvent;
          throw new Error('network hiccup');
        } else {
          // Server replays seq 1 then sends seq 2
          yield {
            data: 'part 1',
            protocol_version: 'runtime.v1',
            run_id: 'run-dup-reconn',
            seq: 1,
            session_id: 's-1',
            type: 'delta',
          } as RuntimeEvent;
          yield {
            data: { state: 'completed' },
            protocol_version: 'runtime.v1',
            run_id: 'run-dup-reconn',
            seq: 2,
            session_id: 's-1',
            type: 'run_state',
          } as RuntimeEvent;
        }
      }),
    });

    const store = createStore(createRuntimeStore(mockClient));
    store.setState({
      runs: {
        'run-dup-reconn': {
          createdAt: '2026-08-26T00:00:00Z',
          runId: 'run-dup-reconn',
          sessionId: 's-1',
          state: 'running',
          updatedAt: '2026-08-26T00:00:00Z',
        },
      },
    });

    await store.getState().subscribeRun('run-dup-reconn', undefined, {
      initialDelayMs: 1,
      maxRetries: 2,
    });

    expect(store.getState().eventsByRun['run-dup-reconn']?.length).toBe(2);
    expect(store.getState().eventsByRun['run-dup-reconn']?.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('subscribeRun stops reconnecting immediately when run enters completed terminal state', async () => {
    let subscribeCalls = 0;
    const mockClient = createMockClient({
      subscribe: vi.fn().mockImplementation(async function* () {
        subscribeCalls++;
        yield {
          data: { state: 'completed' },
          protocol_version: 'runtime.v1',
          run_id: 'run-term',
          seq: 1,
          session_id: 's-1',
          type: 'run_state',
        } as RuntimeEvent;
      }),
    });

    const store = createStore(createRuntimeStore(mockClient));
    store.setState({
      runs: {
        'run-term': {
          createdAt: '2026-08-26T00:00:00Z',
          runId: 'run-term',
          sessionId: 's-1',
          state: 'running',
          updatedAt: '2026-08-26T00:00:00Z',
        },
      },
    });

    await store.getState().subscribeRun('run-term', 0);
    expect(subscribeCalls).toBe(1);
    expect(store.getState().runs['run-term']?.state).toBe('completed');
  });

  it('subscribeRun stops reconnecting immediately when run enters failed or cancelled terminal state', async () => {
    let subscribeCalls = 0;
    const mockClient = createMockClient({
      subscribe: vi.fn().mockImplementation(async function* () {
        subscribeCalls++;
        yield {
          data: { state: 'failed' },
          protocol_version: 'runtime.v1',
          run_id: 'run-fail-term',
          seq: 1,
          session_id: 's-1',
          type: 'run_state',
        } as RuntimeEvent;
      }),
    });

    const store = createStore(createRuntimeStore(mockClient));
    store.setState({
      runs: {
        'run-fail-term': {
          createdAt: '2026-08-26T00:00:00Z',
          runId: 'run-fail-term',
          sessionId: 's-1',
          state: 'running',
          updatedAt: '2026-08-26T00:00:00Z',
        },
      },
    });

    await store.getState().subscribeRun('run-fail-term');
    expect(subscribeCalls).toBe(1);
    expect(store.getState().runs['run-fail-term']?.state).toBe('failed');
  });

  it('subscribeRun aborts and stops reconnecting immediately when AbortSignal triggers', async () => {
    const controller = new AbortController();
    let attempts = 0;

    const mockClient = createMockClient({
      subscribe: vi.fn().mockImplementation(
        // eslint-disable-next-line require-yield -- abort-on-subscribe is the behavior under test
        async function* () {
          attempts++;
          controller.abort();
          throw new Error('Simulated abort error');
        },
      ),
    });

    const store = createStore(createRuntimeStore(mockClient));
    store.setState({
      runs: {
        'run-abort': {
          createdAt: '2026-08-26T00:00:00Z',
          runId: 'run-abort',
          sessionId: 's-1',
          state: 'running',
          updatedAt: '2026-08-26T00:00:00Z',
        },
      },
    });

    await store.getState().subscribeRun('run-abort', 0, {
      initialDelayMs: 1,
      maxRetries: 5,
      signal: controller.signal,
    });

    expect(attempts).toBe(1);
    expect(store.getState().runs['run-abort']?.state).toBe('running');
  });

  it('subscribeRun respects maxRetries and throws final error after exhausting attempts without faking completion', async () => {
    let attempts = 0;
    const mockClient = createMockClient({
      // eslint-disable-next-line require-yield -- throw-on-subscribe is the behavior under test
      subscribe: vi.fn().mockImplementation(async function* () {
        attempts++;
        throw new Error('503 Service Unavailable');
      }),
    });

    const store = createStore(createRuntimeStore(mockClient));
    store.setState({
      runs: {
        'run-exhaust': {
          createdAt: '2026-08-26T00:00:00Z',
          runId: 'run-exhaust',
          sessionId: 's-1',
          state: 'running',
          updatedAt: '2026-08-26T00:00:00Z',
        },
      },
    });

    await expect(
      store.getState().subscribeRun('run-exhaust', 0, {
        initialDelayMs: 1,
        maxRetries: 2,
      }),
    ).rejects.toThrow('503 Service Unavailable');

    expect(attempts).toBe(3); // 1 initial + 2 retries
    expect(store.getState().runs['run-exhaust']?.state).toBe('running'); // not faked as completed
  });

  it('subscribeRun handles unexpected clean stream ends and reconnects with highest seq', async () => {
    let attempts = 0;
    const mockClient = createMockClient({
      subscribe: vi.fn().mockImplementation(async function* (_runId, afterSeq) {
        attempts++;
        if (attempts === 1) {
          yield {
            data: 'part a',
            protocol_version: 'runtime.v1',
            run_id: 'run-clean-end',
            seq: 10,
            session_id: 's-1',
            type: 'step',
          } as RuntimeEvent;
          // Stream ends cleanly without error, but run is still 'running'
        } else {
          expect(afterSeq).toBe(10);
          yield {
            data: { state: 'completed' },
            protocol_version: 'runtime.v1',
            run_id: 'run-clean-end',
            seq: 11,
            session_id: 's-1',
            type: 'run_state',
          } as RuntimeEvent;
        }
      }),
    });

    const store = createStore(createRuntimeStore(mockClient));
    store.setState({
      runs: {
        'run-clean-end': {
          createdAt: '2026-08-26T00:00:00Z',
          runId: 'run-clean-end',
          sessionId: 's-1',
          state: 'running',
          updatedAt: '2026-08-26T00:00:00Z',
        },
      },
    });

    await store.getState().subscribeRun('run-clean-end', undefined, {
      initialDelayMs: 1,
      maxRetries: 2,
    });

    expect(attempts).toBe(2);
    expect(store.getState().runs['run-clean-end']?.state).toBe('completed');
    expect(store.getState().eventsByRun['run-clean-end']?.length).toBe(2);
  });

  it('subscribeRun does not reconnect when run is already in terminal state prior to subscribing', async () => {
    const mockClient = createMockClient();
    const store = createStore(createRuntimeStore(mockClient));
    store.setState({
      runs: {
        'run-already-done': {
          createdAt: '2026-08-26T00:00:00Z',
          runId: 'run-already-done',
          sessionId: 's-1',
          state: 'completed',
          updatedAt: '2026-08-26T00:00:00Z',
        },
      },
    });

    await store.getState().subscribeRun('run-already-done');
    expect(mockClient.subscribe).not.toHaveBeenCalled();
  });
});
