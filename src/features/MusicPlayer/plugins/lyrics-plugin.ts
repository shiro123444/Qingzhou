import { type Plugin } from '@lobechat/cordis-foundation';

import { type MusicPlayerPort } from '../ports';
import { type LyricsViewSlot } from './types';

/** Trusted native plugin: its only playback capability is seeking a lyric line. */
export const lyricsPlugin: Plugin.Object = {
  name: 'qingzhou-music-lyrics',
  inject: ['music.player', 'music.lyrics'],
  apply(ctx) {
    const player = ctx.get('music.player') as MusicPlayerPort;
    const slot = ctx.get('music.lyrics') as LyricsViewSlot;
    ctx.effect(() => {
      let active = true;
      const unsubscribe = player.subscribe((snapshot) => {
        slot.publish(
          Object.freeze({
            currentLine: snapshot.lyrics.currentLine,
            durationMs: snapshot.durationMs,
            lines: snapshot.lyrics.lines,
            positionMs: snapshot.positionMs,
            trackId: snapshot.track?.id ?? null,
            trackName: snapshot.track?.name ?? null,
            seekLine(index: number) {
              if (!active) return;
              const current = player.getSnapshot();
              const line = snapshot.lyrics.lines[index];
              const latest = current.lyrics.lines[index];
              if (
                !Number.isSafeInteger(index) ||
                !line ||
                !latest ||
                !snapshot.track ||
                current.track?.id !== snapshot.track.id ||
                line.timeMs !== latest.timeMs ||
                line.text !== latest.text
              )
                return;
              player.command({ type: 'seek', value: line.timeMs });
            },
          }),
        );
      });
      return () => {
        active = false;
        unsubscribe();
        slot.clear();
      };
    }, 'music.lyrics.subscription');
  },
};
