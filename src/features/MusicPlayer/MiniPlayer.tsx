'use client';

import { Button } from '@lobehub/ui';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { useAudioEngine, useMusicPlayer } from './context';
import { type RepeatMode } from './engine';
import { formatTime } from './lyrics';
import { styles } from './style';

export default function MiniPlayer() {
  const { t } = useTranslation('music');
  const engine = useAudioEngine();
  const s = useMusicPlayer((state) => state);
  if (!s.userId) return null;
  const track = s.queue.find((item) => item.id === s.activeId);
  const playing = ['playing', 'buffering', 'loading'].includes(s.status);
  return (
    <section aria-label={t('player')} className={styles.mini}>
      <div className={styles.trackName}>
        <Link to="/music">{t('title')}</Link>
        <div title={track?.name}>{track?.name ?? t('emptyPlayer')}</div>
      </div>
      {s.queue.length > 0 && (
        <>
          <div className={styles.controls}>
            <Button
              aria-label={t('previous')}
              icon={SkipBack}
              size="small"
              onClick={() => engine.previous()}
            />
            <Button
              aria-label={t(playing ? 'pause' : 'play')}
              icon={playing ? Pause : Play}
              size="small"
              onClick={() => (playing ? engine.pause() : engine.play())}
            />
            <Button
              aria-label={t('next')}
              icon={SkipForward}
              size="small"
              onClick={() => engine.next()}
            />
          </div>
          <div className={styles.progress}>
            <span>{formatTime(s.positionMs)}</span>
            <input
              aria-label={t('seek')}
              disabled={!s.durationMs}
              max={s.durationMs || 1}
              min={0}
              step={100}
              type="range"
              value={Math.min(s.positionMs, s.durationMs || 0)}
              onChange={(event) => engine.seek(Number(event.target.value))}
            />
            <span>{formatTime(s.durationMs)}</span>
          </div>
          <select
            aria-label={t('repeat')}
            value={s.repeat}
            onChange={(event) => engine.setRepeat(event.target.value as RepeatMode)}
          >
            <option value="sequence">{t('sequence')}</option>
            <option value="list">{t('list')}</option>
            <option value="single">{t('single')}</option>
          </select>
          <Button
            aria-pressed={s.shuffle}
            size="small"
            type={s.shuffle ? 'primary' : 'default'}
            onClick={() => engine.setShuffle(!s.shuffle)}
          >
            {t('shuffle')}
          </Button>
          <label className={styles.volume}>
            {t('volume')}
            <input
              aria-label={t('volume')}
              max={1}
              min={0}
              step={0.01}
              type="range"
              value={s.volume}
              onChange={(event) => engine.setVolume(Number(event.target.value))}
            />
          </label>
          <span aria-live="polite">{t(s.status)}</span>
          {s.error && (
            <Button size="small" onClick={() => engine.play()}>
              {t('retry')}
            </Button>
          )}
        </>
      )}
      {s.restoring && <span role="status">{t('restoring')}</span>}
      {s.storageWarning && <span role="status">{t('storageWarning')}</span>}
    </section>
  );
}
