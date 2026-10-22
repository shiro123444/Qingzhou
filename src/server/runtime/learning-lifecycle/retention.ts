import type { HarnessScopeState } from '../improvement/contracts';

/** Unknown dispatches, validation-pending results, live behavior and referenced evidence are retained. */
export function pruneHarnessHistory(
  state: HarnessScopeState,
  protectedIds: Set<string>,
  now = Date.now(),
  days = 90,
) {
  if (!Number.isInteger(days) || days < 30 || days > 3650)
    throw new Error('LEARNING_RETENTION_INVALID');
  const retained = new Set([
    state.sourceRevisionId,
    state.active?.revisionId,
    state.active?.sourceRevisionId,
    ...protectedIds,
  ]);
  for (const item of state.decisions) if (item.revisionId) retained.add(item.revisionId);
  for (const capture of state.learning ?? [])
    for (const ref of capture.episode.configurationRefs) retained.add(ref);
  const expired = new Set<string>();
  for (const experiment of Object.values(state.experiments)) {
    if (
      !experiment.createdAt ||
      !Number.isFinite(Date.parse(experiment.createdAt)) ||
      now - Date.parse(experiment.createdAt) < days * 86_400_000
    )
      continue;
    if (retained.has(experiment.candidateId) || retained.has(experiment.id)) continue;
    if (
      !['failed', 'cancelled', 'registered'].includes(experiment.status) ||
      experiment.attempts.some((a) => a.status !== 'completed' || !a.receipt)
    )
      continue;
    expired.add(experiment.id);
    delete state.experiments[experiment.id];
  }
  state.episodes = state.episodes.filter((episode) => !expired.has(episode.evidenceRef));
  for (const experiment of Object.values(state.experiments)) {
    retained.add(experiment.baselineId);
    retained.add(experiment.candidateId);
  }
  for (const episode of state.episodes)
    for (const id of episode.configurationRefs) retained.add(id);
  for (const proposal of state.instructionProposals ?? []) retained.add(proposal.baselineId);
  for (const id of Object.keys(state.revisions)) if (!retained.has(id)) delete state.revisions[id];
  return expired.size;
}
