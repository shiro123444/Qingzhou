// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { AgentRuntime, GeneralChatAgent } from '@lobechat/agent-runtime';
import { getTestDB } from '@lobechat/database/test-utils';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

import { MessageModel } from '@/database/models/message';
import { agentRuntimeCheckpoints, agents, topics, users } from '@/database/schemas';
import { HumanInterventionHandler } from '@/server/services/agentRuntime/HumanInterventionHandler';
import type { ToolExecutionContext } from '@/server/services/toolExecution/types';

import { authorizeComputerCall } from './agent-tools';
import { computerManifest, ComputerToolIdentifier } from './manifest';

const db = await getTestDB(),
  userId = `computer-policy-${randomUUID()}`,
  agentId = `agent-${randomUUID()}`,
  topicId = `topic-${randomUUID()}`;
beforeAll(async () => {
  await db.insert(users).values({ id: userId });
  await db.insert(agents).values({ id: agentId, userId });
  await db.insert(topics).values({ id: topicId, userId, agentId });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});
async function pending() {
  vi.stubEnv('QINGZHOU_COMPUTER_AGENT_POLICY', 'ask');
  const operationId = randomUUID(),
    toolCallId = randomUUID(),
    input = { command: { kind: 'shell', command: 'printf test' } };
  const payload = {
    identifier: ComputerToolIdentifier,
    apiName: 'execute',
    id: toolCallId,
    type: 'builtin' as const,
    arguments: JSON.stringify(input),
  };
  const state = AgentRuntime.createInitialState({
    operationId,
    status: 'waiting_for_human',
    metadata: { userId, agentId, topicId, operationId },
    pendingToolsCalling: [payload],
    toolManifestMap: { [ComputerToolIdentifier]: computerManifest() },
    messages: [
      {
        id: randomUUID(),
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: toolCallId,
            type: 'function',
            function: {
              name: `${ComputerToolIdentifier}____execute`,
              arguments: JSON.stringify(input),
            },
          },
        ],
      },
    ],
  });
  await db.insert(agentRuntimeCheckpoints).values({
    id: operationId,
    userId,
    state,
    metadata: { userId, agentId, topicId, status: 'waiting_for_human' },
    leaseOwner: randomUUID(),
    leaseUntil: new Date(Date.now() + 60000),
  });
  const model = new MessageModel(db, userId);
  const message = await model.create({
    agentId,
    topicId,
    role: 'tool',
    content: '',
    plugin: payload,
    tool_call_id: toolCallId,
    pluginIntervention: { status: 'pending' },
  });
  const context: ToolExecutionContext = {
    userId,
    agentId,
    topicId,
    operationId,
    toolCallId,
    serverDB: db,
    toolManifestMap: {},
    computerAllowed: true,
    assertStepLease: () => undefined,
  };
  const handler = new HumanInterventionHandler(db, model);
  const approve = async () => {
    const accepted = await handler.validate(state, {
      approvedToolCall: payload,
      toolMessageId: message.id,
    });
    const result = await handler.process(state, accepted);
    await db
      .update(agentRuntimeCheckpoints)
      .set({ state: result.newState, metadata: { userId, agentId, topicId, status: 'running' } })
      .where(eq(agentRuntimeCheckpoints.id, operationId));
    return result;
  };
  return { input, payload, state, context, handler, message, approve };
}
it('requires the real owned approval record and rejects changed command arguments', async () => {
  const test = await pending();
  await expect(authorizeComputerCall(test.context, test.input)).rejects.toThrow(
    'AUTHORITY_REQUIRED',
  );
  await test.approve();
  await expect(authorizeComputerCall(test.context, test.input)).resolves.toBeUndefined();
  await expect(
    authorizeComputerCall(test.context, { command: { kind: 'shell', command: 'changed' } }),
  ).rejects.toThrow('AUTHORITY_REQUIRED');
  await expect(
    test.handler.validate(test.state, {
      approvedToolCall: {
        ...test.payload,
        arguments: '{"command":{"kind":"shell","command":"changed"}}',
      },
      toolMessageId: test.message.id,
    }),
  ).rejects.toThrow('arguments changed');
});
it('denies rejected reviews, foreign scopes and missing runtime authority', async () => {
  const test = await pending();
  const rejected = await test.handler.process(test.state, {
    rejectionReason: 'Declined',
    toolMessageId: test.message.id,
  });
  expect(rejected.newState.status).toBe('interrupted');
  await db
    .update(agentRuntimeCheckpoints)
    .set({ metadata: { userId, agentId, topicId, status: 'running' } })
    .where(eq(agentRuntimeCheckpoints.id, test.context.operationId!));
  await expect(authorizeComputerCall(test.context, test.input)).rejects.toThrow(
    'AUTHORITY_REQUIRED',
  );
  await expect(
    authorizeComputerCall({ ...test.context, userId: 'foreign' }, test.input),
  ).rejects.toThrow('AUTHORITY_REQUIRED');
  await expect(
    authorizeComputerCall({ ...test.context, computerAllowed: false }, test.input),
  ).rejects.toThrow('AUTHORITY_REQUIRED');
});
it('applies allow/ask/deny policy without allowing stale leases or self-granted control', async () => {
  const test = await pending();
  await test.approve();
  vi.stubEnv('QINGZHOU_COMPUTER_AGENT_POLICY', 'deny');
  await expect(authorizeComputerCall(test.context, test.input)).rejects.toThrow('CONTROL_DENIED');
  vi.stubEnv('QINGZHOU_COMPUTER_AGENT_POLICY', 'allow');
  await expect(authorizeComputerCall(test.context, test.input)).resolves.toBeUndefined();
  await expect(
    authorizeComputerCall(test.context, { command: { kind: 'control', target: 'agent' } }),
  ).rejects.toThrow('CONTROL_DENIED');
  await db
    .update(agentRuntimeCheckpoints)
    .set({ leaseUntil: new Date(0) })
    .where(
      and(
        eq(agentRuntimeCheckpoints.id, test.context.operationId!),
        eq(agentRuntimeCheckpoints.userId, userId),
      ),
    );
  await expect(authorizeComputerCall(test.context, test.input)).rejects.toThrow(
    'AUTHORITY_REQUIRED',
  );
});
it('pauses headless and auto-run computer actions for mandatory human approval', async () => {
  const test = await pending();
  const agent = new GeneralChatAgent({
    operationId: test.context.operationId!,
    modelRuntimeConfig: { model: 'deepseek-v4.1-flash', provider: 'nexus' },
    mandatoryInterventionTools: [ComputerToolIdentifier],
  });
  for (const approvalMode of ['headless', 'auto-run'] as const) {
    const result = await agent.runner(
      {
        phase: 'llm_result',
        payload: { hasToolsCalling: true, toolsCalling: [test.payload], parentMessageId: 'parent' },
      },
      {
        ...test.state,
        status: 'running',
        pendingToolsCalling: [],
        userInterventionConfig: { approvalMode },
      },
    );
    expect(result).toMatchObject([{ type: 'request_human_approve' }]);
  }
});
