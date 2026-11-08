'use client';

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { type LyricLine } from '../lyrics';
import { useMusicPlugins, useMusicPluginState } from './context';
import { createLyricsMotion } from './lyrics-motion';
import { styles } from './ui.style';

const LyricRows = memo(function LyricRows({
  lines,
  onSeek,
  trackId,
}: {
  lines: readonly Readonly<LyricLine>[];
  onSeek: (index: number) => void;
  trackId: string | null;
}) {
  return lines.map((line, index) => (
    <p
      aria-current="false"
      data-line-state="future"
      data-lyric-line={index}
      key={trackId + ':' + index + ':' + line.timeMs}
    >
      <button aria-label={line.text || undefined} onClick={() => onSeek(index)}>
        {line.words?.length
          ? line.words.map((word, wordIndex) => (
              <span
                aria-hidden
                className={styles.word}
                data-lyric-word={wordIndex}
                data-state="future"
                key={wordIndex + ':' + word.timeMs}
              >
                {word.text}
              </span>
            ))
          : line.text || '♪'}
      </button>
    </p>
  ));
});

export default function LyricsPanel({ visible }: { visible: boolean }) {
  const { t } = useTranslation('music');
  const host = useMusicPlugins();
  const status = useMusicPluginState((state) => state.status);
  const lyrics = useMusicPluginState((state) => state.lyrics);
  const userId = useMusicPluginState((state) => state.userId);
  const scroll = useRef<HTMLDivElement>(null);
  const latest = useRef(lyrics);
  latest.current = lyrics;
  const motion = useRef<ReturnType<typeof createLyricsMotion> | null>(null);
  const [following, setFollowing] = useState(true);
  const seek = useCallback((index: number) => {
    latest.current?.seekLine(index);
    motion.current?.resume();
  }, []);

  useEffect(() => {
    const container = scroll.current;
    setFollowing(true);
    if (!visible || status !== 'active' || !container || !lyrics?.lines.length) return;
    const animation = createLyricsMotion({
      container,
      getPositionMs: () => latest.current?.getPositionMs() ?? 0,
      isPlaying: () => ['playing', 'buffering'].includes(latest.current?.playbackStatus ?? ''),
      lines: lyrics.lines,
      onFollowingChange: setFollowing,
    });
    motion.current = animation;
    return () => {
      animation.dispose();
      if (motion.current === animation) motion.current = null;
    };
  }, [lyrics?.lines, lyrics?.trackId, status, visible]);
  useEffect(() => motion.current?.wake(), [lyrics?.positionMs, lyrics?.playbackStatus]);

  return (
    <div className={styles.lyricFrame}>
      <div
        aria-label={t('lyrics')}
        className={styles.lyrics}
        data-empty={status !== 'active' || !lyrics?.lines.length}
        ref={scroll}
      >
        {status === 'disabled' ? (
          <div className={styles.emptyLyrics}>
            <p>{t('lyricsPluginDisabled')}</p>
            <button
              className={styles.emptyAction}
              disabled={!userId}
              onClick={() => void host.setEnabled('lyrics', true)}
            >
              {t('enableLyricsPlugin')}
            </button>
          </div>
        ) : status === 'loading' || lyrics?.status === 'loading' ? (
          <div className={styles.emptyLyrics}>
            <p role="status">{t(status === 'loading' ? 'pluginLoading' : 'lyricsLoading')}</p>
          </div>
        ) : status === 'error' ? (
          <div className={styles.emptyLyrics}>
            <p role="alert">{t('lyricsPluginFailedHint')}</p>
            <button
              className={styles.emptyAction}
              disabled={!userId}
              onClick={() => void host.retry('lyrics')}
            >
              {t('retry')}
            </button>
          </div>
        ) : lyrics?.status === 'error' ? (
          <div className={styles.emptyLyrics}>
            <p role="alert">{t('lyricsFetchFailed')}</p>
            <button
              className={styles.emptyAction}
              disabled={!userId}
              onClick={() => lyrics.retry()}
            >
              {t('lyricsRetry')}
            </button>
          </div>
        ) : !lyrics?.lines.length ? (
          <div className={styles.emptyLyrics}>
            <p>{t(lyrics?.source === 'kugou' ? 'lyricsUnavailable' : 'emptyLyrics')}</p>
            <span>{t(lyrics?.source === 'kugou' ? 'lyricsAutomaticHint' : 'lyricHint')}</span>
          </div>
        ) : (
          <LyricRows lines={lyrics.lines} trackId={lyrics.trackId} onSeek={seek} />
        )}
      </div>
      {!following && visible && status === 'active' && !!lyrics?.lines.length && (
        <button className={styles.resumeFollowing} onClick={() => motion.current?.resume()}>
          {t('lyricsResumeFollowing')}
        </button>
      )}
    </div>
  );
}
