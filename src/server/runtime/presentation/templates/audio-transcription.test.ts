import { describe, expect, it, vi } from 'vitest';

import {
  createOpenAICompatibleAudioTranscriber,
  normalizeAudioTranscriptionEndpoint,
} from './audio-transcription';

describe('optional template audio transcription', () => {
  it('normalizes supported provider URLs without accepting arbitrary paths', () => {
    expect(normalizeAudioTranscriptionEndpoint('https://api.example.com/v1')).toBe(
      'https://api.example.com/v1/audio/transcriptions',
    );
    expect(normalizeAudioTranscriptionEndpoint('https://api.example.com/v1/chat/completions')).toBe(
      'https://api.example.com/v1/audio/transcriptions',
    );
    expect(() => normalizeAudioTranscriptionEndpoint('http://api.example.com/v1')).toThrow();
    expect(() => normalizeAudioTranscriptionEndpoint('https://api.example.com/private')).toThrow();
  });

  it('sends bounded multipart audio and returns only normalized transcript fields', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toEqual({ Authorization: 'Bearer secret' });
      const form = init?.body as FormData;
      expect(form.get('model')).toBe('whisper-test');
      expect(form.get('response_format')).toBe('json');
      expect(form.get('file')).toBeInstanceOf(Blob);
      return new Response(
        JSON.stringify({ duration: 3.2, language: 'zh', text: '  课程旁白内容  ', ignored: true }),
        { headers: { 'content-type': 'application/json' }, status: 200 },
      );
    });
    const transcribe = createOpenAICompatibleAudioTranscriber({
      apiKey: 'secret',
      baseUrl: 'https://api.example.com/v1',
      fetcher,
      model: 'whisper-test',
    });
    await expect(
      transcribe({
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: 'audio/mpeg',
        name: 'lesson.mp3',
        scope: { sessionId: 'account', userId: 'owner' },
      }),
    ).resolves.toEqual({ durationSeconds: 3.2, language: 'zh', text: '课程旁白内容' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('fails closed without exposing provider response bodies', async () => {
    const transcribe = createOpenAICompatibleAudioTranscriber({
      apiKey: 'secret',
      baseUrl: 'https://api.example.com/v1',
      fetcher: vi.fn(async () => new Response('private upstream details', { status: 429 })),
    });
    const failure = transcribe({
      bytes: new Uint8Array([1]),
      mimeType: 'audio/mpeg',
      name: 'lesson.mp3',
      scope: { sessionId: 'account', userId: 'owner' },
    });
    await expect(failure).rejects.toThrow('HTTP 429');
    await expect(failure).rejects.not.toThrow('private upstream details');
  });
});
