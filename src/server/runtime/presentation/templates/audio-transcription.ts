import type { RuntimeScope } from '../../../../../packages/runtime-contracts/src';

const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const DEFAULT_MODEL = 'whisper-1';

export interface PresentationAudioTranscriptionInput {
  bytes: Uint8Array;
  mimeType: string;
  name: string;
  scope: RuntimeScope;
  signal?: AbortSignal;
}

export interface PresentationAudioTranscriptionResult {
  durationSeconds?: number;
  language?: string;
  text: string;
}

export type PresentationAudioTranscriber = (
  input: PresentationAudioTranscriptionInput,
) => Promise<PresentationAudioTranscriptionResult>;

export interface OpenAICompatibleAudioTranscriberOptions {
  apiKey: string;
  baseUrl: string;
  fetcher: typeof fetch;
  model?: string;
}

export const normalizeAudioTranscriptionEndpoint = (baseUrl: string): string => {
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl.trim());
  } catch {
    throw new Error('Audio transcription base URL is invalid');
  }
  const local = ['127.0.0.1', '::1', 'localhost'].includes(endpoint.hostname);
  if (
    !endpoint.hostname ||
    (endpoint.protocol !== 'https:' && !(local && endpoint.protocol === 'http:')) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('Audio transcription base URL must be a trusted HTTP(S) endpoint');
  const path = endpoint.pathname.replace(/\/+$/u, '');
  if (path === '' || path === '/v1') endpoint.pathname = '/v1/audio/transcriptions';
  else if (path === '/v1/chat/completions') endpoint.pathname = '/v1/audio/transcriptions';
  else if (path !== '/v1/audio/transcriptions')
    throw new Error('Audio transcription base URL path is unsupported');
  return endpoint.toString();
};

/** Server-owned optional STT adapter. Audio is sent only after an explicit user choice. */
export const createOpenAICompatibleAudioTranscriber = (
  options: OpenAICompatibleAudioTranscriberOptions,
): PresentationAudioTranscriber => {
  const apiKey = options.apiKey?.trim();
  const model = options.model?.trim() || DEFAULT_MODEL;
  const endpoint = normalizeAudioTranscriptionEndpoint(options.baseUrl);
  if (!apiKey) throw new Error('Audio transcription API key is required');
  if (typeof options.fetcher !== 'function')
    throw new Error('Audio transcription fetcher is required');

  return async (input) => {
    if (input.signal?.aborted) throw new Error('Audio transcription was cancelled');
    if (!(input.bytes instanceof Uint8Array) || !input.bytes.length)
      throw new Error('Audio transcription input is empty');
    if (input.bytes.length > MAX_AUDIO_BYTES)
      throw new Error('Audio transcription input exceeds 24 MiB');
    if (!/^audio\/(?:aac|mp4|mpeg|ogg|wav|webm|x-m4a)$/iu.test(input.mimeType))
      throw new Error('Audio transcription format is unsupported');
    const body = new FormData();
    const audioBuffer = new ArrayBuffer(input.bytes.byteLength);
    new Uint8Array(audioBuffer).set(input.bytes);
    body.append('file', new Blob([audioBuffer], { type: input.mimeType }), input.name);
    body.append('model', model);
    body.append('response_format', 'json');
    const response = await options.fetcher(endpoint, {
      body,
      headers: { Authorization: `Bearer ${apiKey}` },
      method: 'POST',
      signal: input.signal,
    });
    if (!response.ok)
      throw new Error(`Audio transcription provider returned HTTP ${response.status}`);
    const value = (await response.json()) as Record<string, unknown>;
    const text = typeof value.text === 'string' ? value.text.trim() : '';
    if (!text) throw new Error('Audio transcription provider returned no text');
    return {
      ...(typeof value.duration === 'number' && Number.isFinite(value.duration)
        ? { durationSeconds: value.duration }
        : {}),
      ...(typeof value.language === 'string' && value.language.trim()
        ? { language: value.language.trim() }
        : {}),
      text: text.slice(0, 12_000),
    };
  };
};
