import { and, eq, sql } from 'drizzle-orm';

import { agentRuntimeCheckpoints, messagePlugins, messages } from '@/database/schemas';
import { AgentComputerService } from '@/server/services/agentComputer';
import type { ToolExecutionContext } from '@/server/services/toolExecution/types';

import { computerAgentPolicy, ComputerToolIdentifier, computerToolInput } from './manifest';
import { ComputerError, digest, getComputerProviderRegistration } from './provider';
import { NativeComputerRuntime } from './runtime';

/** Admission is read from the owned running checkpoint and the actual HITL record, never model args. */
export async function authorizeComputerCall(context: ToolExecutionContext, input: unknown) {
  const { userId, agentId, topicId, operationId, toolCallId, serverDB: db } = context;
  if (
    !userId ||
    !agentId ||
    !topicId ||
    !operationId ||
    !toolCallId ||
    !db ||
    !context.assertStepLease ||
    !context.computerAllowed
  )
    throw new ComputerError('AUTHORITY_REQUIRED');
  context.assertStepLease();
  context.signal?.throwIfAborted();
  const parsed = computerToolInput.parse(input);
  if (parsed.command.kind === 'control' || computerAgentPolicy() === 'deny')
    throw new ComputerError('CONTROL_DENIED');
  const [checkpoint] = await db
    .select()
    .from(agentRuntimeCheckpoints)
    .where(
      and(
        eq(agentRuntimeCheckpoints.id, operationId),
        eq(agentRuntimeCheckpoints.userId, userId),
        sql`${agentRuntimeCheckpoints.leaseUntil}>clock_timestamp()`,
      ),
    );
  if (
    !checkpoint ||
    checkpoint.metadata.agentId !== agentId ||
    checkpoint.metadata.topicId !== topicId ||
    checkpoint.metadata.status !== 'running'
  )
    throw new ComputerError('AUTHORITY_REQUIRED');
  const currentCall = (checkpoint.state?.messages ?? [])
    .flatMap((message: Record<string, any>) =>
      message.role === 'assistant' ? (message.tools ?? message.tool_calls ?? []) : [],
    )
    .find((tool: Record<string, any>) => tool.id === toolCallId);
  // Model state uses ChatToolPayload in `tools`; OpenAI messages use function/arguments.
  if (
    !currentCall ||
    !(
      (currentCall.identifier === ComputerToolIdentifier && currentCall.apiName === 'execute') ||
      currentCall.function?.name === `${ComputerToolIdentifier}____execute`
    )
  )
    throw new ComputerError('AUTHORITY_REQUIRED');
  let canonical: unknown;
  try {
    canonical = JSON.parse(currentCall.arguments ?? currentCall.function?.arguments ?? '{}');
  } catch {
    throw new ComputerError('AUTHORITY_REQUIRED');
  }
  if (digest(computerToolInput.parse(canonical)) !== digest(parsed))
    throw new ComputerError('AUTHORITY_REQUIRED');
  if (computerAgentPolicy() === 'ask') {
    const [approved] = await db
      .select({ arguments: messagePlugins.arguments, intervention: messagePlugins.intervention })
      .from(messagePlugins)
      .innerJoin(
        messages,
        and(
          eq(messages.id, messagePlugins.id),
          eq(messages.userId, userId),
          eq(messages.agentId, agentId),
          eq(messages.topicId, topicId),
        ),
      )
      .where(
        and(
          eq(messagePlugins.userId, userId),
          eq(messagePlugins.toolCallId, toolCallId),
          eq(messagePlugins.identifier, ComputerToolIdentifier),
          eq(messagePlugins.apiName, 'execute'),
        ),
      );
    if (!approved || approved.intervention?.status !== 'approved')
      throw new ComputerError('AUTHORITY_REQUIRED');
    try {
      if (
        digest(computerToolInput.parse(JSON.parse(approved.arguments ?? '{}'))) !== digest(parsed)
      )
        throw new Error('COMPUTER_APPROVAL_ARGUMENTS_CHANGED');
    } catch {
      throw new ComputerError('AUTHORITY_REQUIRED');
    }
  }
  context.assertStepLease();
  context.signal?.throwIfAborted();
}

export function createComputerAgentTools(context: ToolExecutionContext) {
  const { userId, agentId, serverDB: db } = context;
  if (!userId || !agentId || !db || !context.computerAllowed) throw new ComputerError('NOT_FOUND');
  const service = new AgentComputerService(db, userId);
  return {
    status: async () => ({ content: JSON.stringify(await service.get(agentId)), success: true }),
    observe: async () => {
      const view = await service.get(agentId);
      if (!view.session) throw new ComputerError('NOT_FOUND');
      const { frame } = await service.observe(agentId, view.session.revision);
      const { image: _, ...summary } = frame.running ? frame : { image: undefined, ...frame };
      return { content: JSON.stringify(summary), success: true };
    },
    execute: async (input: unknown) => {
      const registration = getComputerProviderRegistration();
      if (!registration) throw new ComputerError('DISABLED');
      const { command } = computerToolInput.parse(input);
      const runtime = new NativeComputerRuntime(db, { userId, agentId }, registration, {
        actor: 'agent',
        assertHeld: context.assertStepLease,
        signal: context.signal,
        authorize: () => authorizeComputerCall(context, input),
      });
      const receipt = await runtime.execute(
        command,
        digest([context.operationId, context.toolCallId]),
      );
      const { resourceId: _, ...result } = receipt;
      return {
        content: JSON.stringify(result),
        success: receipt.exitCode === undefined || receipt.exitCode === 0,
        state: { computer: result },
      };
    },
  };
}
