import debug from 'debug';
import type { Context } from 'hono';

import { isNativeAgentRuntimeEnabled } from '@/server/runtime/tasks/mode';
import { runHeartbeatTick } from '@/server/services/taskRunner/heartbeatTick';

const log = debug('lobe-server:workflows:task:heartbeat-tick');

export interface HeartbeatTickPayload {
  taskId: string;
  userId: string;
}

export async function heartbeatTick(c: Context) {
  if (isNativeAgentRuntimeEnabled()) return c.json({ success: true, managedBy: 'native-worker' });
  try {
    const body = (await c.req.json()) as HeartbeatTickPayload;
    const { taskId, userId } = body;
    if (!taskId || !userId) {
      return c.json({ error: 'Missing required fields: taskId, userId' }, 400);
    }

    log('Received tick: taskId=%s userId=%s', taskId, userId);
    const outcome = await runHeartbeatTick(taskId, userId);
    return c.json({ success: true, ...outcome });
  } catch (error) {
    console.error('[task/heartbeat-tick] Error:', error);
    return c.json({ error: error instanceof Error ? error.message : 'Internal error' }, 500);
  }
}
