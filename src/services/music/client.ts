import { sha256 } from 'js-sha256';

import { MAX_MUSIC_UPLOAD_BYTES, musicPlaybackSchema, musicTrackSchema } from '@/types/music';

export interface MusicUploadPort {
  register: (input: {
    fileType: string;
    hash: string;
    name: string;
    size: number;
    url: string;
  }) => Promise<{ id: string }>;
  upload: (file: File, controller: AbortController) => Promise<{ path: string }>;
}

const defaultUpload: MusicUploadPort = {
  upload: async (file, controller) => {
    const { uploadService } = await import('@/services/upload');
    const result = await uploadService.uploadFileToS3(file, {
      abortController: controller,
      directory: 'music',
    });
    if (!result.success || !result.data.path) throw new Error('MUSIC_UPLOAD_FAILED');
    return { path: result.data.path };
  },
  register: async (input) => {
    const { fileService } = await import('@/services/file');
    return fileService.createFile(input);
  },
};

/** M1 transport. Native audio can use resolve().src directly; every range is re-authorized. */
export class MusicClient {
  constructor(
    private fetcher: typeof fetch = fetch,
    private uploadPort: MusicUploadPort = defaultUpload,
  ) {}

  private async invoke(operation: string, input: unknown, signal?: AbortSignal) {
    const response = await this.fetcher('/api/runtime/music', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operation, input }),
      signal,
    });
    const data = await response.json();
    if (!response.ok || data.success !== true) throw new Error(data.code ?? 'MUSIC_REQUEST_FAILED');
    return data.result as unknown;
  }

  async search(query = '', limit = 20, signal?: AbortSignal) {
    const result = (await this.invoke('music.search', { query, limit }, signal)) as {
      tracks: unknown[];
    };
    return result.tracks.map((track) => musicTrackSchema.parse(track));
  }
  async track(trackId: string, signal?: AbortSignal) {
    return musicTrackSchema.parse(await this.invoke('music.track.get', { trackId }, signal));
  }
  async resolve(trackId: string, signal?: AbortSignal) {
    return musicPlaybackSchema.parse(
      await this.invoke('music.playback.resolve', { trackId }, signal),
    );
  }

  async uploadAudio(file: Pick<File, 'arrayBuffer' | 'name' | 'size'>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!file.size || file.size > MAX_MUSIC_UPLOAD_BYTES) throw new Error('MUSIC_UPLOAD_LIMIT');
    const { fileTypeFromBuffer } = await import('file-type');
    const bytes = await file.arrayBuffer();
    const detected = await fileTypeFromBuffer(bytes);
    if (!detected?.mime.startsWith('audio/')) throw new Error('MUSIC_AUDIO_REQUIRED');
    signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const audioFile = new File([bytes], file.name, { type: detected.mime });
      const { path } = await this.uploadPort.upload(audioFile, controller);
      signal?.throwIfAborted();
      const { id } = await this.uploadPort.register({
        fileType: detected.mime,
        hash: sha256(bytes),
        name: file.name,
        size: file.size,
        url: path,
      });
      signal?.throwIfAborted();
      return await this.track(id, signal);
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
}

export const musicClient = new MusicClient();
