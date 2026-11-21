// @vitest-environment node
import { randomUUID } from 'node:crypto';

import { getTestDB } from '@lobechat/database/test-utils';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { agentRuntimeCheckpoints as checkpoints, agents, topics, users } from '@/database/schemas';

import { AgentComputerService } from './index';

const db = await getTestDB(),
  userId = randomUUID(),
  agentId = randomUUID(),
  otherAgent = randomUUID(),
  topicId = randomUUID(),
  operationId = randomUUID();
const load = vi.fn();
const service = new AgentComputerService(db, userId, {
  id: 'test',
  binding: 'test',
  capabilities: [],
  load,
});
beforeAll(async () => {
  await db.insert(users).values({ id: userId });
  await db.insert(agents).values([
    { id: agentId, userId },
    { id: otherAgent, userId },
  ]);
  await db.insert(topics).values({ id: topicId, userId, agentId });
});
afterAll(async () => {
  await db.delete(users).where(eq(users.id, userId));
});

it('projects owned structured computer approval without private arguments or provider startup', async () => {
  await db.insert(checkpoints).values({
    id: operationId,
    userId,
    metadata: { agentId, topicId, status: 'waiting_for_human' },
    state: {
      pendingToolsCalling: [
        { identifier: 'qingzhou-computer', apiName: 'execute', arguments: 'private-text' },
      ],
    },
  });
  const result = await service.get(agentId);
  expect(result.activity).toEqual({ phase: 'approval', topicId });
  expect(JSON.stringify(result)).not.toContain('private-text');
  expect((await service.get(otherAgent)).activity).toBeUndefined();
  expect(load).not.toHaveBeenCalled();
});

it('does not turn idle, expired or unrelated text into a working computer', async () => {
  await db
    .update(checkpoints)
    .set({ metadata: { agentId, topicId, status: 'running' } })
    .where(eq(checkpoints.id, operationId));
  expect((await service.get(agentId)).activity).toBeUndefined();
  await db
    .update(checkpoints)
    .set({
      leaseUntil: new Date(Date.now() + 60000),
      state: {
        messages: [
          {
            role: 'assistant',
            tool_calls: [{ function: { name: 'qingzhou-computer____execute' } }],
          },
          { role: 'user', content: 'A new ordinary question' },
        ],
      },
    })
    .where(eq(checkpoints.id, operationId));
  expect((await service.get(agentId)).activity).toBeUndefined();
  await db
    .update(checkpoints)
    .set({
      state: {
        messages: [
          { role: 'user', content: 'Use the computer in this turn' },
          {
            role: 'assistant',
            tool_calls: [
              { function: { name: 'qingzhou-computer____execute', arguments: 'private-input' } },
            ],
          },
        ],
      },
    })
    .where(eq(checkpoints.id, operationId));
  expect((await service.get(agentId)).activity).toEqual({ phase: 'working', topicId });
  expect((await service.get(agentId)).botActivity).toEqual({ phase: 'working', topicId });
  await db
    .update(checkpoints)
    .set({
      metadata: { agentId, topicId, status: 'waiting_for_human' },
      state: { messages: [{ role: 'user', content: 'qingzhou-computer____execute' }] },
    })
    .where(eq(checkpoints.id, operationId));
  expect((await service.get(agentId)).activity).toBeUndefined();
  await db
    .update(checkpoints)
    .set({
      metadata: { agentId, topicId, status: 'done' },
      state: { pendingToolsCalling: [{ identifier: 'qingzhou-computer' }] },
    })
    .where(eq(checkpoints.id, operationId));
  expect((await service.get(agentId)).activity).toBeUndefined();
});
