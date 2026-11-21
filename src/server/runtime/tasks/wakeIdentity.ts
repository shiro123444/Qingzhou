import { createHash } from 'node:crypto';

const stable = (value: unknown) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
export const wakeHash = (value: unknown) =>
  createHash('sha256').update(stable(value)).digest('hex');
export const taskWakeVersion = (task: Record<string, any>) =>
  wakeHash([
    task.automationMode,
    task.heartbeatInterval,
    task.schedulePattern,
    task.scheduleTimezone,
    task.context?.scheduler?.nativeGeneration ?? null,
  ]);
export const taskWakeAnchor = (task: Record<string, any>) =>
  new Date(task.lastHeartbeatAt ?? task.startedAt ?? task.createdAt).toISOString();
