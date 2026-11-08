import { type Plugin } from '@lobechat/cordis-foundation';

import { activeLyric, type LyricLine, parseLrc } from '../lyrics';
import { type MusicPlayerPort, type MusicPlayerSnapshot } from '../ports';
import { type LyricsPluginView, type LyricsViewSlot, type MusicLyricsSource } from './types';

type Lines = readonly Readonly<LyricLine>[];
const EMPTY: Lines = Object.freeze([]);

/** Keep the line spanning the preview start, then expose only seekable clip-relative lines. */
export function lyricsForClip(lines: Lines, offsetMs: number, durationMs?: number): Lines {
  if (!offsetMs && !durationMs) return lines;
  const end = durationMs ? offsetMs + durationMs : Infinity;
  const visible = lines.filter((line) => line.timeMs >= offsetMs && line.timeMs < end);
  const previous = lines.findLast((line) => line.timeMs < offsetMs);
  const result: LyricLine[] = visible.map((line) => ({ ...line, timeMs: line.timeMs - offsetMs }));
  if (previous && (!visible.length || visible[0].timeMs > offsetMs))
    result.unshift({ ...previous, timeMs: 0 });
  return Object.freeze(result.map((line) => Object.freeze(line)));
}

/** Trusted native plugin: its only playback capability is seeking a lyric line. */
export const lyricsPlugin: Plugin.Object = {
  name: 'qingzhou-music-lyrics',
  inject: ['music.player', 'music.lyrics', 'music.lyricsSource'],
  apply(ctx) {
    const player = ctx.get('music.player') as MusicPlayerPort;
    const slot = ctx.get('music.lyrics') as LyricsViewSlot;
    const source = ctx.get('music.lyricsSource') as MusicLyricsSource;
    ctx.effect(() => {
      let active = true;
      let latest: MusicPlayerSnapshot;
      let identity = '';
      let controller: AbortController | undefined;
      let request = 0;
      let remoteLines: Lines = EMPTY;
      let remoteStatus: LyricsPluginView['status'] = 'empty';
      let projected:
        { duration: number | undefined; lines: Lines; offset: number; raw: Lines } | undefined;
      const cache = new Map<string, { bytes: number; lines: Lines }>();
      let cacheBytes = 0;

      const publish = () => {
        if (!active || !latest) return;
        const snapshot = latest;
        const online = snapshot.track?.source === 'kugou';
        const raw = online ? remoteLines : snapshot.lyrics.lines;
        const offset = online ? snapshot.offsetMs : 0;
        const duration =
          online && snapshot.track?.playbackKind === 'preview' && snapshot.durationMs > 0
            ? snapshot.durationMs
            : undefined;
        if (
          !projected ||
          projected.raw !== raw ||
          projected.offset !== offset ||
          projected.duration !== duration
        )
          projected = { duration, lines: lyricsForClip(raw, offset, duration), offset, raw };
        const lines = projected.lines;
        const publishedIdentity = identity;
        slot.publish(
          Object.freeze({
            currentLine: activeLyric(lines, snapshot.positionMs),
            durationMs: snapshot.durationMs,
            lines,
            positionMs: snapshot.positionMs,
            retry() {
              if (active && publishedIdentity && identity === publishedIdentity) fetchLyrics(true);
            },
            source: snapshot.track?.source ?? null,
            status: online ? remoteStatus : lines.length ? 'ready' : 'empty',
            trackId: snapshot.track?.id ?? null,
            trackName: snapshot.track?.name ?? null,
            seekLine(index: number) {
              if (!active) return;
              const current = player.getSnapshot();
              const line = lines[index];
              if (
                !Number.isSafeInteger(index) ||
                !line ||
                !snapshot.track ||
                current.track?.id !== snapshot.track.id ||
                current.offsetMs !== snapshot.offsetMs ||
                current.durationMs !== snapshot.durationMs ||
                projected?.lines !== lines
              )
                return;
              player.command({ type: 'seek', value: line.timeMs });
            },
          }),
        );
      };
      const fetchLyrics = (force = false) => {
        if (!active || latest?.track?.source !== 'kugou') return;
        const key = identity;
        const trackId = latest.track.id;
        const cached = cache.get(key);
        controller?.abort();
        const revision = ++request;
        if (cached && !force) {
          remoteLines = cached.lines;
          remoteStatus = cached.lines.length ? 'ready' : 'empty';
          publish();
          return;
        }
        controller = new AbortController();
        const signal = controller.signal;
        remoteLines = EMPTY;
        remoteStatus = 'loading';
        publish();
        void source
          .get(trackId, signal)
          .then((result) => {
            if (!active || signal.aborted || revision !== request || identity !== key) return;
            const text = result.text ?? '';
            const lines = Object.freeze(parseLrc(text).map((line) => Object.freeze(line)));
            cacheBytes -= cache.get(key)?.bytes ?? 0;
            cache.delete(key);
            const bytes = new TextEncoder().encode(text).length;
            cache.set(key, { bytes, lines });
            cacheBytes += bytes;
            while (cache.size > 32 || cacheBytes > 1024 * 1024) {
              const oldest = cache.keys().next().value!;
              cacheBytes -= cache.get(oldest)!.bytes;
              cache.delete(oldest);
            }
            remoteLines = lines;
            remoteStatus = lines.length ? 'ready' : 'empty';
            publish();
          })
          .catch(() => {
            if (!active || signal.aborted || revision !== request || identity !== key) return;
            remoteStatus = 'error';
            publish();
          });
      };
      const unsubscribe = player.subscribe((snapshot) => {
        latest = snapshot;
        const key = snapshot.track?.source === 'kugou' ? snapshot.track.id : '';
        if (key !== identity) {
          identity = key;
          controller?.abort();
          ++request;
          remoteLines = EMPTY;
          remoteStatus = 'empty';
          if (key) fetchLyrics();
        }
        publish();
      });
      return () => {
        active = false;
        controller?.abort();
        cache.clear();
        unsubscribe();
        slot.clear();
      };
    }, 'music.lyrics.subscription');
  },
};
