'use client';

import { Icon } from '@lobehub/ui';
import { cx } from 'antd-style';
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

import { liquidGlass } from '@/styles/liquidGlass';

import { styles } from './capsule.style';
import { useAudioEngine, useMusicPlayer } from './context';
import { type RepeatMode } from './engine';
import { formatTime } from './lyrics';
import { musicTheme } from './musicTheme';
import { useCapsuleMotion } from './useCapsuleMotion';
import { useCapsulePosition } from './useCapsulePosition';

function TrackArtwork({ coverUrl }: { coverUrl?: string }) {
  const [failed, setFailed] = useState(false);
  return coverUrl && !failed ? (
    <img alt="" draggable={false} src={coverUrl} onError={() => setFailed(true)} />
  ) : (
    <Icon aria-hidden icon={Music2} size={{ size: 24, strokeWidth: 1.75 }} />
  );
}

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
  const panelOpen = details && !collapsed;
  const morphing = useCapsuleMotion(collapsed, panelOpen, dock);
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
      if (event.key === 'Escape') {
        if (dock.current?.querySelector('[data-music-panel]')?.contains(document.activeElement))
          dock.current.querySelector<HTMLButtonElement>('[data-capsule-more]')?.focus();
        setDetails(false);
      }
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
    dock.current?.querySelector<HTMLElement>('[data-capsule-body]')?.focus({ preventScroll: true });
    setCollapsedPreference(true);
    setDetails(false);
  };
  const repeatModes: RepeatMode[] = ['sequence', 'list', 'single'];

  return (
    <section
      {...position.surfaceProps}
      data-qz-glass-motion
      aria-label={t('player')}
      className={cx(styles.dock, musicTheme, liquidGlass)}
      data-collapsed={collapsed}
      data-dragging={position.dragging}
      data-panel-side={position.panelSide}
      data-positioned={position.ready}
      data-qz-glass-morphing={morphing}
      data-testid="music-capsule"
      ref={dock}
      style={position.style}
    >
      <div
        data-music-panel
        aria-hidden={!panelOpen}
        aria-label={t('capsuleDetails')}
        className={cx(styles.panel, styles.glass)}
        data-open={panelOpen}
        data-qz-glass="panel"
        inert={!panelOpen}
      >
        <div className={styles.panelHeading}>
          <span>
            <Icon aria-hidden icon={ListMusic} size={{ size: 18, strokeWidth: 1.75 }} />
            {t('queue')} <small>{s.queue.length}</small>
          </span>
          <span className={styles.transport}>
            <button
              aria-label={t('capsuleResetPosition')}
              className={styles.iconButton}
              title={t('capsuleResetPosition')}
              onClick={position.reset}
            >
              <Icon aria-hidden icon={RotateCcw} size={{ size: 18, strokeWidth: 1.75 }} />
            </button>
            <Link aria-label={t('openStudio')} to="/music" onClick={() => setDetails(false)}>
              <Icon aria-hidden icon={ExternalLink} size={{ size: 18, strokeWidth: 1.75 }} />
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
                      <Icon aria-hidden icon={AudioLines} size={{ size: 18, strokeWidth: 1.75 }} />
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
            <Icon aria-hidden icon={Shuffle} size={{ size: 18, strokeWidth: 1.75 }} />
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
            {s.repeat === 'single' ? (
              <Icon aria-hidden icon={Repeat1} size={{ size: 18, strokeWidth: 1.75 }} />
            ) : (
              <Icon aria-hidden icon={Repeat} size={{ size: 18, strokeWidth: 1.75 }} />
            )}
          </button>
          <label className={styles.volume}>
            <Icon aria-hidden icon={Volume2} size={{ size: 18, strokeWidth: 1.75 }} />
            <input
              aria-label={t('capsuleVolume')}
              data-capsule-range="volume"
              max={1}
              min={0}
              step={0.01}
              type="range"
              value={position.rangeValue('volume', s.volume)}
              onChange={(event) => position.changeRange(event, (value) => engine.setVolume(value))}
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
      <div
        data-capsule-body
        aria-description={t('capsuleDragHint')}
        aria-label={t('capsuleDrag')}
        className={cx(styles.capsule, styles.glass)}
        data-empty={!s.queue.length}
        data-qz-glass="capsule"
        role="group"
        tabIndex={0}
      >
        <div aria-hidden={!collapsed} className={styles.orb} inert={!collapsed}>
          <button
            data-capsule-expand
            aria-expanded={false}
            aria-label={t('capsuleExpand')}
            className={styles.artworkLink}
            title={`${track?.name ?? t('title')} · ${t('capsuleDragHint')}`}
            onClick={(event) => {
              if (!event.defaultPrevented) {
                dock.current
                  ?.querySelector<HTMLElement>('[data-capsule-body]')
                  ?.focus({ preventScroll: true });
                setCollapsedPreference(false);
              }
            }}
          >
            <span aria-hidden className={styles.record} data-playing={s.status === 'playing'}>
              <TrackArtwork coverUrl={track?.coverUrl} key={track?.coverUrl ?? 'empty'} />
            </span>
            {s.status === 'playing' && <span className={styles.orbIndicator} />}
          </button>
        </div>
        <div aria-hidden={collapsed} className={styles.expanded} inert={collapsed}>
          <Link aria-label={t('openStudio')} className={styles.artworkLink} to="/music">
            <span aria-hidden className={styles.record} data-playing={s.status === 'playing'}>
              <TrackArtwork coverUrl={track?.coverUrl} key={track?.coverUrl ?? 'empty'} />
            </span>
          </Link>
          <Link className={styles.track} to="/music">
            <strong title={track?.name}>{track?.name ?? t('title')}</strong>
            <span className={styles.trackMeta}>
              <span>{track?.artist ?? (track ? t(s.status) : t('capsuleEmptyHint'))}</span>
              {track && <time aria-hidden>{formatTime(s.positionMs)}</time>}
            </span>
          </Link>
          {!!s.queue.length && (
            <div className={styles.transport}>
              <button
                aria-label={t('capsulePrevious')}
                className={`${styles.iconButton} ${styles.secondaryTransport}`}
                onClick={() => engine.previous()}
              >
                <Icon aria-hidden icon={SkipBack} size={{ size: 18, strokeWidth: 1.75 }} />
              </button>
              <button
                aria-label={t(playing ? 'capsulePause' : 'capsulePlay')}
                className={styles.playButton}
                onClick={() => (playing ? engine.pause() : engine.play())}
              >
                {playing ? (
                  <Icon aria-hidden icon={Pause} size={{ size: 20, strokeWidth: 1.75 }} />
                ) : (
                  <Icon aria-hidden icon={Play} size={{ size: 20, strokeWidth: 1.75 }} />
                )}
              </button>
              <button
                aria-label={t('capsuleNext')}
                className={`${styles.iconButton} ${styles.secondaryTransport}`}
                onClick={() => engine.next()}
              >
                <Icon aria-hidden icon={SkipForward} size={{ size: 18, strokeWidth: 1.75 }} />
              </button>
            </div>
          )}
          <div className={styles.utilities}>
            <button
              data-capsule-more
              aria-expanded={details}
              aria-label={t('capsuleMore')}
              className={styles.iconButton}
              onClick={() => setDetails((value) => !value)}
            >
              {details ? (
                <Icon aria-hidden icon={ChevronDown} size={{ size: 18, strokeWidth: 1.75 }} />
              ) : (
                <Icon aria-hidden icon={MoreHorizontal} size={{ size: 18, strokeWidth: 1.75 }} />
              )}
            </button>
            <button
              data-capsule-collapse
              aria-label={t('capsuleCollapse')}
              className={styles.collapseButton}
              title={t('capsuleCollapse')}
              onClick={collapse}
            >
              <Icon aria-hidden icon={ChevronUp} size={{ size: 14, strokeWidth: 1.75 }} />
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
      </div>
    </section>
  );
}
