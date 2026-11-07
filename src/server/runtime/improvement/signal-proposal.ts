import { harnessData, harnessDigest, type HarnessScope } from '@lobechat/agent-runtime';

import type { HarnessProposalPort } from './contracts';
import { applyHarnessPatch } from './coordinator';
import { withHarnessCoordinator } from './production';

/** Source-bound AgentSignal adapter: only visible evidence and the authoring surface are exposed.
 * Heldout tasks, model scores, credentials and private configuration are never proposer context.
 */
export function createSignalHarnessProposals(input: {
  scope: HarnessScope;
  sourceId: string;
  evidence: (ids: string[]) => Promise<unknown>;
}): HarnessProposalPort | undefined {
  if (process.env.QINGZHOU_HARNESS_LEARNING_ENABLED !== '1') return;
  return {
    readSource: () =>
      withHarnessCoordinator(async (c) => {
        const state = await c.store.read(input.scope);
        const base = state.sourceRevisionId && state.revisions[state.sourceRevisionId];
        if (!base || base.material.configurationComplete === false) return;
        return {
          baselineId: base.id,
          systemRole: (base.material.agentConfig as { systemRole?: string }).systemRole ?? '',
        };
      }),
    propose: async (proposal) => {
      if (process.env.QINGZHOU_HARNESS_LEARNING_ENABLED !== '1')
        throw new Error('HARNESS_DISABLED');
      if (
        !proposal.rationale.trim() ||
        proposal.rationale.length > 2000 ||
        !proposal.evidenceIds.length ||
        proposal.evidenceIds.length > 12 ||
        proposal.evidenceIds.some((id) => !id.trim() || id.length > 256)
      )
        throw new Error('HARNESS_INVALID_EVIDENCE');
      const evidence = harnessData(await input.evidence(proposal.evidenceIds));
      const id = `proposal-${await harnessDigest([input.scope, input.sourceId, proposal, evidence])}`;
      return withHarnessCoordinator((c) =>
        c.store.transaction(input.scope, async (state, save) => {
          const base = state.revisions[proposal.baselineId];
          if (
            !base ||
            state.sourceRevisionId !== base.id ||
            base.material.configurationComplete === false
          )
            throw new Error('HARNESS_STALE_SOURCE');
          await applyHarnessPatch(base, {
            baseRevisionId: base.id,
            surface: 'chat.systemRole',
            value: proposal.systemRole,
          });
          state.instructionProposals ??= [];
          if (!state.instructionProposals.some((entry) => entry.id === id)) {
            state.instructionProposals.push({
              id,
              sourceId: input.sourceId,
              baselineId: base.id,
              systemRole: proposal.systemRole,
              rationale: proposal.rationale,
              evidence,
              at: new Date().toISOString(),
            });
            await save();
          }
          return { id, status: 'proposed' as const };
        }),
      );
    },
  };
}
