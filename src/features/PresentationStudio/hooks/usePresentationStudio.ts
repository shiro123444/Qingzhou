import { useCallback, useEffect, useMemo } from 'react';

import type { PresentationStudioStoreHook } from '../store/presentationStore';
import { useJobPolling, type UseJobPollingOptions } from './useJobPolling';

export interface UsePresentationStudioOptions {
  /** Stream reconnect backoff tuning (C-64/66). */
  backoffBaseMs?: UseJobPollingOptions['backoffBaseMs'];
  /** Job ids persisted on the backend that should be restored on mount. */
  initialJobIds?: string[];
  maxReconnectAttempts?: UseJobPollingOptions['maxReconnectAttempts'];
  pollIntervalMs?: number;
  wait?: UseJobPollingOptions['wait'];
}

/**
 * Wires a PresentationStudio store into a mounted view: restores initial jobs
 * once, then keeps active jobs polled. The transport is the store's injectable
 * client — this hook never touches the network directly. It also keeps the
 * selected artifact anchored to the selected job's artifact list when the list
 * changes under us (e.g. after a poll reveals new artifacts).
 */
export const usePresentationStudio = (
  store: PresentationStudioStoreHook,
  { initialJobIds, pollIntervalMs = 2500, ...streamOptions }: UsePresentationStudioOptions = {},
) => {
  const initialJobIdsKey = initialJobIds === undefined ? undefined : JSON.stringify(initialJobIds);
  // Explicit deep links resume one work. A bare /presentation restores the
  // history list without selecting the previous work, so creation always opens
  // on a clean canvas.
  const effectiveJobIds = useMemo(() => {
    if (initialJobIdsKey !== undefined) return JSON.parse(initialJobIdsKey) as string[];
    if (typeof window !== 'undefined') {
      try {
        const paramId = new URLSearchParams(window.location.search).get('jobId');
        if (paramId) return [paramId];
      } catch {}
    }
    return [];
  }, [initialJobIdsKey]);

  const initialLoading = store((s) => s.initialLoading);

  useEffect(() => {
    let disposed = false;
    store.getState().setInitialLoading(true);
    const restore = async () => {
      try {
        await store.getState().restoreJobList();
        const targets = effectiveJobIds;
        for (const jobId of targets) {
          if (disposed) return;

          // C-112-04: Restore highest seq before streaming if available
          if (typeof window !== 'undefined' && window.sessionStorage) {
            try {
              const storedSeq = window.sessionStorage.getItem(
                `presentation_studio_last_seq_${jobId}`,
              );
              if (storedSeq && !store.getState().lastSeqByJob[jobId]) {
                store.setState((s) => ({
                  lastSeqByJob: {
                    ...s.lastSeqByJob,
                    [jobId]: Math.max(Number(storedSeq), s.lastSeqByJob[jobId] ?? 0),
                  },
                }));
              }
            } catch {}
          }

          await store.getState().refreshJob(jobId);
          // Select the first restored job when nothing is selected yet (C-80):
          // the artifact panel only renders for a selected job, so a restored
          // session must land with a usable selection without fabricating one.
          const state = store.getState();
          if (!state.selectedJobId && state.jobs[jobId]) {
            state.selectJob(jobId);
          }
          // Hydrate the restored job's artifacts immediately (C-80): completed
          // jobs expose artifactIds, and waiting for the first poll tick left the
          // artifact panel empty after a synchronous restore. Each snapshot is
          // fetched individually — a single failure never fabricates an artifact.
          await store.getState().refreshArtifacts(jobId);
        }
      } finally {
        // A rejected restore must not strand the restoring spinner: whatever went wrong,
        // the studio either shows restored works or the honest empty state.
        if (!disposed) store.getState().setInitialLoading(false);
      }
    };
    void restore();

    return () => {
      disposed = true;
      store.getState().setInitialLoading(false);
    };
  }, [effectiveJobIds, store]);

  // C-112-04: 先恢复状态再订阅增量事件 (only enable polling/streaming after initial loading completes)
  useJobPolling(store, { enabled: !initialLoading, pollIntervalMs, ...streamOptions });

  const selectArtifact = useCallback(store.getState().selectArtifact, [store]);

  useEffect(() => {
    const unsubscribe = store.subscribe((state) => {
      const job = state.selectedJobId ? state.jobs[state.selectedJobId] : undefined;
      const ids = job?.artifactIds ?? [];
      if (ids.length === 0 || ids.includes(state.selectedArtifactId ?? '')) return;

      const selected = state.selectedArtifactId
        ? state.artifacts[state.selectedArtifactId]
        : undefined;
      const candidates = ids.map((id) => state.artifacts[id]).filter(Boolean);
      const slideId = selected?.metadata?.slideId;
      const slideNumber = selected?.metadata?.slideNumber;
      const matchingSlide =
        (slideId !== undefined
          ? candidates.find((artifact) => artifact.metadata?.slideId === slideId)
          : undefined) ??
        (slideNumber !== undefined
          ? candidates.find((artifact) => artifact.metadata?.slideNumber === slideNumber)
          : undefined);
      if (matchingSlide) {
        selectArtifact(matchingSlide.artifactId);
        return;
      }

      // A new version announces its ids before all snapshots are fetched.
      // Keep the old page identity until its replacement can be resolved.
      if (
        selected &&
        (candidates.length < ids.length || job?.state === 'running' || job?.state === 'queued')
      )
        return;
      selectArtifact(ids[0]);
    });
    return unsubscribe;
  }, [selectArtifact, store]);
};
