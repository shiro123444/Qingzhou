import {
  musicAccountLoginSchema,
  musicAccountPollSchema,
  musicAccountStatusSchema,
  musicLibrarySchema,
  musicPlaylistTracksSchema,
} from '@/types/music-account';

export class MusicAccountClient {
  constructor(private fetcher: typeof fetch = fetch) {}
  private async invoke(
    operation: string,
    challengeId?: string,
    signal?: AbortSignal,
    input: { page?: number; playlistId?: string } = {},
  ) {
    const fetcher = this.fetcher;
    const response = await fetcher('/api/runtime/music/account', {
      body: JSON.stringify({ operation, ...(challengeId ? { challengeId } : {}), ...input }),
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
  async library(page = 1, signal?: AbortSignal) {
    const result = musicLibrarySchema.parse(
      await this.invoke('library', undefined, signal, { page }),
    );
    if (result.page !== page) throw new Error('MUSIC_LIBRARY_MISMATCH');
    return result;
  }
  async playlist(playlistId: string, page = 1, signal?: AbortSignal) {
    const result = musicPlaylistTracksSchema.parse(
      await this.invoke('playlist', undefined, signal, { page, playlistId }),
    );
    if (result.page !== page || result.playlist.id !== playlistId)
      throw new Error('MUSIC_LIBRARY_MISMATCH');
    return result;
  }
}
export const musicAccountClient = new MusicAccountClient();
