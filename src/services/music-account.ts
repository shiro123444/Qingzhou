import {
  musicAccountLoginSchema,
  musicAccountPollSchema,
  musicAccountStatusSchema,
} from '@/types/music-account';

export class MusicAccountClient {
  constructor(private fetcher: typeof fetch = fetch) {}
  private async invoke(operation: string, challengeId?: string, signal?: AbortSignal) {
    const fetcher = this.fetcher;
    const response = await fetcher('/api/runtime/music/account', {
      body: JSON.stringify({ operation, ...(challengeId ? { challengeId } : {}) }),
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal,
    });
    const body = await response.json();
    if (!response.ok || body.success !== true)
      throw new Error(body.code || 'MUSIC_ACCOUNT_UNAVAILABLE');
    return body.result as unknown;
  }
  async status(signal?: AbortSignal) {
    return musicAccountStatusSchema.parse(await this.invoke('status', undefined, signal));
  }
  async start(signal?: AbortSignal) {
    return musicAccountLoginSchema.parse(await this.invoke('start', undefined, signal));
  }
  async poll(challengeId: string, signal?: AbortSignal) {
    return musicAccountPollSchema.parse(await this.invoke('poll', challengeId, signal));
  }
  async cancel(challengeId: string, signal?: AbortSignal) {
    return musicAccountStatusSchema.parse(await this.invoke('cancel', challengeId, signal));
  }
  async disconnect(signal?: AbortSignal) {
    return musicAccountStatusSchema.parse(await this.invoke('disconnect', undefined, signal));
  }
}
export const musicAccountClient = new MusicAccountClient();
