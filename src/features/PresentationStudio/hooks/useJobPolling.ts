import { useEffect } from 'react';

import type { PresentationJob } from '../../../../packages/runtime-contracts/src';
import type { RuntimePresentationStreamClient } from '../../../services/runtime/client';
import type { PresentationStudioStoreHook } from '../store/presentationStore';

/**
 * Wire event types carrying material-slot (C-87) state. Any `image.generation.*`
 * event is a slot event: it must never touch job/artifact state, and it is
 * projected through `applySlotEvent` (which validates the payload and counts
 * malformed ones as ignored).
 */
const SLOT_EVENT_PREFIX = 'image.generation.';

const isSlotEvent = (type: string): boolean => type.startsWith(SLOT_EVENT_PREFIX);

export interface UseJobPollingOptions {
  /** Base backoff delay in ms; delays are base * 2^(attempt-1). Default 1000. */
  backoffBaseMs?: number;
  /** Set false to suspend polling (tests). Default true. */
  enabled?: boolean;
  /** Max exponential-backoff reconnects after a stream break. Default 3. */
  maxReconnectAttempts?: number;
  /** Poll active (queued/running) jobs every N ms. Default 2500. */
  pollIntervalMs?: number;
  /**
   * Injectable delay seam so tests never sleep for real. Default implements a
   * cancelable setTimeout; receiving an AbortSignal rejection means the wait
   * was canceled and no further reconnect may happen.
   */
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

const isActiveState = (state: string): boolean => state === 'queued' || state === 'running';

export const defaultReconnectWait = (delayMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/** Protocol/shape errors a retry cannot fix — degrade straight to polling. */
const isUnrecoverableStreamError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes('invalid event shape') ||
    message.includes('invalid JSON') ||
    message.includes('events (404')
  );
};

const delayForAttempt = (attempt: number, baseMs: number): number =>
  baseMs * 2 ** Math.max(attempt - 1, 0);

/**
 * Keeps active presentation jobs fresh through the injectable transport (C-60).
 *
 * - When the client exposes `subscribePresentationJob`, each active job is
 *   streamed from its persisted `last seq` (`after_seq` resume). A stream break
 *   triggers bounded exponential-backoff reconnects (default 3, configurable)
 *   with each reconnect resuming from `lastSeqByJob[jobId]`; the poll loop
 *   skips jobs held by the stream loop.
 * - During reconnect the store reports `streamStatus: 'reconnecting'`. After
 *   the retry budget or an unrecoverable protocol error, the job degrades to
 *   polling — nothing is fabricated, received artifacts/seqs are preserved.
 * - AbortSignal / unmount cancels the pending wait and the reader without
 *   leaking timers.
 */
export const useJobPolling = (
  store: PresentationStudioStoreHook,
  {
    enabled = true,
    pollIntervalMs = 2500,
    maxReconnectAttempts = 3,
    backoffBaseMs = 1000,
    wait = defaultReconnectWait,
  }: UseJobPollingOptions = {},
) => {
  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    const streamControllers = new Map<string, AbortController>();
    const streamedJobs = new Set<string>();
    // Jobs whose reconnect budget is exhausted stay on polling for this
    // session; the last known seq is preserved on the store for later resume.
    const endedJobs = new Set<string>();
    const reconciledAt = new Map<string, number>(
      Object.keys(store.getState().jobs).map((jobId) => [jobId, Date.now()]),
    );

    // A terminal state can be superseded by a retry in another tab. SSE can
    // also stay connected to an old dev worker without delivering new events.
    const reconcileJob = async (jobId: string) => {
      if (disposed || store.getState().pendingActions[jobId]) return;
      reconciledAt.set(jobId, Date.now());
      await store.getState().refreshJob(jobId);
    };
    const reconcileSelected = () => {
      const jobId = store.getState().selectedJobId;
      if (jobId && document.visibilityState !== 'hidden') void reconcileJob(jobId);
    };
    window.addEventListener('focus', reconcileSelected);
    window.addEventListener('online', reconcileSelected);
    document.addEventListener('visibilitychange', reconcileSelected);

    const runStreamLoop = (
      jobId: string,
      subscribe: NonNullable<RuntimePresentationStreamClient['subscribePresentationJob']>,
    ) => {
      let attempt = 0;

      const loopAbort = new AbortController();
      streamControllers.set(jobId, loopAbort);
      streamedJobs.add(jobId);

      const onAborted = () => {
        streamControllers.delete(jobId);
        streamedJobs.delete(jobId);
      };
      loopAbort.signal.addEventListener('abort', onAborted, { once: true });

      const run = async () => {
        try {
          while (!disposed && !loopAbort.signal.aborted) {
            const afterSeq = store.getState().lastSeqByJob[jobId] ?? 0;

            try {
              store
                .getState()
                .setStreamStatusForJob(jobId, attempt === 0 ? 'live' : 'reconnecting');
              for await (const event of subscribe(jobId, {
                afterSeq,
                signal: loopAbort.signal,
              })) {
                if (disposed || loopAbort.signal.aborted) break;
                // C-90: slot events (image.generation.*) route to the slot
                // projection only — job state, artifacts and lastSeqByJob stay
                // untouched; malformed payloads count as ignoredEvents inside
                // the store, never as job state.
                if (isSlotEvent(event.type)) {
                  store
                    .getState()
                    .applySlotEvent(jobId, { data: event.data, seq: event.seq, type: event.type });
                  continue;
                }
                store.getState().applyPresentationEvent(event);
                // Recovered to live: only this job flips, other jobs untouched.
                if (store.getState().streamStatusByJob[jobId] !== 'live') {
                  store.getState().setStreamStatusForJob(jobId, 'live');
                }
                const currentJob = store.getState().jobs[jobId];
                // The store also recognizes partial ready snapshots. Hydrate
                // pages as they arrive, without waiting for the whole deck.
                if (currentJob?.artifactIds?.length) {
                  void store.getState().refreshArtifacts(jobId);
                }
              }
            } catch (err) {
              // A stream failure triggers reconnect attempts below; the last
              // seen event stays applied and no completion is fabricated.
              if (disposed || loopAbort.signal.aborted) break;
              if (isUnrecoverableStreamError(err)) {
                attempt = maxReconnectAttempts + 1; // skip the remaining budget
              }
            }

            if (disposed || loopAbort.signal.aborted) break;

            const state = store.getState().jobs[jobId]?.state ?? '';
            if (!isActiveState(state)) {
              // The job reached a terminal state while the stream was down:
              // nothing to resume — polling will fetch the authoritative state.
              store.getState().setStreamStatusForJob(jobId, null);
              break;
            }

            if (attempt >= maxReconnectAttempts) {
              // Budget exhausted: degrade to polling, keep seq/artifacts.
              store.getState().setStreamStatusForJob(jobId, 'polling');
              endedJobs.add(jobId);
              break;
            }

            attempt += 1;
            store.getState().setStreamStatusForJob(jobId, 'reconnecting');
            try {
              await wait(delayForAttempt(attempt, backoffBaseMs), loopAbort.signal);
            } catch {
              break; // canceled during the backoff wait
            }
          }
        } finally {
          if (!disposed && !loopAbort.signal.aborted) {
            streamControllers.delete(jobId);
            streamedJobs.delete(jobId);
          }
        }
      };

      void run();
      return () => {
        loopAbort.abort();
      };
    };

    const jobStreams = new Map<string, () => void>();

    const tick = async () => {
      if (disposed) return;

      const state = store.getState();
      const subscribe = state.presentationClient?.subscribePresentationJob?.bind(
        state.presentationClient,
      );
      const activeJobIds = Object.values(state.jobs)
        .filter((job): job is PresentationJob =>
          Boolean(job && job.state && isActiveState(job.state)),
        )
        .map((job) => job.jobId);

      // Live event stream path (with bounded reconnect inside the loop).
      if (subscribe) {
        for (const jobId of activeJobIds) {
          if (disposed) return;
          if (!streamedJobs.has(jobId) && !endedJobs.has(jobId)) {
            jobStreams.set(jobId, runStreamLoop(jobId, subscribe));
          }
        }
      } else {
        // No stream seam available: per-job polling degrade, keep last seq.
        for (const jobId of activeJobIds) {
          store.getState().setStreamStatusForJob(jobId, 'polling');
        }
      }

      // Terminal jobs (completed/failed/cancelled) drop their per-job status;
      // other jobs' statuses are never touched.
      for (const job of Object.values(state.jobs)) {
        if (!job || !job.state || isActiveState(job.state)) continue;
        if (store.getState().streamStatusByJob[job.jobId] != null) {
          store.getState().setStreamStatusForJob(job.jobId, null);
        }
      }

      // Polling fallback for jobs without an active stream.
      const fallbackJobs = activeJobIds.filter((jobId) => !streamedJobs.has(jobId));
      for (const jobId of fallbackJobs) {
        if (disposed) break;
        await store.getState().refreshJob(jobId);
      }

      // Reconcile only the visible work and live jobs, not the whole history.
      // Keep this slower than event delivery; it is a safety net, not progress.
      const monitored = new Set([
        ...streamedJobs,
        ...(state.selectedJobId ? [state.selectedJobId] : []),
      ]);
      if (document.visibilityState !== 'hidden') {
        for (const jobId of monitored) {
          if (!reconciledAt.has(jobId)) reconciledAt.set(jobId, Date.now());
          if (Date.now() - reconciledAt.get(jobId)! >= 15_000) await reconcileJob(jobId);
        }
      }

      if (disposed) return;

      // Completed jobs expose artifactIds; fetch snapshots until all known.
      const refreshed = store.getState();
      for (const job of Object.values(refreshed.jobs)) {
        if (!job || !job.state || job.state !== 'completed') continue;
        const ids = job.artifactIds ?? [];
        if (ids.length > 0) {
          await refreshed.refreshArtifacts(job.jobId);
        }
      }
    };

    const timer = setInterval(() => void tick(), pollIntervalMs);
    void tick();

    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('focus', reconcileSelected);
      window.removeEventListener('online', reconcileSelected);
      document.removeEventListener('visibilitychange', reconcileSelected);
      for (const cancel of jobStreams.values()) {
        cancel();
      }
      jobStreams.clear();
      streamControllers.clear();
      streamedJobs.clear();
    };
  }, [backoffBaseMs, enabled, maxReconnectAttempts, pollIntervalMs, store, wait]);
};
