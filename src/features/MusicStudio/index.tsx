'use client';

import { Button } from '@lobehub/ui';
import { Alert, Input } from 'antd';
import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  ChevronDown,
  ListMusic,
  ListPlus,
  Music2,
  Pause,
  Play,
  Repeat2,
  Search,
  Shuffle,
  SkipBack,
  SkipForward,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { useAudioEngine, useMusicPlayer } from '@/features/MusicPlayer/context';
import { type RepeatMode } from '@/features/MusicPlayer/engine';
import { formatTime, MAX_LRC_BYTES } from '@/features/MusicPlayer/lyrics';
import { useMusicPluginState } from '@/features/MusicPlayer/plugins/context';
import LyricsPanel from '@/features/MusicPlayer/plugins/LyricsPanel';
import MusicPluginSettings from '@/features/MusicPlayer/plugins/MusicPluginSettings';
import { type MusicTrack } from '@/types/music';

import { styles } from './style';

const views = ['player', 'library', 'queue', 'plugins'] as const;
type StudioView = (typeof views)[number];

export default function MusicStudio() {
  const { t } = useTranslation('music');
  const engine = useAudioEngine();
  const lyricsStatus = useMusicPluginState((state) => state.status);
  const s = useMusicPlayer((state) => state);
  const [library, setLibrary] = useState<{ tracks: MusicTrack[]; userId: string | null }>({
    tracks: [],
    userId: null,
  });
  const tracks = library.userId === s.userId ? library.tracks : [];
  const [query, setQuery] = useState('');
  const [view, setView] = useState<StudioView>('player');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<'requestError' | 'uploadError' | 'lyricError' | null>(null);
  const [revision, setRevision] = useState(0);
  const upload = useRef<HTMLInputElement>(null);
  const lyricInput = useRef<HTMLInputElement>(null);
  const lifetime = useRef<AbortController | null>(null);
  const active = s.queue.find((item) => item.id === s.activeId);
  const playing = ['playing', 'buffering', 'loading'].includes(s.status);
  const activeIndex = s.queue.findIndex((track) => track.id === s.activeId);
  const displayedTracks = view === 'library' ? tracks : s.queue;
  const audioFormat = (track: MusicTrack) =>
    track.mimeType === 'audio/mpeg' ? 'MP3' : track.mimeType.split('/')[1]?.toUpperCase();
  const audioSize = (track: MusicTrack) => (track.size / (1024 * 1024)).toFixed(1) + ' MB';

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setUploading(false);
    setError(null);
    return () => controller.abort();
  }, [s.userId]);

  useEffect(() => {
    setLibrary({ tracks: [], userId: s.userId });
    setLoading(false);
    if (!s.userId) return;
    const controller = new AbortController();
    const isCurrent = () =>
      !controller.signal.aborted && engine.store.getState().userId === s.userId;
    const timer = setTimeout(() => {
      setLoading(true);
      void engine.client
        .search(query, 50, controller.signal)
        .then((result) => {
          if (isCurrent()) {
            setLibrary({ tracks: result, userId: s.userId });
            setError((current) => (current === 'requestError' ? null : current));
          }
        })
        .catch(() => {
          if (isCurrent()) setError('requestError');
        })
        .finally(() => {
          if (isCurrent()) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [engine, query, revision, s.userId]);

  async function uploadAudio(file?: File) {
    const controller = lifetime.current;
    if (!file || !controller || controller.signal.aborted || !s.userId) return;
    const isCurrent = () =>
      !controller.signal.aborted && engine.store.getState().userId === s.userId;
    setUploading(true);
    setError(null);
    try {
      await engine.client.uploadAudio(file, controller.signal);
      if (isCurrent()) {
        setQuery('');
        setView('library');
        setRevision((value) => value + 1);
      }
    } catch {
      if (isCurrent()) setError('uploadError');
    } finally {
      if (isCurrent()) setUploading(false);
    }
  }

  async function importLyrics(file?: File) {
    const controller = lifetime.current;
    const id = s.activeId;
    if (!file || !id || !controller || controller.signal.aborted) return;
    try {
      if (file.size > MAX_LRC_BYTES) throw new Error('LRC_LIMIT');
      const text = await file.text();
      if (!controller.signal.aborted && engine.store.getState().userId === s.userId) {
        engine.importLyrics(id, text);
        setError(null);
      }
    } catch {
      if (!controller.signal.aborted && engine.store.getState().userId === s.userId)
        setError('lyricError');
    }
  }

  function playTrack(track: MusicTrack) {
    engine.playTrack(track);
    setView('player');
  }

  return (
    <main aria-label={t('player')} className={styles.studio} data-view={view}>
      <div className={styles.inner}>
        <header className={styles.header}>
          <div className={styles.brand}>
            <AudioLines aria-hidden size={23} strokeWidth={1.7} />
            <h1>{t('title')}</h1>
          </div>
          <div aria-label={t('viewNavigation')} className={styles.tabs} role="tablist">
            {views.map((item) => {
              const label = t(item === 'player' ? 'nowPlaying' : item);
              return (
                <button
                  aria-controls={'music-view-' + item}
                  aria-label={label}
                  aria-selected={view === item}
                  className={styles.tab}
                  id={'music-tab-' + item}
                  key={item}
                  role="tab"
                  tabIndex={view === item ? 0 : -1}
                  onClick={() => setView(item)}
                  onKeyDown={(event) => {
                    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                    event.preventDefault();
                    const index = views.indexOf(item);
                    const next =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? views.length - 1
                          : (index + (event.key === 'ArrowRight' ? 1 : -1) + views.length) %
                            views.length;
                    setView(views[next]);
                    document.getElementById('music-tab-' + views[next])?.focus();
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className={styles.headerActions}>
            <Button
              className={styles.uploadButton}
              disabled={!s.userId}
              icon={Upload}
              loading={uploading}
              type="text"
              onClick={() => upload.current?.click()}
            >
              {t('upload')}
            </Button>
            <Link
              aria-label={t('closeStudio')}
              className={styles.closeButton}
              title={t('closeStudio')}
              to="/"
            >
              <ChevronDown aria-hidden size={27} />
            </Link>
          </div>
        </header>
        <input
          hidden
          accept="audio/*"
          aria-label={t('upload')}
          ref={upload}
          type="file"
          onChange={(event) => {
            void uploadAudio(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        <input
          hidden
          accept=".lrc,text/plain"
          aria-label={t('importLrc')}
          ref={lyricInput}
          type="file"
          onChange={(event) => {
            void importLyrics(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
        {!s.userId && <Alert showIcon title={t('login')} type="info" />}
        {error && (
          <Alert closable showIcon title={t(error)} type="error" onClose={() => setError(null)} />
        )}

        <div
          aria-labelledby="music-tab-player"
          className={styles.scene}
          hidden={view !== 'player'}
          id="music-view-player"
          role="tabpanel"
        >
          <section aria-label={t('nowPlaying')} className={styles.player}>
            <div aria-hidden className={styles.cover}>
              <Music2 size={104} strokeWidth={1.1} />
            </div>
            <div className={styles.trackInfo}>
              <h2 className={styles.trackTitle} title={active?.name}>
                {active?.name ?? t('chooseTrack')}
              </h2>
              <p className={styles.trackDescription}>
                {active ? audioFormat(active) + ' · ' + audioSize(active) : t('fromLibrary')}
              </p>
            </div>
            <div className={styles.timeline}>
              <span>{formatTime(s.positionMs)}</span>
              <input
                aria-label={t('seek')}
                disabled={!s.durationMs}
                max={s.durationMs || 1}
                min={0}
                step={100}
                type="range"
                value={Math.min(s.positionMs, s.durationMs || 0)}
                style={{
                  background: `linear-gradient(to right, #69a5de ${Math.min(100, (s.positionMs / (s.durationMs || 1)) * 100)}%, rgb(255 255 255 / 28%) 0)`,
                }}
                onChange={(event) => engine.seek(Number(event.target.value))}
              />
              <span>{formatTime(s.durationMs)}</span>
            </div>
            <div className={styles.transport}>
              <button
                aria-label={t('shuffle')}
                aria-pressed={s.shuffle}
                className={styles.iconButton}
                data-active={s.shuffle}
                disabled={!s.queue.length}
                onClick={() => engine.setShuffle(!s.shuffle)}
              >
                <Shuffle size={22} />
              </button>
              <button
                aria-label={t('previous')}
                className={styles.iconButton}
                disabled={!s.queue.length}
                onClick={() => engine.previous()}
              >
                <SkipBack fill="currentColor" size={25} />
              </button>
              <button
                aria-label={t(playing ? 'pause' : 'play')}
                className={styles.playButton}
                disabled={!s.queue.length}
                onClick={() => (playing ? engine.pause() : engine.play())}
              >
                {playing ? (
                  <Pause fill="currentColor" size={30} />
                ) : (
                  <Play fill="currentColor" size={30} />
                )}
              </button>
              <button
                aria-label={t('next')}
                className={styles.iconButton}
                disabled={!s.queue.length}
                onClick={() => engine.next()}
              >
                <SkipForward fill="currentColor" size={25} />
              </button>
              <label className={styles.repeatControl} data-active={s.repeat !== 'sequence'}>
                <Repeat2 aria-hidden size={25} />
                <select
                  aria-label={t('repeat')}
                  value={s.repeat}
                  onChange={(event) => engine.setRepeat(event.target.value as RepeatMode)}
                >
                  <option value="sequence">{t('sequence')}</option>
                  <option value="list">{t('list')}</option>
                  <option value="single">{t('single')}</option>
                </select>
                {s.repeat === 'single' && <span aria-hidden>1</span>}
              </label>
            </div>
            <div className={styles.playerFoot}>
              <button
                aria-label={t('queue')}
                className={styles.queuePosition}
                onClick={() => setView('queue')}
              >
                <ListMusic size={15} />
                {activeIndex >= 0 ? activeIndex + 1 : '—'} / {s.queue.length}
              </button>
              <span className={styles.status}>{t(s.status)}</span>
              <label className={styles.volume}>
                {s.volume === 0 ? (
                  <VolumeX aria-hidden size={16} />
                ) : (
                  <Volume2 aria-hidden size={16} />
                )}
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
            </div>
            {!active && (
              <button className={styles.chooseButton} onClick={() => setView('library')}>
                {t('library')}
              </button>
            )}
            {s.error && (
              <Button size="small" onClick={() => engine.play()}>
                {t('retry')}
              </Button>
            )}
          </section>

          <section className={styles.lyricPanel}>
            <div className={styles.lyricToolbar}>
              <Button
                disabled={!active || lyricsStatus !== 'active'}
                size="small"
                type="text"
                onClick={() => lyricInput.current?.click()}
              >
                {t('importLrc')}
              </Button>
            </div>
            <LyricsPanel visible={view === 'player'} />
          </section>
        </div>

        <section
          aria-labelledby={view === 'queue' ? 'music-tab-queue' : 'music-tab-library'}
          className={styles.collection}
          hidden={view !== 'library' && view !== 'queue'}
          id={'music-view-' + (view === 'queue' ? 'queue' : 'library')}
          role="tabpanel"
        >
          <div className={styles.collectionHeading}>
            <h2>{t(view === 'queue' ? 'queue' : 'library')}</h2>
            <span>{displayedTracks.length}</span>
          </div>
          <div className={styles.collectionToolbar}>
            <Button
              disabled={!displayedTracks.length}
              icon={Play}
              onClick={() => {
                engine.enqueue(displayedTracks);
                if (displayedTracks[0]) playTrack(displayedTracks[0]);
              }}
            >
              {t('playAll')}
            </Button>
            {view !== 'queue' && (
              <Input
                allowClear
                aria-label={t('search')}
                className={styles.search}
                maxLength={200}
                placeholder={t('search')}
                prefix={<Search aria-hidden size={16} />}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onPressEnter={() => setRevision((value) => value + 1)}
              />
            )}
          </div>
          {loading && view === 'library' && (
            <p className={styles.loading} role="status">
              {t('loading')}
            </p>
          )}
          {error === 'requestError' && view === 'library' && (
            <Button onClick={() => setRevision((value) => value + 1)}>{t('retry')}</Button>
          )}
          {!loading && displayedTracks.length === 0 && (
            <div className={styles.emptyCollection}>
              <Music2 aria-hidden size={42} strokeWidth={1} />
              <h3>
                {view === 'queue'
                  ? t('emptyQueue')
                  : query
                    ? t('noSearchResults')
                    : t('emptyLibrary')}
              </h3>
              <p>{query ? t('noSearchResultsHint') : t('chooseTrackHint')}</p>
              {view !== 'queue' && !query && (
                <Button
                  disabled={!s.userId}
                  icon={Upload}
                  loading={uploading}
                  onClick={() => upload.current?.click()}
                >
                  {t('upload')}
                </Button>
              )}
            </div>
          )}
          <ul aria-label={t('library')} className={styles.list} hidden={view === 'queue'}>
            {tracks.map((track, index) => (
              <li aria-current={s.activeId === track.id} className={styles.trackRow} key={track.id}>
                <span aria-hidden className={styles.rowNumber}>
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span aria-hidden className={styles.trackArt}>
                  <Music2 size={21} strokeWidth={1.4} />
                </span>
                <div className={styles.rowInfo}>
                  <span className={styles.name} title={track.name}>
                    {track.name}
                  </span>
                  <span className={styles.fileMeta}>{audioFormat(track)}</span>
                </div>
                <span className={styles.fileSize}>{audioSize(track)}</span>
                <div className={styles.rowActions}>
                  <Button
                    aria-label={t('play') + ' ' + track.name}
                    icon={Play}
                    size="small"
                    type="text"
                    onClick={() => playTrack(track)}
                  />
                  <Button
                    aria-label={t('enqueue') + ' ' + track.name}
                    icon={ListPlus}
                    size="small"
                    type="text"
                    onClick={() => engine.enqueue([track])}
                  />
                </div>
              </li>
            ))}
          </ul>
          <ol aria-label={t('queue')} className={styles.list} hidden={view !== 'queue'}>
            {s.queue.map((track, index) => (
              <li aria-current={s.activeId === track.id} className={styles.trackRow} key={track.id}>
                <span aria-hidden className={styles.rowNumber}>
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span aria-hidden className={styles.trackArt}>
                  <Music2 size={21} strokeWidth={1.4} />
                </span>
                <div className={styles.rowInfo}>
                  <span className={styles.name} title={track.name}>
                    {track.name}
                  </span>
                  <span className={styles.fileMeta}>
                    {audioFormat(track)} · {audioSize(track)}
                  </span>
                </div>
                <div className={styles.rowActions}>
                  <Button
                    aria-label={t('play') + ' ' + track.name}
                    icon={Play}
                    size="small"
                    type="text"
                    onClick={() => playTrack(track)}
                  />
                  <Button
                    aria-label={t('moveUp') + ' ' + track.name}
                    disabled={index === 0}
                    icon={ArrowUp}
                    size="small"
                    type="text"
                    onClick={() => engine.move(track.id, -1)}
                  />
                  <Button
                    aria-label={t('moveDown') + ' ' + track.name}
                    disabled={index === s.queue.length - 1}
                    icon={ArrowDown}
                    size="small"
                    type="text"
                    onClick={() => engine.move(track.id, 1)}
                  />
                  <Button
                    aria-label={t('remove') + ' ' + track.name}
                    icon={Trash2}
                    size="small"
                    type="text"
                    onClick={() => engine.remove(track.id)}
                  />
                </div>
              </li>
            ))}
          </ol>
        </section>
        <section
          aria-labelledby="music-tab-plugins"
          hidden={view !== 'plugins'}
          id="music-view-plugins"
          role="tabpanel"
        >
          <MusicPluginSettings />
        </section>
      </div>
    </main>
  );
}
