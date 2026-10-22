// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMusicPlugin } from './atomic-plugin';
import { type MusicProvider } from './contracts';
import { handleMusicCommand, handleMusicStream } from './handler';
import { createMusicRuntime } from './runtime';

const track = {
  id: 'one',
  name: 'Rain',
  mimeType: 'audio/mpeg',
  size: 10,
  source: 'library' as const,
  version: 'v1',
};
const hosts: ReturnType<typeof createMusicRuntime>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.dispose();
});
const fixture = () => {
  const host = createMusicRuntime();
  hosts.push(host);
  const provider: MusicProvider = {
    userId: 'alice',
    search: vi.fn().mockResolvedValue([track]),
    track: vi.fn().mockResolvedValue(track),
    resolve: vi.fn().mockResolvedValue({ track, src: '/api/runtime/music/tracks/one/stream' }),
    stream: vi.fn().mockResolvedValue(new Response('audio')),
  };
  const command = (operation: string, input: unknown, extras = {}, headers = {}) =>
    handleMusicCommand(
      new Request('https://app.test/api/runtime/music', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ operation, input, ...extras }),
      }),
      provider,
      host,
    );
  return { host, provider, command };
};

describe('music Cordis boundary', () => {
  it('mounts the music profile and keeps playback secrets out of skills', async () => {
    const f = fixture();
    const response = await f.command('music.search', { query: 'rain', limit: 3 });
    expect(await response.json()).toEqual({ success: true, result: { tracks: [track] } });
    const catalog = await f.command('skills.catalog', {});
    const body = await catalog.json();
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'music.search',
      'music.track.get',
    ]);
    expect(await f.host.pluginIds()).toEqual(['music', 'skills']);
  });
  it.each([
    ['music.search', { query: 'a', userId: 'bob' }],
    ['music.search', { limit: 51 }],
    ['music.search', { query: 'x'.repeat(201) }],
    ['music.track.get', { trackId: '' }],
    ['music.playback.resolve', { trackId: 'one', services: {} }],
    ['music.install', {}],
    ['skills.run', {}],
  ])('rejects untrusted %s input', async (operation, input) => {
    const f = fixture();
    expect((await f.command(operation, input)).status).toBe(400);
  });
  it('rejects forged envelopes and cross-site writes before executing tools', async () => {
    const f = fixture();
    expect((await f.command('music.search', {}, { userId: 'bob' })).status).toBe(400);
    expect((await f.command('music.search', {}, {}, { origin: 'https://evil.test' })).status).toBe(
      403,
    );
    expect(f.provider.search).not.toHaveBeenCalled();
  });
  it('requires the injected provider to match authenticated scope', async () => {
    const f = fixture();
    await expect(
      f.host.invoke(
        'music.search',
        {},
        { scope: { userId: 'bob', sessionId: 's' }, services: { music: f.provider } },
      ),
    ).rejects.toMatchObject({ code: 'MUSIC_FORBIDDEN' });
  });
  it('pins the plugin for active calls and releases it after completion', async () => {
    const f = fixture();
    let finish!: (value: (typeof track)[]) => void;
    vi.mocked(f.provider.search).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.command('music.search', {});
    await vi.waitFor(() => expect(f.provider.search).toHaveBeenCalled());
    await expect(f.host.replace(createMusicPlugin())).rejects.toMatchObject({
      code: 'PLUGIN_BUSY',
    });
    finish([track]);
    expect((await pending).status).toBe(200);
    await f.host.replace(createMusicPlugin());
  });
  it('limits chunked request bodies without relying on Content-Length', async () => {
    const f = fixture();
    const request = new Request('https://app.test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(20_000),
    });
    expect((await handleMusicCommand(request.clone(), f.provider, f.host)).status).toBe(413);
    expect(f.provider.search).not.toHaveBeenCalled();
  });
  it('does not expose storage errors or accept cross-site media embedding', async () => {
    const f = fixture();
    vi.mocked(f.provider.stream).mockRejectedValue(
      new Error('https://secret.test?signature=private'),
    );
    const response = await handleMusicStream(new Request('https://app.test'), 'one', f.provider);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('signature');
    expect(
      (
        await handleMusicStream(
          new Request('https://app.test', { headers: { 'sec-fetch-site': 'cross-site' } }),
          'one',
          f.provider,
        )
      ).status,
    ).toBe(403);
  });
});
