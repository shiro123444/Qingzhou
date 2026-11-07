// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { HarnessScopeState, HarnessExperiment } from '../improvement/contracts';
import { pruneHarnessHistory } from './retention';

describe('conservative learning retention', () => {
  it('removes expired unused proposals while retaining active, selected, pending and unknown evidence', () => {
    const expired = {
      createdAt: '2025-01-01T00:00:00Z',
      baselineId: 'source',
      status: 'registered',
      attempts: [],
    } as unknown as HarnessExperiment;
    const experiments = Object.fromEntries(
      ['expired', 'active', 'published', 'running', 'unknown', 'pending'].map((id) => [
        id,
        { ...expired, id, candidateId: id },
      ]),
    );
    experiments.running.status = 'running';
    experiments.pending.status = 'completed';
    experiments.pending.validation = 'pending';
    experiments.unknown.status = 'failed';
    experiments.unknown.attempts = [{ status: 'reserved' } as any];
    const state = {
      schemaVersion: 1,
      scope: { userId: 'user', agentId: 'agent' },
      sourceRevisionId: 'source',
      active: { revisionId: 'active', sourceRevisionId: 'source' },
      experiments,
      decisions: [],
      episodes: [],
      revisions: Object.fromEntries(
        ['source', ...Object.keys(experiments)].map((id) => [id, { id }]),
      ),
    } as unknown as HarnessScopeState;
    expect(pruneHarnessHistory(state, new Set(['published']), Date.parse('2026-10-22'))).toBe(1);
    expect(Object.keys(state.experiments)).toEqual([
      'active',
      'published',
      'running',
      'unknown',
      'pending',
    ]);
    expect(state.revisions.expired).toBeUndefined();
    expect(state.revisions.source).toBeDefined();
  });
  it('refuses an unsafe retention duration', () => {
    expect(() => pruneHarnessHistory({} as any, new Set(), Date.now(), 1)).toThrow(
      'LEARNING_RETENTION_INVALID',
    );
  });
});
