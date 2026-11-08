import { MusicError, type MusicProvider } from './contracts';

/** One account boundary and one playback engine, with explicit catalog routing. */
export class CatalogMusicProvider implements MusicProvider {
  constructor(
    readonly userId: string,
    private library: MusicProvider,
    private kugou: MusicProvider,
  ) {}

  private provider(id: string) {
    return id.startsWith('kugou:') ? this.kugou : this.library;
  }

  search(
    query: string,
    limit: number,
    signal?: AbortSignal,
    source: 'library' | 'kugou' = 'library',
  ) {
    return (source === 'kugou' ? this.kugou : this.library).search(query, limit, signal);
  }
  track(id: string, signal?: AbortSignal) {
    return this.provider(id).track(id, signal);
  }
  resolve(id: string, signal?: AbortSignal) {
    return this.provider(id).resolve(id, signal);
  }
  stream(id: string, request: Request) {
    return this.provider(id).stream(id, request);
  }
  cover(id: string, request: Request) {
    const provider = this.provider(id);
    if (!provider.cover) throw new MusicError('MUSIC_TRACK_UNAVAILABLE', 404);
    return provider.cover(id, request);
  }
}
