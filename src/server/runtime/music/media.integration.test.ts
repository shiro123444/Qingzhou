// @vitest-environment node
import { File } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MusicClient } from '@/services/music/client';

import { musicTestWav } from '../../../../tests/fixtures/musicAudio';
import type { MusicFile } from './contracts';
import { handleMusicCommand, handleMusicStream } from './handler';
import { musicByteRange, OwnedFileMusicProvider } from './owned-file-provider';
import { createMusicRuntime } from './runtime';

const audio = musicTestWav();
const objects = new Map<string, Uint8Array>();
const rows = new Map<string, MusicFile>();
const host = createMusicRuntime();
let base: string;
let expireNext = false;
let issued = 0;
let transferred: string[] = [];

const provider = (userId: string) =>
  new OwnedFileMusicProvider(
    userId,
    {
      findById: async (id) => {
        const row = rows.get(id);
        return row?.userId === userId ? row : undefined;
      },
      queryAudio: async ({ query, limit }) =>
        [...rows.values()]
          .filter((row) => row.userId === userId && row.name.includes(query))
          .slice(0, limit),
    },
    {
      getFileMetadata: async (key) => ({ contentLength: objects.get(key)!.byteLength }),
      createPreSignedUrlForPreview: async (key) => {
        issued++;
        const expired = expireNext;
        expireNext = false;
        return `${base}/storage/${key}?signature=${expired ? 'expired' : 'valid'}`;
      },
    },
  );

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, base);
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><title>Music M1 media verification</title></html>');
      return;
    }
    if (url.pathname.startsWith('/storage/')) {
      const key = url.pathname.slice('/storage/'.length);
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(200);
        res.end();
        return;
      }
      if (url.searchParams.get('signature') !== 'valid') {
        res.writeHead(403);
        res.end('expired private signature');
        return;
      }
      const body = objects.get(key)!;
      const range = req.headers.range
        ? musicByteRange(req.headers.range, body.byteLength)
        : undefined;
      transferred.push(req.headers.range ?? 'full');
      const bytes = range ? body.slice(range.start, range.end + 1) : body;
      res.writeHead(range ? 206 : 200, {
        'Content-Type': 'audio/wav',
        'Content-Length': bytes.byteLength,
        ...(range
          ? { 'Content-Range': `bytes ${range.start}-${range.end}/${body.byteLength}` }
          : {}),
      });
      res.end(bytes);
      return;
    }
    const userId = req.headers['x-test-user'];
    if (typeof userId !== 'string') {
      res.writeHead(401);
      res.end();
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers))
      if (typeof value === 'string') headers.set(name, value);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = new Request(url, {
      method: req.method,
      headers,
      ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
    });
    const streamId = /^\/api\/runtime\/music\/tracks\/([^/]+)\/stream$/u.exec(url.pathname)?.[1];
    const response = streamId
      ? await handleMusicStream(request, decodeURIComponent(streamId), provider(userId))
      : await handleMusicCommand(request, provider(userId), host);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) res.write(chunk);
    res.end();
  } catch {
    res.writeHead(500);
    res.end();
  }
});

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test address');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await host.dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('music real HTTP byte pipeline', () => {
  it('uploads actual audio, searches by account, streams and seeks, renews expiration, and rejects other accounts', async () => {
    const client = new MusicClient(
      (input, init) =>
        fetch(new URL(String(input), base), {
          ...init,
          headers: { ...Object.fromEntries(new Headers(init?.headers)), 'x-test-user': 'alice' },
        }),
      {
        upload: async (file) => {
          const path = `${randomUUID()}.wav`;
          const response = await fetch(`${base}/storage/${path}`, {
            method: 'PUT',
            body: await file.arrayBuffer(),
          });
          expect(response.status).toBe(200);
          return { path };
        },
        register: async (input) => {
          const id = randomUUID();
          rows.set(id, {
            id,
            name: input.name,
            fileType: input.fileType,
            url: input.url,
            size: input.size,
            userId: 'alice',
            updatedAt: new Date(),
          });
          return { id };
        },
      },
    );
    const track = await client.uploadAudio(new File([audio], 'Rain.wav', { type: 'audio/wav' }));
    expect((await client.search('Rain')).map((item) => item.id)).toEqual([track.id]);
    const playback = await client.resolve(track.id);
    const url = new URL(playback.src, base);
    const full = await fetch(url, { headers: { 'x-test-user': 'alice' } });
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(audio);
    const before = issued;
    expireNext = true;
    transferred = [];
    const partial = await fetch(url, {
      headers: { 'x-test-user': 'alice', 'Range': 'bytes=4000-4999' },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get('content-range')).toBe(`bytes 4000-4999/${audio.byteLength}`);
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(audio.slice(4000, 5000));
    expect(issued - before).toBe(2);
    expect(transferred).toEqual(['bytes=4000-4999']);
    expect((await fetch(url, { headers: { 'x-test-user': 'bob' } })).status).toBe(404);
    expect((await fetch(url)).status).toBe(401);
    expect(
      (await fetch(url, { headers: { 'x-test-user': 'alice', 'Range': 'bytes=999999-' } })).status,
    ).toBe(416);
    rows.delete(track.id);
    expect((await fetch(url, { headers: { 'x-test-user': 'alice' } })).status).toBe(404);
  });

  it.runIf(process.env.MUSIC_BROWSER_EXECUTABLE && process.env.MUSIC_TEST_MP3)(
    'decodes a real MP3 and seeks in a native browser audio element through the authenticated proxy',
    async () => {
      // Playwright belongs to the existing e2e workspace, not the production bundle.
      const require = createRequire(new URL('../../../../e2e/package.json', import.meta.url));
      const { chromium } = require('playwright') as {
        chromium: {
          launch: (options: {
            executablePath?: string;
            headless: boolean;
            args: string[];
          }) => Promise<{
            close: () => Promise<void>;
            newPage: (options: { extraHTTPHeaders: Record<string, string> }) => Promise<{
              goto: (url: string) => Promise<unknown>;
              evaluate: <T>(callback: (src: string) => Promise<T>, src: string) => Promise<T>;
            }>;
          }>;
        };
      };
      const bytes = await readFile(process.env.MUSIC_TEST_MP3!);
      const key = `${randomUUID()}.mp3`;
      const uploaded = await fetch(`${base}/storage/${key}`, { method: 'PUT', body: bytes });
      expect(uploaded.status).toBe(200);
      const id = randomUUID();
      rows.set(id, {
        id,
        name: 'tone.mp3',
        fileType: 'audio/mpeg',
        size: bytes.length,
        url: key,
        userId: 'alice',
        updatedAt: new Date(),
      });
      const source = (await provider('alice').resolve(id)).src;
      const browser = await chromium.launch({
        executablePath: process.env.MUSIC_BROWSER_EXECUTABLE,
        headless: true,
        args: ['--autoplay-policy=no-user-gesture-required'],
      });
      try {
        const page = await browser.newPage({ extraHTTPHeaders: { 'x-test-user': 'alice' } });
        await page.goto(base);
        expireNext = true;
        const before = issued;
        const result = await page.evaluate(async (src: string) => {
          const range = await fetch(src, { headers: { Range: 'bytes=500-999' } });
          const rangeSize = (await range.arrayBuffer()).byteLength;
          const data = await (await fetch(src)).arrayBuffer();
          const audioContext = new AudioContext();
          const decoded = await audioContext.decodeAudioData(data);
          const decodedDuration = decoded.duration;
          await audioContext.close();
          const audio = new Audio();
          audio.src = src;
          await new Promise<void>((resolve, reject) => {
            audio.onloadedmetadata = () => resolve();
            audio.onerror = () => reject(new Error('MP3 metadata failed'));
          });
          audio.currentTime = 2;
          await new Promise<void>((resolve, reject) => {
            audio.onseeked = () => resolve();
            audio.onerror = () => reject(new Error('MP3 seek failed'));
          });
          await audio.play();
          const position = audio.currentTime;
          audio.pause();
          audio.removeAttribute('src');
          audio.load();
          return { rangeStatus: range.status, rangeSize, decodedDuration, position };
        }, source);
        expect(result.rangeStatus).toBe(206);
        expect(result.rangeSize).toBe(500);
        expect(result.decodedDuration).toBeGreaterThan(7.9);
        expect(result.position).toBeGreaterThanOrEqual(1.9);
        expect(issued - before).toBeGreaterThanOrEqual(2);
      } finally {
        await browser.close();
        rows.delete(id);
      }
    },
    30_000,
  );
});
