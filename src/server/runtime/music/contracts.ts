import type { MusicPlayback, MusicTrack } from '@/types/music';

export class MusicError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

export interface MusicFile {
  fileType: string;
  id: string;
  name: string;
  size: number;
  updatedAt: Date;
  url: string;
  userId: string;
}

export interface MusicFiles {
  findById: (id: string) => Promise<MusicFile | undefined>;
  queryAudio: (input: { limit: number; query: string }) => Promise<MusicFile[]>;
}

export interface MusicStorage {
  createPreSignedUrlForPreview: (key: string, expiresIn: number) => Promise<string>;
  getFileMetadata: (key: string) => Promise<{ contentLength: number; contentType?: string }>;
}

export interface MusicProvider {
  resolve: (id: string, signal?: AbortSignal) => Promise<MusicPlayback>;
  search: (query: string, limit: number, signal?: AbortSignal) => Promise<MusicTrack[]>;
  stream: (id: string, request: Request) => Promise<Response>;
  track: (id: string, signal?: AbortSignal) => Promise<MusicTrack>;
  readonly userId: string;
}
