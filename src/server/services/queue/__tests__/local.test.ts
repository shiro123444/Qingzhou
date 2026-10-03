// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';

import { LocalQueueServiceImpl } from '../impls/local';

afterEach(() => vi.useRealTimers());

it('passes human intervention payloads through the local scheduler', async () => {
  vi.useFakeTimers();
  const queue = new LocalQueueServiceImpl();
  const callback = vi.fn().mockResolvedValue(undefined);
  queue.setExecutionCallback(callback);
  const payload = { humanInput: { toolCallId: 'q', response: { text: 'A' } }, toolMessageId: 'm' };
  await queue.scheduleMessage({
    endpoint: '/run',
    operationId: 'op',
    stepIndex: 3,
    payload,
    delay: 100,
  });
  expect(callback).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(callback).toHaveBeenCalledExactlyOnceWith('op', 3, undefined, payload);
});
