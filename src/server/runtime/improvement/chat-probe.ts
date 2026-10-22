import {
  AgentRuntime,
  type AgentRuntimeContext,
  bindHarnessRun,
  GeneralChatAgent,
  resolveHarnessMaterial,
  verifyHarnessRevision,
} from '@lobechat/agent-runtime';
import {
  type AgentContextDocument,
  type OperationSkillSet,
  SkillResolver,
} from '@lobechat/context-engine';
import type { ModelRuntime } from '@lobechat/model-runtime';
import { consumeStreamUntilDone } from '@lobechat/model-runtime';

import { serverMessagesEngine } from '@/server/modules/Mecha/ContextEngineering';

import { contextStrategyComposition, type PromptStrategy } from './context-strategy';
import type { ExperimentPort, ModelReceipt } from './contracts';
import { skillMaterialBinding, type SkillMaterialRegistry } from './skill-material';

/** The ordinary AgentRuntime/Cordis plan-execute chain, with an isolated, text-only executor.
 * No message DB, AgentSignal writer, production tool dispatcher or background plugin is mounted.
 */
export function createChatProbePort(input: {
  model: string;
  provider: string;
  runtime: Pick<ModelRuntime, 'chat'>;
  strategy?: PromptStrategy;
  material?: Record<string, unknown>;
  /** A preregistered text skill is activated identically for baseline and candidate probes. */
  activatedSkillIds?: string[];
  materialRegistry?: SkillMaterialRegistry;
}): ExperimentPort {
  return {
    async complete({
      system,
      prompt,
      maxTokens,
      maxInputBytes = 131072,
      purpose = 'answer',
      revision,
      signal,
    }) {
      const receipt: ModelReceipt = { text: '' };
      // Text probes use neutral task inputs, never the originating page/task's data.
      // The behavior projection is the same one used when restoring ordinary runs.
      if (revision) await verifyHarnessRevision(revision, revision.scope);
      if (purpose === 'answer' && revision?.schemaVersion === 2) {
        const model = revision.material.modelRuntimeConfig as { model: string; provider: string };
        if (model.model !== input.model || model.provider !== input.provider)
          throw new Error('HARNESS_PROBE_MODEL_MISMATCH');
      }
      const probeMaterial =
        purpose === 'answer' && revision?.schemaVersion === 2
          ? resolveHarnessMaterial(
              await bindHarnessRun(
                revision,
                'private-probe',
                {
                  agentConfig: revision.material.agentConfig,
                  promptSegments: [{ kind: 'author', content: system }],
                },
                'probe',
              ),
            )
          : (revision?.material ?? input.material);
      const effectiveSystem =
        purpose === 'answer' && revision?.schemaVersion === 2
          ? (probeMaterial?.agentConfig as { systemRole: string }).systemRole
          : system;
      const strategy =
        (probeMaterial?.contextPolicy as { promptStrategy?: PromptStrategy } | undefined)
          ?.promptStrategy ?? input.strategy;
      const runtime = new AgentRuntime(
        new GeneralChatAgent({
          operationId: 'private-probe',
          compressionConfig: { enabled: false },
          modelRuntimeConfig: { model: input.model, provider: input.provider },
        }),
        {
          composition: contextStrategyComposition(
            purpose === 'selection' ? 'standard' : strategy,
            true,
            skillMaterialBinding(
              purpose === 'selection' ? undefined : probeMaterial?.contextPolicy,
            ),
            input.materialRegistry,
          ),
          executors: {
            call_llm: async (instruction, state) => {
              signal.throwIfAborted();
              const payloadMessages = (instruction as any).payload.messages as Array<{
                role: string;
                content: string;
              }>;
              const material = purpose === 'answer' ? probeMaterial : undefined;
              const documents = material?.agentDocuments as any[] | undefined;
              const skills = material?.operationSkillSet as OperationSkillSet | undefined;
              const activated = purpose === 'answer' ? (input.activatedSkillIds ?? []) : [];
              if (
                activated.some(
                  (id) =>
                    !skills?.skills.some((skill) => skill.identifier === id && skill.revision),
                )
              )
                throw new Error('HARNESS_SKILL_NOT_ELIGIBLE');
              const resolvedSkills = skills
                ? new SkillResolver().resolve(skills, {
                    activatedSkills: activated.map((identifier) => ({ identifier })),
                  })
                : undefined;
              const transformed = resolvedSkills
                ? await runtime.cordis.native.get('qingzhou.context.skill-material')!(
                    resolvedSkills.enabledSkills,
                    signal,
                  )
                : undefined;
              receipt.materialReceipt = transformed?.receipt;
              const messages = await serverMessagesEngine({
                model: input.model,
                provider: input.provider,
                messages: payloadMessages.filter((message) => message.role !== 'system') as any,
                systemRole: runtime.cordis.native.get('qingzhou.context.instructions')!(
                  payloadMessages
                    .filter((message) => message.role === 'system')
                    .map((message) => message.content)
                    .join('\n'),
                ),
                enableHistoryCount: false,
                capabilities: {
                  isCanUseFC: () => false,
                  isCanUseVision: () => false,
                  isCanUseVideo: () => false,
                },
                agentDocuments: documents?.map((doc) => ({
                  content: doc.content,
                  description: doc.description ?? undefined,
                  filename: doc.filename,
                  id: doc.id,
                  loadPosition: doc.policy?.context?.position || doc.policyLoadPosition,
                  loadRules: doc.loadRules,
                  policyId: doc.templateId,
                  policyLoad: doc.policyLoad,
                  policyLoadFormat: doc.policy?.context?.policyLoadFormat || doc.policyLoadFormat,
                  title: doc.title,
                })) as AgentContextDocument[] | undefined,
                skillsConfig: transformed ? { enabledSkills: transformed.skills } : undefined,
              });
              if (new TextEncoder().encode(JSON.stringify(messages)).length > maxInputBytes)
                throw new Error('HARNESS_BUDGET_EXCEEDED');
              receipt.context = messages;
              signal.throwIfAborted();
              const response = await input.runtime.chat(
                { model: input.model, stream: true, tools: [], max_tokens: maxTokens, messages },
                {
                  signal,
                  callback: {
                    onText: (text) => {
                      if (receipt.text.length + text.length > maxTokens * 32)
                        throw new Error('HARNESS_OUTPUT_LIMIT');
                      receipt.text += text;
                    },
                    onCompletion: ({ usage }) => {
                      receipt.inputTokens = usage?.totalInputTokens;
                      receipt.outputTokens = usage?.totalOutputTokens;
                      if (usage?.cost !== undefined)
                        receipt.costMicros = Math.ceil(usage.cost * 1_000_000);
                    },
                    onToolsCalling: ({ toolsCalling }) => {
                      if (toolsCalling.length) throw new Error('HARNESS_PROBE_EFFECT_DENIED');
                    },
                  },
                },
              );
              await consumeStreamUntilDone(response);
              signal.throwIfAborted();
              const newState = structuredClone(state);
              newState.messages.push({
                id: 'probe-answer',
                role: 'assistant',
                content: receipt.text,
              });
              return {
                events: [],
                newState,
                nextContext: {
                  phase: 'llm_result',
                  payload: {
                    hasToolsCalling: false,
                    result: { content: receipt.text },
                    toolsCalling: [],
                  },
                  session: {
                    messageCount: newState.messages.length,
                    sessionId: newState.operationId,
                    status: newState.status,
                    stepCount: newState.stepCount,
                  },
                } as AgentRuntimeContext,
              };
            },
          },
        },
      );
      try {
        let state = AgentRuntime.createInitialState({
          operationId: 'private-probe',
          maxSteps: 3,
          messages: [
            { id: 'system', role: 'system', content: effectiveSystem },
            { id: 'task', role: 'user', content: prompt },
          ],
        });
        let context: AgentRuntimeContext | undefined = {
          phase: 'user_input',
          payload: {},
          session: {
            sessionId: state.operationId,
            status: state.status,
            stepCount: 0,
            messageCount: state.messages.length,
          },
        };
        for (let i = 0; i < 3 && context; i++) {
          signal.throwIfAborted();
          const result = await runtime.step(state, context);
          state = result.newState;
          context = result.nextContext;
          if (state.status === 'error' || state.status === 'interrupted')
            throw new Error('HARNESS_PROBE_FAILED');
          if (state.status === 'done') break;
        }
        if (state.status !== 'done' || !receipt.text.trim())
          throw new Error('HARNESS_PROBE_INCOMPLETE');
        return receipt;
      } finally {
        await runtime.dispose();
      }
    },
  };
}
