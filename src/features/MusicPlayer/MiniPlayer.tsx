'use client';

import {
  AudioLines,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  ListMusic,
  MoreHorizontal,
  Music2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  RotateCcw,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
} from 'lucide-react';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';

import { styles } from './capsule.style';
import { useAudioEngine, useMusicPlayer } from './context';
import { type RepeatMode } from './engine';
import { formatTime } from './lyrics';
import { useCapsulePosition } from './useCapsulePosition';

export default function MiniPlayer() {
  const { t } = useTranslation('music');
  const engine = useAudioEngine();
  const s = useMusicPlayer((state) => state);
  const { pathname } = useLocation();
  // Route compactness is only a default. The user's choice survives navigation.
  const [collapsedPreference, setCollapsedPreference] = useState<boolean | null>(null);
  const [details, setDetails] = useState(false);
  const dock = useRef<HTMLElement>(null);
  const collapsed = collapsedPreference ?? pathname === '/music';
  const position = useCapsulePosition({
    collapsed,
    details,
    dock,
    routeKey: pathname,
    userId: s.userId,
  });
  const track = s.queue.find((item) => item.id === s.activeId);
  const playing = ['playing', 'buffering', 'loading'].includes(s.status);
  const progress = s.durationMs ? Math.min(100, (s.positionMs / s.durationMs) * 100) : 0;

  useEffect(() => {
    if (!details || collapsed) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !dock.current?.contains(event.target)) setDetails(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDetails(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [collapsed, details]);

  if (!s.userId) return null;

  const collapse = () => {
    setCollapsedPreference(true);
    setDetails(false);
  };
  const repeatModes: RepeatMode[] = ['sequence', 'list', 'single'];

  return (
    <section
      {...position.surfaceProps}
      aria-label={t('player')}
      className={styles.dock}
      data-collapsed={collapsed}
      data-dragging={position.dragging}
      data-panel-side={position.panelSide}
      data-positioned={position.ready}
      data-testid="music-capsule"
      ref={dock}
      style={position.style}
    >
      {!collapsed && details && (
        <div data-music-panel aria-label={t('capsuleDetails')} className={styles.panel}>
          <div className={styles.panelHeading}>
            <span>
              <ListMusic size={15} />
              {t('queue')} <small>{s.queue.length}</small>
            </span>
            <span className={styles.transport}>
              <button
                aria-label={t('capsuleResetPosition')}
                className={styles.iconButton}
                title={t('capsuleResetPosition')}
                onClick={position.reset}
              >
                <RotateCcw size={15} />
              </button>
              <Link aria-label={t('openStudio')} to="/music" onClick={() => setDetails(false)}>
                <ExternalLink size={15} />
              </Link>
            </span>
          </div>
          {s.queue.length ? (
            <ol aria-label={t('capsuleQueue')} className={styles.queue}>
              {s.queue.map((item, index) => (
                <li key={item.id}>
                  <button
                    aria-current={s.activeId === item.id}
                    aria-label={`${t('capsulePlay')} ${item.name}`}
                    className={styles.queueTrack}
                    onClick={() => engine.playTrack(item)}
                  >
                    <span className={styles.queueNumber}>
                      {s.activeId === item.id ? (
                        <AudioLines size={14} />
                      ) : (
                        String(index + 1).padStart(2, '0')
                      )}
                    </span>
                    <span>{item.name}</span>
                    {s.activeId === item.id && <span className={styles.activeDot} />}
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className={styles.empty}>{t('emptyQueue')}</p>
          )}
          <div className={styles.settings}>
            <button
              aria-label={t('capsuleShuffle')}
              aria-pressed={s.shuffle}
              className={styles.iconButton}
              title={t('shuffle')}
              onClick={() => engine.setShuffle(!s.shuffle)}
            >
              <Shuffle size={16} />
            </button>
            <button
              aria-label={t('capsuleRepeat')}
              aria-pressed={s.repeat !== 'sequence'}
              className={styles.iconButton}
              title={t(s.repeat)}
              onClick={() =>
                engine.setRepeat(
                  repeatModes[(repeatModes.indexOf(s.repeat) + 1) % repeatModes.length],
                )
              }
            >
              {s.repeat === 'single' ? <Repeat1 size={16} /> : <Repeat size={16} />}
            </button>
            <label className={styles.volume}>
              <Volume2 aria-hidden size={16} />
              <input
                aria-label={t('capsuleVolume')}
                data-capsule-range="volume"
                max={1}
                min={0}
                step={0.01}
                type="range"
                value={position.rangeValue('volume', s.volume)}
                onChange={(event) =>
                  position.changeRange(event, (value) => engine.setVolume(value))
                }
              />
            </label>
          </div>
          {(s.error || s.storageWarning || s.restoring || position.storageWarning) && (
            <p className={styles.notice} role="status">
              {t(
                s.restoring
                  ? 'restoring'
                  : s.error
                    ? s.status
                    : position.storageWarning
                      ? 'capsulePositionWarning'
                      : 'storageWarning',
              )}
            </p>
          )}
        </div>
      )}
      {collapsed ? (
        <div
          data-capsule-body
          aria-description={t('capsuleDragHint')}
          aria-label={t('capsuleDrag')}
          className={styles.orb}
          role="group"
          tabIndex={0}
        >
          <button
            aria-expanded={false}
            aria-label={t('capsuleExpand')}
            className={styles.artworkLink}
            title={`${track?.name ?? t('title')} · ${t('capsuleDragHint')}`}
            onClick={(event) => {
              if (!event.defaultPrevented) setCollapsedPreference(false);
            }}
          >
            <span aria-hidden className={styles.record} data-playing={s.status === 'playing'}>
              <Music2 size={24} />
            </span>
            {s.status === 'playing' && <span className={styles.orbIndicator} />}
          </button>
        </div>
      ) : (
        <div
          data-capsule-body
          aria-description={t('capsuleDragHint')}
          aria-label={t('capsuleDrag')}
          className={styles.capsule}
          data-empty={!s.queue.length}
          role="group"
          tabIndex={0}
        >
          <Link aria-label={t('openStudio')} className={styles.artworkLink} to="/music">
            <span aria-hidden className={styles.record} data-playing={s.status === 'playing'}>
              <Music2 size={21} />
            </span>
          </Link>
          <Link className={styles.track} to="/music">
            <strong title={track?.name}>{track?.name ?? t('title')}</strong>
            <span>{track ? t(s.status) : t('capsuleEmptyHint')}</span>
          </Link>
          {!!s.queue.length && (
            <div className={styles.transport}>
              <button
                aria-label={t('capsulePrevious')}
                className={`${styles.iconButton} ${styles.secondaryTransport}`}
                onClick={() => engine.previous()}
              >
                <SkipBack fill="currentColor" size={15} />
              </button>
              <button
                aria-label={t(playing ? 'capsulePause' : 'capsulePlay')}
                className={styles.playButton}
                onClick={() => (playing ? engine.pause() : engine.play())}
              >
                {playing ? (
                  <Pause fill="currentColor" size={25} />
                ) : (
                  <Play fill="currentColor" size={25} />
                )}
              </button>
              <button
                aria-label={t('capsuleNext')}
                className={`${styles.iconButton} ${styles.secondaryTransport}`}
                onClick={() => engine.next()}
              >
                <SkipForward fill="currentColor" size={15} />
              </button>
            </div>
          )}
          <div className={styles.utilities}>
            <button
              aria-expanded={details}
              aria-label={t('capsuleMore')}
              className={styles.iconButton}
              onClick={() => setDetails((value) => !value)}
            >
              {details ? <ChevronDown size={17} /> : <MoreHorizontal size={17} />}
            </button>
            <button
              aria-label={t('capsuleCollapse')}
              className={styles.collapseButton}
              title={t('capsuleCollapse')}
              onClick={collapse}
            >
              <ChevronUp size={12} />
            </button>
          </div>
          {!!s.queue.length && (
            <div
              className={styles.progress}
              style={{ '--music-progress': `${progress}%` } as CSSProperties}
            >
              <input
                aria-label={t('capsuleSeek')}
                aria-valuetext={`${formatTime(s.positionMs)} / ${formatTime(s.durationMs)}`}
                data-capsule-range="seek"
                disabled={!s.durationMs}
                max={s.durationMs || 1}
                min={0}
                step={100}
                type="range"
                value={position.rangeValue('seek', Math.min(s.positionMs, s.durationMs || 0))}
                onChange={(event) => position.changeRange(event, (value) => engine.seek(value))}
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
