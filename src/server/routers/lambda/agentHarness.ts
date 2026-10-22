import { harnessDigest } from '@lobechat/agent-runtime';
import type { OperationSkillSet } from '@lobechat/context-engine';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { AgentModel } from '@/database/models/agent';
import { authedProcedure, router } from '@/libs/trpc/lambda';
import { serverDatabase } from '@/libs/trpc/lambda/middleware';
import { initModelRuntimeFromDB } from '@/server/modules/ModelRuntime';
import { createChatProbePort } from '@/server/runtime/improvement/chat-probe';
import {
  promptStrategies,
  type PromptStrategy,
  promptStrategyOptions,
} from '@/server/runtime/improvement/context-strategy';
import { userMutationAuthority } from '@/server/runtime/improvement/mutation-authority';
import {
  openLearningBudget,
  withHarnessCoordinator,
  withHarnessPublication,
  withLearningBudget,
} from '@/server/runtime/improvement/production';
import { preparePublication, validationDigest } from '@/server/runtime/improvement/publication';
import {
  skillMaterialBinding,
  skillMaterialRegistry,
} from '@/server/runtime/improvement/skill-material';
import {
  managedSkillBody,
  managedSkillIdentifier,
} from '@/server/services/agentRuntime/managedSkills';
import {
  isAgentSignalEnabledForUser,
  isLobeAiAgentSlug,
} from '@/server/services/agentSignal/featureGate';

const scopeInput = z.object({ agentId: z.string().min(1).max(256) });
const procedure = authedProcedure.use(serverDatabase);
function publicationError(error: unknown): never {
  if (error instanceof Error) {
    if (
      [
        'HARNESS_CAS_CONFLICT',
        'HARNESS_DECISION_CONFLICT',
        'HARNESS_STALE_SOURCE',
        'HARNESS_STALE_VALIDATION',
        'HARNESS_CANCELLED',
      ].includes(error.message)
    )
      throw new TRPCError({ code: 'CONFLICT', message: error.message, cause: error });
    if (['HARNESS_AUTHORITY_REQUIRED', 'HARNESS_DISABLED'].includes(error.message))
      throw new TRPCError({ code: 'FORBIDDEN', message: error.message, cause: error });
    if (
      [
        'HARNESS_SOURCE_RECAPTURE_REQUIRED',
        'HARNESS_EXPERIMENT_INCOMPLETE',
        'HARNESS_NOT_VALIDATED',
        'HARNESS_SKILL_NOT_ELIGIBLE',
        'HARNESS_INVALID_SKILL_BODY',
        'HARNESS_INVALID_SURFACE',
      ].includes(error.message)
    )
      throw new TRPCError({ code: 'BAD_REQUEST', message: error.message, cause: error });
  }
  throw error;
}
const budget = z
  .object({
    calls: z.number().int(),
    inputBytesPerCall: z.number().int(),
    outputTokensPerCall: z.number().int(),
    deadlineMs: z.number().int(),
    tokens: z.number().int(),
    costMicros: z.number().int(),
    costMicrosPerCall: z.number().int(),
  })
  .strict();
const task = z
  .object({ id: z.string().min(1).max(128), prompt: z.string().min(1).max(8000) })
  .strict();

export const agentHarnessRouter = router({
  resolveClient: procedure
    .input(scopeInput.extend({ systemRole: z.string(), model: z.string(), provider: z.string() }))
    .query(async ({ ctx, input }) => {
      const agent = await new AgentModel(ctx.serverDB, ctx.userId).getAgentConfig(input.agentId);
      if (!agent) return null;
      return withHarnessPublication(ctx.serverDB, async (publication) => {
        const scope = { userId: ctx.userId, agentId: agent.id };
        const head = await publication.read(scope);
        const source = head.source;
        const active = head.active;
        if (!source || !active || (await publication.currentSource(scope)).id !== source.id)
          return null;
        // The legacy client projection carries author instructions only, not pinned skill material.
        if (
          (await harnessDigest(active.material.operationSkillSet ?? null)) !==
          (await harnessDigest(source.material.operationSkillSet ?? null))
        )
          return null;
        if (
          (await harnessDigest(skillMaterialBinding(active.material.contextPolicy))) !==
          (await harnessDigest(skillMaterialBinding(source.material.contextPolicy)))
        )
          return null;
        const sourceConfig = source?.material.agentConfig as Record<string, unknown> | undefined;
        const model = source?.material.modelRuntimeConfig as Record<string, unknown> | undefined;
        if (
          !active ||
          (agent.systemRole ?? '') !==
            (source?.material.authoringSystemRole ?? sourceConfig?.systemRole ?? '') ||
          input.systemRole !== (sourceConfig?.systemRole ?? '') ||
          input.model !== model?.model ||
          input.provider !== model?.provider
        )
          return null;
        const strategy =
          (active.material.contextPolicy as { promptStrategy?: PromptStrategy } | undefined)
            ?.promptStrategy ?? 'standard';
        if (!Object.hasOwn(promptStrategies, strategy)) return null;
        return {
          revisionId: active.id,
          systemRole: promptStrategies[strategy](
            (active.material.agentConfig as Record<string, unknown>).systemRole as string,
          ),
        };
      });
    }),
  get: procedure.input(scopeInput).query(async ({ ctx, input }) => {
    const agent = await new AgentModel(ctx.serverDB, ctx.userId).getAgentConfig(input.agentId);
    if (!agent) throw new TRPCError({ code: 'NOT_FOUND' });
    const enabled =
      process.env.QINGZHOU_HARNESS_LEARNING_ENABLED === '1' &&
      (isLobeAiAgentSlug(agent.slug) || agent.chatConfig?.selfIteration?.enabled === true) &&
      (await isAgentSignalEnabledForUser(ctx.serverDB, ctx.userId));
    return withHarnessCoordinator(async (c) => {
      const state = await c.store.read({ userId: ctx.userId, agentId: agent.id });
      const scope = { userId: ctx.userId, agentId: agent.id };
      const publication = await withHarnessPublication(ctx.serverDB, async (p) => ({
        head: await p.read(scope),
        decisions: await p.decisions(scope),
        current: await p.currentSource(scope),
      }));
      const source = state.sourceRevisionId && state.revisions[state.sourceRevisionId];
      return {
        enabled,
        contextStrategies: promptStrategyOptions,
        skillMaterialProviders: skillMaterialRegistry.options(),
        state: {
          ...state,
          active:
            publication.head.active && publication.head.source
              ? {
                  revisionId: publication.head.active.id,
                  sourceRevisionId: publication.head.source.id,
                }
              : undefined,
          publicationGeneration: publication.head.generation,
          managedSkills: source
            ? (
                (source.material.operationSkillSet as unknown as OperationSkillSet)?.skills ?? []
              ).flatMap((skill) =>
                skill.revision && skill.content
                  ? [
                      {
                        bindingId: skill.revision.bindingId,
                        name: skill.revision.name,
                        identifier: skill.identifier,
                        body: managedSkillBody(skill.content),
                      },
                    ]
                  : [],
              )
            : [],
          sourceCurrent:
            publication.current?.id === state.sourceRevisionId && !!state.sourceRevisionId,
          activeCurrent:
            publication.head.source?.id === publication.current?.id && !!publication.head.active,
          sourceGeneration: source
            ? ((source.material.agentConfig as { generation?: number }).generation ?? 0)
            : 0,
          learning: state.learning?.map((capture) => capture.episode),
          decisions: [
            ...state.decisions,
            ...publication.decisions.map(({ learning, ...decision }) => ({
              ...decision,
              learning: learning?.episode,
            })),
          ],
          episodes: [
            ...state.episodes,
            ...publication.decisions.flatMap((decision) =>
              decision.episode ? [decision.episode] : [],
            ),
          ],
          revisions: {},
          experiments: Object.fromEntries(
            await Promise.all(
              Object.entries(state.experiments).map(
                async ([id, experiment]) =>
                  [
                    id,
                    {
                      ...experiment,
                      materialBaselineProvider:
                        experiment.patch.surface === 'context.skillMaterial'
                          ? (() => {
                              const binding = skillMaterialBinding(
                                state.revisions[experiment.baselineId]?.material.contextPolicy,
                              );
                              return `${binding.manifest.id}@${binding.manifest.implementationVersion}`;
                            })()
                          : undefined,
                      skillBaselineBody:
                        experiment.patch.surface === 'managed.skillBody'
                          ? (() => {
                              const skills = state.revisions[experiment.baselineId]?.material
                                .operationSkillSet as unknown as OperationSkillSet | undefined;
                              const content = skills?.skills.find(
                                (skill) =>
                                  skill.identifier ===
                                  managedSkillIdentifier(experiment.patch.targetBindingId!),
                              )?.content;
                              return content ? managedSkillBody(content) : undefined;
                            })()
                          : undefined,
                      cancelRequested: publication.head.cancelledExperiments.includes(
                        experiment.id,
                      ),
                      validationDigest: await validationDigest(experiment),
                      attempts: experiment.attempts.map((attempt) => ({
                        ...attempt,
                        receipt: attempt.receipt
                          ? { ...attempt.receipt, context: undefined }
                          : undefined,
                      })),
                    },
                  ] as const,
              ),
            ),
          ),
          intents: state.intents?.map((intent) => ({ ...intent, material: undefined })),
          instructionProposals: state.instructionProposals?.map((proposal) => ({
            ...proposal,
            evidence: undefined,
          })),
        },
      };
    });
  }),
  command: procedure
    .input(
      scopeInput.extend({
        command: z.discriminatedUnion('action', [
          z.object({
            action: z.literal('propose'),
            baselineId: z.string(),
            systemRole: z.string().min(1).max(12000),
            surface: z
              .enum([
                'chat.systemRole',
                'chat.contextStrategy',
                'managed.skillBody',
                'context.skillMaterial',
              ])
              .optional(),
            targetBindingId: z.string().uuid().optional(),
            tasks: z.array(task).min(1).max(3),
            heldout: z.array(task).min(2).max(3),
            budget,
            validationBudget: budget,
          }),
          z.object({
            action: z.enum(['run', 'validate', 'cancel']),
            experimentId: z.string().uuid(),
          }),
          z.object({
            action: z.enum(['adopt', 'keep']),
            id: z.string().uuid(),
            experimentId: z.string().uuid(),
            candidateId: z.string(),
            expectedActiveId: z.string().optional(),
            expectedGeneration: z.number().int().nonnegative(),
            expectedSourceId: z.string(),
            expectedSourceGeneration: z.number().int().nonnegative(),
            validationDigest: z.string(),
            reason: z.string().min(1).max(2000).optional(),
          }),
          z.object({
            action: z.literal('rollback'),
            id: z.string().uuid(),
            expectedActiveId: z.string(),
            expectedGeneration: z.number().int().nonnegative(),
            reason: z.string().min(1).max(2000).optional(),
          }),
        ]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const agent = await new AgentModel(ctx.serverDB, ctx.userId).getAgentConfig(input.agentId);
      if (!agent) throw new TRPCError({ code: 'NOT_FOUND' });
      const scope = { userId: ctx.userId, agentId: agent.id };
      const command = input.command;
      if (command.action === 'cancel')
        return withHarnessCoordinator(async (c) => {
          await c.store.cancel(scope, command.experimentId);
          await withLearningBudget(ctx.serverDB, async (budget) => {
            try {
              await budget.cancel(
                { userId: scope.userId, subject: { kind: 'agent', agentId: scope.agentId } },
                `chat:${command.experimentId}`,
              );
            } catch (error) {
              if (!(error instanceof Error) || error.message !== 'LEARNING_BUDGET_NOT_FOUND')
                throw error;
            }
          });
          return withHarnessPublication(ctx.serverDB, (p) =>
            p.cancel(scope, command.experimentId, userMutationAuthority(ctx.userId)),
          );
        });
      if (
        command.action === 'rollback' ||
        command.action === 'adopt' ||
        command.action === 'keep'
      ) {
        const authority = userMutationAuthority(ctx.userId);
        return withHarnessPublication(ctx.serverDB, async (publication, flush) => {
          const replay = await publication.replay(scope, command, authority);
          if (replay) {
            await flush(scope).catch(() => undefined);
            return replay;
          }
          const proof =
            command.action === 'rollback'
              ? undefined
              : await withHarnessCoordinator((c) => preparePublication(c.store, scope, command));
          const decision = await publication.commit(scope, command, authority, proof);
          await flush(scope).catch(() => undefined);
          return decision;
        }).catch(publicationError);
      }
      if (
        process.env.QINGZHOU_HARNESS_LEARNING_ENABLED !== '1' ||
        (!isLobeAiAgentSlug(agent.slug) && agent.chatConfig?.selfIteration?.enabled !== true) ||
        !(await isAgentSignalEnabledForUser(ctx.serverDB, ctx.userId))
      )
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Harness learning is disabled' });
      return withHarnessCoordinator(async (c) => {
        const current = await withHarnessPublication(ctx.serverDB, (p) => p.currentSource(scope));
        if (command.action === 'propose')
          if (current.id !== command.baselineId)
            throw new TRPCError({ code: 'CONFLICT', message: 'HARNESS_STALE_SOURCE' });
        if (command.action === 'propose')
          return c
            .propose(scope, {
              ...command,
              patch: {
                baseRevisionId: command.baselineId,
                surface: command.surface ?? 'chat.systemRole',
                ...(command.targetBindingId ? { targetBindingId: command.targetBindingId } : {}),
                value: command.systemRole,
              },
            })
            .catch(publicationError);
        const state = await c.store.read(scope);
        const experiment = state.experiments[command.experimentId];
        if (!experiment) throw new TRPCError({ code: 'NOT_FOUND' });
        const source = state.revisions[experiment.baselineId];
        const sourceConfig = source?.material.agentConfig as Record<string, unknown> | undefined;
        if (
          !source ||
          source.id !== current.id ||
          (source.material.authoringSystemRole ?? sourceConfig?.systemRole ?? '') !==
            (agent.systemRole ?? '')
        )
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Source instructions changed; run a new normal conversation first',
          });
        const model = source.material.modelRuntimeConfig as { model: string; provider: string };
        if (!model?.model || !model.provider)
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Missing pinned model binding' });
        const bindings = await withLearningBudget(ctx.serverDB, async (budget) => {
          if (!experiment.validationBudget)
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'HARNESS_BUDGET_RECAPTURE_REQUIRED',
            });
          const limit = (phase: typeof experiment.budget) => ({
            calls: phase.calls,
            tokens: phase.tokens,
            costMicros: phase.costMicros,
          });
          const probe = limit(experiment.budget),
            validation = limit(experiment.validationBudget!);
          return openLearningBudget(
            budget,
            { userId: scope.userId, subject: { kind: 'agent', agentId: scope.agentId } },
            `chat:${experiment.id}`,
            {
              calls: probe.calls + validation.calls,
              tokens: probe.tokens + validation.tokens,
              costMicros: probe.costMicros + validation.costMicros,
            },
            { probe, validation },
          );
        });
        await c.store.transaction(scope, async (state, save) => {
          state.experiments[experiment.id].budgetRootId = `chat:${experiment.id}`;
          await save();
        });
        const runtime = await initModelRuntimeFromDB(ctx.serverDB, ctx.userId, model.provider, {
          singleDispatch: true,
        });
        return c.execute(
          scope,
          command.experimentId,
          createChatProbePort({
            model: model.model,
            provider: model.provider,
            runtime,
            material: source.material,
            activatedSkillIds:
              experiment.patch.surface === 'managed.skillBody'
                ? [managedSkillIdentifier(experiment.patch.targetBindingId!)]
                : experiment.patch.surface === 'context.skillMaterial'
                  ? (
                      (source.material.operationSkillSet as unknown as OperationSkillSet)?.skills ??
                      []
                    )
                      .filter((skill) => skill.revision && skill.content)
                      .map((skill) => skill.identifier)
                  : [],
            strategy: (
              source.material.contextPolicy as { promptStrategy?: PromptStrategy } | undefined
            )?.promptStrategy,
          }),
          {
            validate: command.action === 'validate',
            learningBudget: command.action === 'validate' ? bindings.validation : bindings.probe,
          },
        );
      });
    }),
});
