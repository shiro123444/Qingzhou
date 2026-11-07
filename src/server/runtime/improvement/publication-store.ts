import { randomUUID } from 'node:crypto';

import {
  harnessDigest,
  type HarnessRevision,
  type HarnessScope,
  verifyHarnessRevision,
} from '@lobechat/agent-runtime';
import type { OperationSkillSet } from '@lobechat/context-engine';
import type { LobeChatDatabase } from '@lobechat/database';
import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';

import { AgentDocumentModel } from '@/database/models/agentDocuments';
import { agentHarnessDecisions, agentHarnessHeads, agents } from '@/database/schemas';
import { managedSkillIdentifier } from '@/server/services/agentRuntime/managedSkills';
import {
  isAgentSignalEnabledForUser,
  isLobeAiAgentSlug,
} from '@/server/services/agentSignal/featureGate';

import { DatabaseLearningBudget } from './budget-store';
import { LearningCommands } from './learning-commands';
import { assertMutationAuthority, type MutationAuthority } from './mutation-authority';
import {
  assertPublicationProof,
  type HarnessPublicationPort,
  type HarnessSelection,
  type PublicationCommand,
  type PublicationDecision,
  type PublicationEvent,
  type PublicationHead,
  type PublicationProof,
} from './publication';
import { readCurrentHarnessSource } from './source';

const owned = (scope: HarnessScope) =>
  and(eq(agentHarnessHeads.userId, scope.userId), eq(agentHarnessHeads.agentId, scope.agentId));
const commandKey = (scope: HarnessScope, id: string) =>
  and(
    eq(agentHarnessDecisions.userId, scope.userId),
    eq(agentHarnessDecisions.agentId, scope.agentId),
    eq(agentHarnessDecisions.requestId, id),
  );

export class DatabaseHarnessPublication implements HarnessPublicationPort {
  constructor(
    readonly db: LobeChatDatabase,
    private readonly readSource = readCurrentHarnessSource,
    private readonly experiences = new LearningCommands(),
  ) {}

  currentSource(scope: HarnessScope) {
    return this.readSource(this.db, scope.userId, scope.agentId);
  }

  async decisions(scope: HarnessScope): Promise<PublicationDecision[]> {
    const rows = await this.db
      .select({ decision: agentHarnessDecisions.decision })
      .from(agentHarnessDecisions)
      .where(
        and(
          eq(agentHarnessDecisions.userId, scope.userId),
          eq(agentHarnessDecisions.agentId, scope.agentId),
        ),
      )
      .orderBy(asc(agentHarnessDecisions.createdAt))
      .limit(128);
    return rows.map((row) => row.decision as unknown as PublicationDecision);
  }

  async replay(
    scope: HarnessScope,
    command: PublicationCommand,
    authority: MutationAuthority,
  ): Promise<PublicationDecision | undefined> {
    assertMutationAuthority(authority, scope.userId, 'user-edit');
    const [existing] = await this.db
      .select()
      .from(agentHarnessDecisions)
      .where(commandKey(scope, command.id));
    if (!existing) return;
    if (existing.commandHash !== (await harnessDigest(command)))
      throw new Error('HARNESS_DECISION_CONFLICT');
    return existing.decision as unknown as PublicationDecision;
  }

  async read(scope: HarnessScope): Promise<PublicationHead> {
    const [head] = await this.db.select().from(agentHarnessHeads).where(owned(scope));
    if (!head) return { generation: 0, cancelledExperiments: [] };
    const active = head.activeRevision as unknown as HarnessRevision | null;
    const source = head.sourceRevision as unknown as HarnessRevision | null;
    if (
      !!active !== !!head.activeRevisionId ||
      !!source !== !!head.sourceRevisionId ||
      (source && source.id !== head.sourceRevisionId) ||
      (head.generation > 0 && !head.decisionId)
    )
      throw new Error('HARNESS_PUBLICATION_CORRUPT');
    if (active) {
      await verifyHarnessRevision(active, scope);
      if (active.id !== head.activeRevisionId || !source || source.id !== head.sourceRevisionId)
        throw new Error('HARNESS_PUBLICATION_CORRUPT');
    }
    if (source) await verifyHarnessRevision(source, scope);
    return {
      generation: head.generation,
      cancelledExperiments: head.cancelledExperiments,
      decisionId: head.decisionId ?? undefined,
      active: active ?? undefined,
      source: source ?? undefined,
    };
  }

  /** No model work, artifact rendering or notification is allowed inside this transaction. */
  async commit(
    scope: HarnessScope,
    command: PublicationCommand,
    authority: MutationAuthority,
    proof?: PublicationProof,
  ): Promise<PublicationDecision> {
    assertMutationAuthority(authority, scope.userId, 'user-edit');
    if (
      !Number.isSafeInteger(command.expectedGeneration) ||
      command.expectedGeneration < 0 ||
      !['adopt', 'keep', 'rollback'].includes(command.action) ||
      !command.id.trim()
    )
      throw new Error('HARNESS_INVALID_COMMAND');
    const commandHash = await harnessDigest(command);
    try {
      return await this.db.transaction(
        async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
          await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
          assertMutationAuthority(authority, scope.userId, 'user-edit');
          // The same row lock is taken by ordinary author configuration updates.
          const [agent] = await tx
            .select()
            .from(agents)
            .where(and(eq(agents.id, scope.agentId), eq(agents.userId, scope.userId)))
            .for('update');
          if (!agent) throw new Error('HARNESS_SCOPE_NOT_FOUND');
          await tx.insert(agentHarnessHeads).values(scope).onConflictDoNothing();
          const [head] = await tx
            .select()
            .from(agentHarnessHeads)
            .where(owned(scope))
            .for('update');
          const [replay] = await tx
            .select()
            .from(agentHarnessDecisions)
            .where(commandKey(scope, command.id));
          if (replay) {
            if (replay.commandHash !== commandHash) throw new Error('HARNESS_DECISION_CONFLICT');
            return replay.decision as unknown as PublicationDecision;
          }
          if (command.action !== 'rollback') {
            if (!proof) throw new Error('HARNESS_PROOF_REQUIRED');
            await assertPublicationProof(scope, command, proof);
            if (head.cancelledExperiments.includes(proof.experiment.id))
              throw new Error('HARNESS_CANCELLED');
          }
          if (
            head.generation !== command.expectedGeneration ||
            (head.activeRevisionId ?? undefined) !== command.expectedActiveId
          )
            throw new Error('HARNESS_CAS_CONFLICT');
          if (command.action === 'rollback') {
            if (!head.activeRevisionId) throw new Error('HARNESS_CAS_CONFLICT');
          } else {
            if (
              process.env.QINGZHOU_HARNESS_LEARNING_ENABLED !== '1' ||
              (!isLobeAiAgentSlug(agent.slug) &&
                agent.chatConfig?.selfIteration?.enabled !== true) ||
              !(await isAgentSignalEnabledForUser(tx as unknown as LobeChatDatabase, scope.userId))
            )
              throw new Error('HARNESS_DISABLED');
            if (agent.generation !== command.expectedSourceGeneration)
              throw new Error('HARNESS_STALE_SOURCE');
            const current = await this.readSource(
              tx as unknown as LobeChatDatabase,
              scope.userId,
              scope.agentId,
            );
            if (current.id !== proof!.baseline.id) throw new Error('HARNESS_STALE_SOURCE');
            if (proof!.experiment.budgetRootId) {
              const budget = await new DatabaseLearningBudget(
                tx as unknown as LobeChatDatabase,
              ).read(
                { userId: scope.userId, subject: { kind: 'agent', agentId: scope.agentId } },
                proof!.experiment.budgetRootId,
              );
              if (budget.cancelled || budget.exhausted) throw new Error('HARNESS_CANCELLED');
            }
            if (
              ['managed.skillBody', 'context.skillMaterial'].includes(
                proof!.experiment.patch.surface,
              )
            ) {
              const skills = current.material.operationSkillSet as unknown as OperationSkillSet;
              const refs = skills.skills
                .filter(
                  (skill) =>
                    skill.revision &&
                    (proof!.experiment.patch.surface === 'context.skillMaterial' ||
                      skill.identifier ===
                        managedSkillIdentifier(proof!.experiment.patch.targetBindingId!)),
                )
                .map((skill) => skill.revision!);
              if (!refs.length) throw new Error('HARNESS_SKILL_NOT_ELIGIBLE');
              await new AgentDocumentModel(
                tx as unknown as LobeChatDatabase,
                scope.userId,
              ).assertVersions(
                refs.flatMap((ref) => [
                  {
                    id: ref.bindingId,
                    documentId: ref.resourceId,
                    agentId: scope.agentId,
                    generation: ref.generation,
                    documentGeneration: ref.documentGeneration,
                  },
                  {
                    id: ref.bundleBindingId,
                    documentId: ref.bundleResourceId,
                    agentId: scope.agentId,
                    generation: ref.bundleGeneration,
                    documentGeneration: ref.bundleDocumentGeneration,
                  },
                ]),
              );
            }
          }
          const generation = head.generation + 1;
          const active = command.action === 'adopt' ? proof!.candidate : undefined;
          const source = command.action === 'rollback' ? undefined : proof!.baseline;
          const decision: PublicationDecision = {
            id: command.id,
            action: command.action,
            at: new Date().toISOString(),
            generation,
            previousId: head.activeRevisionId ?? undefined,
            experimentId: command.experimentId,
            reason: command.reason,
            revisionId:
              command.action === 'adopt'
                ? proof!.candidate.id
                : command.action === 'keep'
                  ? proof!.baseline.id
                  : undefined,
          };
          if (proof && command.action !== 'rollback') {
            decision.learning = await this.experiences.capture({
              type: 'behavior-activation',
              scope: { userId: scope.userId, subject: { kind: 'agent', agentId: scope.agentId } },
              id: `decision:${command.id}`,
              domain: 'chat',
              evidenceRef: `publication:${command.id}`,
              configurations: [proof.baseline.material, proof.candidate.material],
              outcome: command.action === 'adopt' ? 'candidate' : 'baseline',
              validation: proof.experiment.validation,
              applicability: 'registered-text-tasks-only',
              ...(proof.experiment.budgetRootId
                ? {
                    budgetRef: {
                      scope: {
                        userId: scope.userId,
                        subject: { kind: 'agent' as const, agentId: scope.agentId },
                      },
                      rootId: proof.experiment.budgetRootId,
                      childId: 'validation',
                    },
                  }
                : {}),
              selection: {
                action: command.action,
                requestId: command.id,
                selectedIndex: command.action === 'adopt' ? 1 : 0,
                ...(command.reason ? { reason: command.reason } : {}),
              },
            });
            decision.episode = {
              schemaVersion: 1,
              id: `decision:${command.id}`,
              domain: 'chat',
              scope: { ...scope },
              baselineRevisionId: proof.baseline.id,
              candidateRevisionId: proof.candidate.id,
              configurationRefs: [proof.baseline.id, proof.candidate.id],
              evidenceRef: `publication:${command.id}`,
              outcome: command.action === 'adopt' ? 'candidate' : 'baseline',
              validation: proof.experiment.validation,
              applicability: 'registered-tasks-only',
              selection: {
                action: command.action,
                subject: 'harness',
                requestId: command.id,
                selectedRevisionId: decision.revisionId,
                ...(command.reason ? { reason: command.reason } : {}),
              },
            };
          }
          const event: PublicationEvent = {
            id: command.id,
            scope,
            action: command.action,
            generation,
            revisionId: decision.revisionId,
          };
          await tx
            .update(agentHarnessHeads)
            .set({
              generation,
              decisionId: command.id,
              activeRevisionId: active ? (active as unknown as HarnessRevision).id : null,
              activeRevision: active ? (active as unknown as Record<string, unknown>) : null,
              sourceRevisionId: source ? (source as unknown as HarnessRevision).id : null,
              sourceRevision: source ? (source as unknown as Record<string, unknown>) : null,
            })
            .where(and(owned(scope), eq(agentHarnessHeads.generation, head.generation)));
          await tx.insert(agentHarnessDecisions).values({
            ...scope,
            requestId: command.id,
            commandHash,
            decision: decision as unknown as Record<string, unknown>,
            proof: proof ? (proof as unknown as Record<string, unknown>) : null,
            event: event as unknown as Record<string, unknown>,
          });
          return decision;
        },
        { isolationLevel: 'serializable' },
      );
    } catch (error) {
      // A serialization/deadlock failure is a conflict, never an implicit retry.
      const cause = error as { cause?: { code?: string }; code?: string };
      if (['40001', '40P01', '55P03'].includes(cause.code ?? cause.cause?.code ?? '')) {
        const replay = await this.replay(scope, command, authority);
        if (replay) return replay;
        throw new Error('HARNESS_CAS_CONFLICT', { cause: error });
      }
      throw error;
    }
  }

  async resolve(source: HarnessRevision): Promise<HarnessRevision> {
    return (await this.selection(source)).revision;
  }

  /** Serialize cancellation with publication; never revoke an already committed decision. */
  async cancel(scope: HarnessScope, experimentId: string, authority: MutationAuthority) {
    assertMutationAuthority(authority, scope.userId, 'user-edit');
    await this.db.transaction(async (tx) => {
      const [agent] = await tx
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, scope.agentId), eq(agents.userId, scope.userId)))
        .for('update');
      if (!agent) throw new Error('HARNESS_SCOPE_NOT_FOUND');
      await tx.insert(agentHarnessHeads).values(scope).onConflictDoNothing();
      const [head] = await tx.select().from(agentHarnessHeads).where(owned(scope)).for('update');
      if (head.cancelledExperiments.includes(experimentId)) return;
      if (head.cancelledExperiments.length >= 128) throw new Error('HARNESS_QUOTA_EXCEEDED');
      await tx
        .update(agentHarnessHeads)
        .set({ cancelledExperiments: [...head.cancelledExperiments, experimentId] })
        .where(owned(scope));
    });
  }

  async selection(source: HarnessRevision): Promise<HarnessSelection> {
    const head = await this.read(source.scope);
    return head.source?.id === source.id && head.decisionId
      ? {
          revision: head.active ?? source,
          publicationRef: { generation: head.generation, decisionId: head.decisionId },
        }
      : { revision: source };
  }

  /** At-least-once delivery; receivers must deduplicate by scope + event ID. */
  async flushOutbox(scope: HarnessScope, deliver: (event: PublicationEvent) => Promise<void>) {
    const pending = await this.db
      .select()
      .from(agentHarnessDecisions)
      .where(
        and(
          eq(agentHarnessDecisions.userId, scope.userId),
          eq(agentHarnessDecisions.agentId, scope.agentId),
          isNull(agentHarnessDecisions.deliveredAt),
          or(
            isNull(agentHarnessDecisions.leaseUntil),
            lt(agentHarnessDecisions.leaseUntil, sql`now()`),
          ),
        ),
      )
      .orderBy(asc(agentHarnessDecisions.createdAt), asc(agentHarnessDecisions.requestId))
      .limit(16);
    for (const entry of pending) {
      const token = randomUUID();
      const [claimed] = await this.db
        .update(agentHarnessDecisions)
        .set({
          leaseToken: token,
          leaseUntil: sql`now() + interval '30 seconds'`,
          deliveryAttempts: sql`${agentHarnessDecisions.deliveryAttempts} + 1`,
        })
        .where(
          and(
            commandKey(scope, entry.requestId),
            isNull(agentHarnessDecisions.deliveredAt),
            or(
              isNull(agentHarnessDecisions.leaseUntil),
              lt(agentHarnessDecisions.leaseUntil, sql`now()`),
            ),
          ),
        )
        .returning();
      if (!claimed) continue;
      try {
        await deliver(claimed.event as unknown as PublicationEvent);
        await this.db
          .update(agentHarnessDecisions)
          .set({ deliveredAt: new Date(), deliveryError: null, leaseToken: null, leaseUntil: null })
          .where(
            and(commandKey(scope, entry.requestId), eq(agentHarnessDecisions.leaseToken, token)),
          );
      } catch {
        // Failed notification cannot undo publication or start new inference.
        await this.db
          .update(agentHarnessDecisions)
          .set({ deliveryError: 'DELIVERY_FAILED', leaseToken: null, leaseUntil: null })
          .where(
            and(commandKey(scope, entry.requestId), eq(agentHarnessDecisions.leaseToken, token)),
          );
      }
    }
  }
}
