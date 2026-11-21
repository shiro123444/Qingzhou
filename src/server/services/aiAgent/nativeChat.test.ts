// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { AgentRuntime } from '@lobechat/agent-runtime';
import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

import {
  agentRuntimeCheckpoints,
  agentRuntimeJobs,
  agents,
  messagePlugins,
  messages,
  topics,
  users,
} from '@/database/schemas';
import { InMemoryStreamEventManager } from '@/server/modules/AgentRuntime/InMemoryStreamEventManager';
import { NativeAgentStore } from '@/server/runtime/tasks/store';

import { AiAgentService } from './index';

const db = await getTestDB();
const userId = `native-chat-${randomUUID()}`;
let agentId: string, topicId: string, assistantId: string, toolMessageId: string;
beforeAll(async () => {
  await db.insert(users).values({ id: userId });
  [agentId] = (await db.insert(agents).values({ userId, title: 'test' }).returning()).map(
    (row) => row.id,
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await db.delete(agentRuntimeCheckpoints).where(eq(agentRuntimeCheckpoints.userId, userId));
  await db.delete(topics).where(eq(topics.userId, userId));
});
afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});
async function prepare(question = false) {
  vi.stubEnv('AGENT_RUNTIME_MODE', 'native');
  [topicId] = (await db.insert(topics).values({ userId, agentId }).returning()).map(
    (row) => row.id,
  );
  assistantId = 'msg_' + randomUUID();
  await db
    .insert(messages)
    .values({ id: assistantId, userId, agentId, topicId, role: 'assistant', content: '' });
  toolMessageId = 'msg_' + randomUUID();
  await db.insert(messages).values({
    id: toolMessageId,
    userId,
    agentId,
    topicId,
    role: 'tool',
    parentId: assistantId,
    content: '',
  });
  const tool = {
    id: 'call',
    type: 'builtin' as const,
    identifier: question ? 'qingzhou-system-capabilities' : 'test-tool',
    apiName: question ? 'ask' : 'write',
    arguments: '{"target":"original"}',
  };
  await db.insert(messagePlugins).values({
    id: toolMessageId,
    userId,
    identifier: tool.identifier,
    apiName: tool.apiName,
    arguments: tool.arguments,
    toolCallId: tool.id,
  });
  const store = new NativeAgentStore(db);
  await store.create('chat', { userId });
  await store.save(
    'chat',
    AgentRuntime.createInitialState({
      operationId: 'chat',
      metadata: { userId, agentId, topicId },
      status: 'waiting_for_human',
      stepCount: 3,
      pendingToolsCalling: [tool],
    }),
  );
  await store.attachConversation('chat', userId, { topicId, assistantMessageId: assistantId });
  const service = new AiAgentService(db, userId, {
    runtimeOptions: { streamEventManager: new InMemoryStreamEventManager() },
  });
  return { service, store, tool };
}
it('resumes the same durable chat and binds approval to the stored arguments without creating messages', async () => {
  const { service, tool } = await prepare();
  const before = await db.select().from(messages).where(eq(messages.userId, userId));
  const result = await service.execAgent({
    agentId,
    appContext: { topicId },
    parentMessageId: toolMessageId,
    prompt: '',
    resumeApproval: { decision: 'approved', parentMessageId: toolMessageId, toolCallId: tool.id },
  });
  expect(result.operationId).toBe('chat');
  expect(result.transport).toBe('native');
  expect(await db.select().from(messages).where(eq(messages.userId, userId))).toHaveLength(
    before.length,
  );
  const [job] = await db.select().from(agentRuntimeJobs);
  expect(job.stepIndex).toBe(3);
  expect(job.message.payload.approvedToolCall).toEqual(tool);
  expect(await new NativeAgentStore(db).hasPendingIntervention('chat', 3)).toBe(true);
});
it('queues a structured question answer and rejects a mismatched agent before any admission', async () => {
  const { service, tool } = await prepare(true);
  await expect(
    service.execAgent({
      agentId: 'another-agent',
      appContext: { topicId },
      parentMessageId: toolMessageId,
      prompt: '',
      resumeApproval: {
        decision: 'answered',
        parentMessageId: toolMessageId,
        toolCallId: tool.id,
        response: { choice: 'A' },
      },
    }),
  ).rejects.toThrow('scope mismatch');
  expect(await db.select().from(agentRuntimeJobs)).toHaveLength(0);
  await service.execAgent({
    agentId,
    appContext: { topicId },
    parentMessageId: toolMessageId,
    prompt: '',
    resumeApproval: {
      decision: 'answered',
      parentMessageId: toolMessageId,
      toolCallId: tool.id,
      response: { choice: 'A' },
    },
  });
  expect((await db.select().from(agentRuntimeJobs))[0].message.payload.humanInput).toEqual({
    toolCallId: tool.id,
    response: { choice: 'A' },
  });
});
it('keeps a newer topic pointer when an older operation terminates and never attaches a finished operation', async () => {
  const { store } = await prepare();
  const original = (await store.checkpoint('chat'))!.state!;
  await store.create('newer', { userId });
  await store.save('newer', { ...original, status: 'running' });
  await store.attachConversation('newer', userId, { topicId, assistantMessageId: assistantId });
  await store.save('chat', { ...original, status: 'interrupted' });
  expect(
    (await db.select().from(topics).where(eq(topics.id, topicId)))[0].metadata?.runningOperation
      ?.operationId,
  ).toBe('newer');
  await store.attachConversation('chat', userId, { topicId, assistantMessageId: assistantId });
  expect(
    (await db.select().from(topics).where(eq(topics.id, topicId)))[0].metadata?.runningOperation
      ?.operationId,
  ).toBe('newer');
});
