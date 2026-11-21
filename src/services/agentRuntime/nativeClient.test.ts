import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { NativeStreamClient } from './nativeClient';

const mocks = vi.hoisted(() => ({ status: vi.fn(), interrupt: vi.fn(), stream: vi.fn() }));
vi.mock('@/services/aiAgent', () => ({
  aiAgentService: { getOperationStatus: mocks.status, interruptTask: mocks.interrupt },
}));
vi.mock('@lobechat/utils/client', () => ({ fetchEventSource: mocks.stream }));
const clients: NativeStreamClient[] = [];
const snapshot = (status: string, stepCount = 0, pendingIntervention = false) => ({
  currentState: { status, stepCount },
  pendingIntervention,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.interrupt.mockResolvedValue({});
  mocks.stream.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => {
  clients.splice(0).forEach((client) => client.disconnect());
  vi.useRealTimers();
});
const create = () => {
  const client = new NativeStreamClient('op');
  clients.push(client);
  return client;
};
it('recovers a completed snapshot even when the old event stream has expired', async () => {
  mocks.status.mockResolvedValue(snapshot('done', 5));
  const client = create(),
    event = vi.fn(),
    complete = vi.fn();
  client.on('agent_event', event);
  client.on('session_complete', complete);
  client.connect();
  await vi.advanceTimersByTimeAsync(0);
  expect(event).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'agent_runtime_end',
      data: expect.objectContaining({ finalState: { status: 'done', stepCount: 5 } }),
    }),
  );
  expect(complete).toHaveBeenCalledTimes(1);
  expect(mocks.stream).not.toHaveBeenCalled();
});
it('keeps an accepted approval attached and ignores the old pause event', async () => {
  mocks.status.mockResolvedValue(snapshot('waiting_for_human', 3, true));
  const client = create(),
    event = vi.fn(),
    complete = vi.fn();
  client.on('agent_event', event);
  client.on('session_complete', complete);
  client.connect();
  await vi.advanceTimersByTimeAsync(0);
  const options = mocks.stream.mock.calls[0][1];
  const send = (type: string, stepIndex: number, data: any) =>
    options.onmessage({
      data: JSON.stringify({
        id: `${stepIndex + 100}-0`,
        operationId: 'op',
        type,
        stepIndex,
        data,
        timestamp: 1,
      }),
    });
  send('agent_runtime_end', 3, { finalState: { status: 'waiting_for_human', stepCount: 3 } });
  expect(complete).not.toHaveBeenCalled();
  send('stream_chunk', 3, { content: 'continued' });
  send('agent_runtime_end', 4, { finalState: { status: 'done', stepCount: 4 } });
  expect(event.mock.calls.map((call) => call[0].type)).toEqual([
    'stream_chunk',
    'agent_runtime_end',
  ]);
  expect(complete).toHaveBeenCalledTimes(1);
});
it('reconnects from the Redis cursor and detaches without interrupting the server task', async () => {
  mocks.status.mockResolvedValue(snapshot('running', 2));
  mocks.stream
    .mockImplementationOnce(async (_url, options) => {
      options.onmessage({
        data: JSON.stringify({
          id: '1000-7',
          operationId: 'op',
          type: 'stream_chunk',
          stepIndex: 2,
          data: { content: 'a' },
          timestamp: 1,
        }),
      });
    })
    .mockImplementation(() => new Promise(() => {}));
  const client = create();
  client.connect();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(mocks.stream.mock.calls[1][0]).toContain('lastEventId=1000-7');
  client.disconnect();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(mocks.interrupt).not.toHaveBeenCalled();
  expect(mocks.stream).toHaveBeenCalledTimes(2);
});
it('does not mistake a temporary status outage for task completion', async () => {
  mocks.status.mockRejectedValue(new Error('offline'));
  const client = create(),
    complete = vi.fn();
  client.on('session_complete', complete);
  client.connect();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.stream).toHaveBeenCalledTimes(1);
  expect(complete).not.toHaveBeenCalled();
});
