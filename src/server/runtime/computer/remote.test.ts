// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';

import { type ComputerDispatch, getComputerProviderRegistration } from './provider';
import { RemoteComputerProvider } from './remote';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const dispatch: ComputerDispatch = {
  sessionId: 'session',
  commandId: 'command',
  revision: 2,
  expiresAt: '2030-01-01T00:00:00Z',
  actor: 'agent',
  command: { kind: 'shell', command: 'pwd', timeoutMs: 30000 },
};
const body = {
  sessionId: 'session',
  commandId: 'command',
  revision: 2,
  resourceId: 'private-resource',
  state: 'ready',
  control: 'agent',
  exitCode: 0,
  stdout: '/workspace',
};

it('selects the deployment provider only with valid explicit configuration', () => {
  vi.stubEnv('QINGZHOU_COMPUTER_ENABLED', '0');
  expect(getComputerProviderRegistration()).toBeUndefined();
  vi.stubEnv('QINGZHOU_COMPUTER_ENABLED', '1');
  vi.stubEnv('QINGZHOU_COMPUTER_TOKEN', 'private-token');
  for (const endpoint of [
    'bad',
    'http://external.example',
    'https://user:password@example.com',
    'https://example.com?token=x',
  ]) {
    vi.stubEnv('QINGZHOU_COMPUTER_ENDPOINT', endpoint);
    expect(() => getComputerProviderRegistration()).toThrow('COMPUTER_DISABLED');
  }
  vi.stubEnv('QINGZHOU_COMPUTER_ENDPOINT', 'https://computer.example');
  const registration = getComputerProviderRegistration()!;
  expect(registration.capabilities).toEqual([
    'lifecycle',
    'control',
    'shell',
    'receipt',
    'browser',
  ]);
  expect(JSON.stringify(registration)).not.toMatch(/private-token|computer\.example/);
});

it('sends one authenticated fixed-endpoint request and validates correlated response identity', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(body));
  const receipt = await new RemoteComputerProvider('https://computer.example', 'secret').execute(
    dispatch,
    new AbortController().signal,
  );
  expect(receipt).toMatchObject({ resourceId: 'private-resource', exitCode: 0 });
  expect(fetch).toHaveBeenCalledOnce();
  const [url, options] = fetch.mock.calls[0];
  expect(url).toBe('https://computer.example/v1/computer/invoke');
  expect(options).toMatchObject({ redirect: 'error', headers: { Authorization: 'Bearer secret' } });
  expect(String(options?.body)).not.toContain('secret');
  fetch.mockResolvedValueOnce(Response.json({ ...body, sessionId: 'another-session' }));
  await expect(
    new RemoteComputerProvider('https://computer.example', 'secret').execute(
      dispatch,
      new AbortController().signal,
    ),
  ).rejects.toThrow('COMPUTER_INVALID_RESPONSE');
});

it('never retries failed dispatches and bounds streamed response size', async () => {
  const fetch = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('private error', { status: 503 }));
  const provider = new RemoteComputerProvider('https://computer.example', 'secret');
  await expect(provider.execute(dispatch, new AbortController().signal)).rejects.toThrow(
    'COMPUTER_INVALID_RESPONSE',
  );
  expect(fetch).toHaveBeenCalledOnce();
  fetch.mockResolvedValueOnce(new Response('x'.repeat(150001)));
  await expect(provider.execute(dispatch, new AbortController().signal)).rejects.toThrow(
    'COMPUTER_INVALID_RESPONSE',
  );
  expect(fetch).toHaveBeenCalledTimes(2);
  fetch.mockResolvedValueOnce(Response.json({ ...body, stdout: '😀'.repeat(20000) }));
  await expect(provider.execute(dispatch, new AbortController().signal)).rejects.toThrow(
    'COMPUTER_INVALID_RESPONSE',
  );
});
