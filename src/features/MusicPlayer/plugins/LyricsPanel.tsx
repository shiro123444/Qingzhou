'use client';

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { useMusicPlugins, useMusicPluginState } from './context';
import { styles } from './ui.style';

export default function LyricsPanel({ visible }: { visible: boolean }) {
  const { t } = useTranslation('music');
  const host = useMusicPlugins();
  const status = useMusicPluginState((state) => state.status);
  const lyrics = useMusicPluginState((state) => state.lyrics);
  const userId = useMusicPluginState((state) => state.userId);
  const scroll = useRef<HTMLDivElement>(null);
  const highlight = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const container = scroll.current;
    const line = highlight.current;
    if (!visible || status !== 'active' || !container || !line) return;
    container.scrollTop = Math.max(
      0,
      container.scrollTop +
        line.getBoundingClientRect().top -
        container.getBoundingClientRect().top -
        (container.clientHeight - line.clientHeight) / 2,
    );
  }, [lyrics?.currentLine, lyrics?.lines, lyrics?.trackId, status, visible]);

  return (
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
          <button className={styles.emptyAction} disabled={!userId} onClick={() => lyrics.retry()}>
            {t('lyricsRetry')}
          </button>
        </div>
      ) : !lyrics?.lines.length ? (
        <div className={styles.emptyLyrics}>
          <p>{t(lyrics?.source === 'kugou' ? 'lyricsUnavailable' : 'emptyLyrics')}</p>
          <span>{t(lyrics?.source === 'kugou' ? 'lyricsAutomaticHint' : 'lyricHint')}</span>
        </div>
      ) : (
        lyrics.lines.map((line, index) => (
          <p
            aria-current={index === lyrics.currentLine}
            key={lyrics.trackId + ':' + index + ':' + line.timeMs}
            ref={index === lyrics.currentLine ? highlight : undefined}
          >
            <button onClick={() => lyrics.seekLine(index)}>{line.text || '♪'}</button>
          </p>
        ))
      )}
    </div>
  );
}
