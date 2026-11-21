import { and, desc, eq, sql } from 'drizzle-orm';

import { agentRuntimeCheckpoints as checkpoints, topics } from '@/database/schemas';
import type { LobeChatDatabase } from '@/database/type';
import { readBotActivity } from '@/server/services/botSurface/activity';
import { withComputerProvider } from '@/server/runtime/computer/host';
import {
  ComputerError,
  type ComputerProviderRegistration,
  getComputerProviderRegistration,
} from '@/server/runtime/computer/provider';
import { NativeComputerRuntime } from '@/server/runtime/computer/runtime';
import { ComputerStore } from '@/server/runtime/computer/store';
import {
  browserFrameSchema,
  computerHumanCommandSchema,
  type ComputerView,
} from '@/types/agentComputer';
import type { UiAttention } from '@/types/uiAttention';

import { resolveComputerModel } from './model';

/** Human management entry; executable shell commands are not accepted by this API. */
export class AgentComputerService {
  constructor(
    private readonly db: LobeChatDatabase,
    private readonly userId: string,
    private readonly registration:
      ComputerProviderRegistration | undefined = getComputerProviderRegistration(),
  ) {}
  private store(agentId: string) {
    return new ComputerStore(
      this.db,
      { agentId, userId: this.userId },
      this.registration?.binding ?? 'disabled',
    );
  }
  async get(agentId: string): Promise<ComputerView> {
    const store = this.store(agentId);
    await store.assertOwner();
    const reasoningModel = await resolveComputerModel(this.db, this.userId, agentId).catch(
      () => undefined,
    );
    if (!this.registration)
      return { enabled: false, commands: [], ...(reasoningModel ? { reasoningModel } : {}) };
    // Recover only expired bookkeeping; inspection never allocates or wakes a provider.
    await store.recoverExpired();
    const botActivity = await readBotActivity(this.db, this.userId, agentId);
    const [activity] = await this.db
      .select({
        topicId: topics.id,
        phase: sql<
          'working' | 'approval'
        >`case when ${checkpoints.metadata}->>'status' = 'waiting_for_human' then 'approval' else 'working' end`,
      })
      .from(checkpoints)
      .innerJoin(
        topics,
        and(
          eq(topics.userId, this.userId),
          sql`${topics.id} = ${checkpoints.metadata}->>'topicId'`,
        ),
      )
      .where(
        and(
          eq(checkpoints.userId, this.userId),
          sql`${checkpoints.metadata}->>'agentId' = ${agentId}`,
          sql`${checkpoints.metadata}->>'status' in ('running', 'waiting_for_human')`,
          sql`(${checkpoints.metadata}->>'status' = 'waiting_for_human' or ${checkpoints.leaseUntil} > clock_timestamp() )`,
          // Match structured tool identities, never arbitrary user text or arguments.
          sql`(jsonb_path_exists(${checkpoints.state}, '$.pendingToolsCalling[*] ? (@.identifier == "qingzhou-computer")')
          or exists (
            select 1 from jsonb_array_elements(coalesce(${checkpoints.state}->'messages', '[]'::jsonb)) with ordinality as msg(value, n)
            where msg.n > coalesce((select max(input.n) from jsonb_array_elements(coalesce(${checkpoints.state}->'messages', '[]'::jsonb)) with ordinality as input(value, n) where input.value->>'role' = 'user'), 0)
            and msg.value->>'role' = 'assistant'
            and (jsonb_path_exists(msg.value, '$.tools[*] ? (@.identifier == "qingzhou-computer")')
              or jsonb_path_exists(msg.value, '$.tool_calls[*] ? (@.function.name == "qingzhou-computer____execute")'))
          ))`,
        ),
      )
      .orderBy(desc(checkpoints.updatedAt))
      .limit(1);
    return {
      enabled: true,
      ...(await store.view()),
      ...(reasoningModel ? { reasoningModel } : {}),
      ...(activity ? { activity } : {}),
      ...(botActivity ? { botActivity } : {}),
    };
  }
  async manage(input: {
    agentId: string;
    command: unknown;
    requestId: string;
    expectedRevision: number;
  }): Promise<ComputerView> {
    const command = computerHumanCommandSchema.parse(input.command);
    if (!this.registration) throw new ComputerError('DISABLED');
    const runtime = new NativeComputerRuntime(
      this.db,
      { userId: this.userId, agentId: input.agentId },
      this.registration,
      {
        actor: 'human',
        // This service is used only by the authenticated human management router.
        // Model tools must supply their own policy/approval authority to the runtime.
        authorize: async () => undefined,
      },
    );
    const receipt = await runtime.execute(command, input.requestId, input.expectedRevision);
    return {
      ...(await this.get(input.agentId)),
      ...(receipt.exitCode !== undefined && receipt.exitCode !== 0 ? { actionFailed: true } : {}),
    };
  }
  async observe(agentId: string, expectedRevision: number) {
    if (!this.registration) throw new ComputerError('DISABLED');
    const store = this.store(agentId);
    const identity = await store.consoleIdentity(expectedRevision);
    const frame = await withComputerProvider(this.registration, async (provider) => {
      if (!provider.observe) throw new ComputerError('DISABLED');
      return browserFrameSchema.parse(await provider.observe(identity, AbortSignal.timeout(12000)));
    });
    await store.consoleIdentity(expectedRevision);
    return { frame, revision: expectedRevision };
  }
  async startTask(agentId: string, prompt: string, uiAttention?: UiAttention) {
    if (!this.registration) throw new ComputerError('DISABLED');
    await this.store(agentId).assertOwner();
    const { model, provider } = await resolveComputerModel(this.db, this.userId, agentId);
    const { AiAgentService } = await import('@/server/services/aiAgent');
    return new AiAgentService(this.db, this.userId).execAgent({
      agentId,
      prompt,
      model,
      provider,
      computerTask: true,
      uiAttention,
      clientRuntime: 'web',
      userInterventionConfig: { approvalMode: 'manual' },
      instructions:
        'Use the persistent qingzhou-computer tools for this task. Inspect status first. Ask for human approval through the native tool review flow. If human browser login is needed, tell the user to take control in the Computer panel and return it afterwards. Never duplicate an unknown command. Produce a concise completion report based only on observed results.',
    });
  }
  async reconcile(
    agentId: string,
    commandId: string,
  ): Promise<ComputerView & { receiptStatus: 'done' | 'pending' | 'unknown' | 'missing' }> {
    if (!this.registration) throw new ComputerError('DISABLED');
    const runtime = new NativeComputerRuntime(
      this.db,
      { userId: this.userId, agentId },
      this.registration,
      { actor: 'human', authorize: async () => undefined },
    );
    const receiptStatus = await runtime.reconcile(commandId);
    return { ...(await this.get(agentId)), receiptStatus };
  }
}
