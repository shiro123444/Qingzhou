'use client';

import { Button } from '@lobehub/ui';
import { Alert, Input } from 'antd';
import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  Disc3,
  ListMusic,
  ListPlus,
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

import { useAudioEngine, useMusicPlayer } from '@/features/MusicPlayer/context';
import { type RepeatMode } from '@/features/MusicPlayer/engine';
import { activeLyric, formatTime, MAX_LRC_BYTES } from '@/features/MusicPlayer/lyrics';
import { type MusicTrack } from '@/types/music';

import { styles } from './style';

/** An abstract Qingzhou cover, used until the library has real embedded artwork. */
function CoverIllustration() {
  return (
    <svg aria-hidden fill="none" viewBox="0 0 320 320">
      <circle cx="238" cy="80" fill="white" opacity="0.28" r="37" />
      <path
        d="M-20 180C45 148 88 220 166 181S279 154 341 184V340H-20Z"
        fill="white"
        opacity="0.12"
      />
      <path
        d="M-20 218C58 177 116 257 202 212S296 196 340 218V340H-20Z"
        fill="#103D51"
        opacity="0.24"
      />
      <path
        d="M-20 259C45 232 113 283 185 258S284 244 340 263V340H-20Z"
        fill="white"
        opacity="0.1"
      />
      <path d="M133 207H207L192 223H149Z" fill="#164B59" />
      <path d="M171 121V201H137Z" fill="#F6FAEB" opacity="0.95" />
      <path d="M178 142L204 201H178Z" fill="#D9EBDC" opacity="0.82" />
      <path
        d="M117 236C143 230 153 242 178 236C203 230 217 241 237 235"
        opacity="0.45"
        stroke="white"
        strokeLinecap="round"
        strokeWidth="1.5"
      />
      <path
        d="M101 251C126 246 135 254 151 251M187 254C207 248 225 256 249 250"
        opacity="0.22"
        stroke="white"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function MusicStudio() {
  const { t } = useTranslation('music');
  const engine = useAudioEngine();
  const s = useMusicPlayer((state) => state);
  const [library, setLibrary] = useState<{ tracks: MusicTrack[]; userId: string | null }>({
    tracks: [],
    userId: null,
  });
  const tracks = library.userId === s.userId ? library.tracks : [];
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'library' | 'queue'>('library');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<'requestError' | 'uploadError' | 'lyricError' | null>(null);
  const [revision, setRevision] = useState(0);
  const upload = useRef<HTMLInputElement>(null);
  const lyricInput = useRef<HTMLInputElement>(null);
  const highlight = useRef<HTMLParagraphElement>(null);
  const lifetime = useRef<AbortController | null>(null);
  const active = s.queue.find((item) => item.id === s.activeId);
  const lines = s.activeId ? (s.lyrics[s.activeId]?.lines ?? []) : [];
  const currentLine = activeLyric(lines, s.positionMs);
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

  useEffect(() => {
    highlight.current?.scrollIntoView?.({ block: 'nearest' });
  }, [currentLine, s.activeId]);

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

  return (
    <main className={styles.studio}>
      <div className={styles.inner}>
        <header className={styles.header}>
          <div className={styles.brand}>
            <span aria-hidden className={styles.brandIcon}>
              <AudioLines size={20} />
            </span>
            <div>
              <p className={styles.eyebrow}>{t('listeningSpace')}</p>
              <h1>{t('title')}</h1>
            </div>
          </div>
          <Button
            className={styles.uploadButton}
            disabled={!s.userId}
            icon={Upload}
            loading={uploading}
            onClick={() => upload.current?.click()}
          >
            {t('upload')}
          </Button>
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
        {!s.userId && <Alert showIcon title={t('login')} type="info" />}
        {error && (
          <Alert closable showIcon title={t(error)} type="error" onClose={() => setError(null)} />
        )}

        <div className={styles.deck}>
          <section aria-label={t('nowPlaying')} className={styles.player}>
            <div className={styles.playerTopline}>
              <span className={styles.sectionLabel}>{t('nowPlaying')}</span>
              <span className={styles.status} data-playing={s.status === 'playing'}>
                <span aria-hidden className={styles.statusDot} />
                {t(s.status)}
              </span>
            </div>
            <div className={styles.playerBody}>
              <div aria-hidden className={styles.artwork}>
                <div className={styles.artworkGlow} />
                <div className={styles.coverArt} data-playing={s.status === 'playing'}>
                  <CoverIllustration />
                  <span className={styles.coverSignature}>
                    <AudioLines size={15} />
                    {t('title')}
                  </span>
                </div>
              </div>
              <div className={styles.trackInfo}>
                <p className={styles.trackOrigin}>{active ? t('fromLibrary') : t('title')}</p>
                <h2 className={styles.trackTitle} title={active?.name}>
                  {active?.name ?? t('chooseTrack')}
                </h2>
                <p className={styles.trackDescription}>
                  {active ? audioFormat(active) + ' · ' + audioSize(active) : t('chooseTrackHint')}
                </p>
                <div className={styles.timeline}>
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
                  <div className={styles.timestamps}>
                    <span>{formatTime(s.positionMs)}</span>
                    <span>{formatTime(s.durationMs)}</span>
                  </div>
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
                    <Shuffle size={18} />
                  </button>
                  <button
                    aria-label={t('previous')}
                    className={styles.iconButton}
                    disabled={!s.queue.length}
                    onClick={() => engine.previous()}
                  >
                    <SkipBack fill="currentColor" size={21} />
                  </button>
                  <button
                    aria-label={t(playing ? 'pause' : 'play')}
                    className={styles.playButton}
                    disabled={!s.queue.length}
                    onClick={() => (playing ? engine.pause() : engine.play())}
                  >
                    {playing ? (
                      <Pause fill="currentColor" size={23} />
                    ) : (
                      <Play fill="currentColor" size={23} />
                    )}
                  </button>
                  <button
                    aria-label={t('next')}
                    className={styles.iconButton}
                    disabled={!s.queue.length}
                    onClick={() => engine.next()}
                  >
                    <SkipForward fill="currentColor" size={21} />
                  </button>
                  <label className={styles.repeatControl} data-active={s.repeat !== 'sequence'}>
                    <Repeat2 aria-hidden size={18} />
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
                  <span className={styles.queuePosition}>
                    <ListMusic size={14} />
                    {activeIndex >= 0 ? String(activeIndex + 1).padStart(2, '0') : '—'}
                    <span>/</span>
                    {String(s.queue.length).padStart(2, '0')}
                  </span>
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
                {s.error && (
                  <Button size="small" onClick={() => engine.play()}>
                    {t('retry')}
                  </Button>
                )}
              </div>
            </div>
            <div className={styles.continuousHint}>
              <span aria-hidden />
              {t('continuousListening')}
            </div>
          </section>

          <section className={styles.lyricPanel}>
            <div className={styles.sectionHeading}>
              <h2>{t('lyrics')}</h2>
              <Button
                disabled={!active}
                size="small"
                type="text"
                onClick={() => lyricInput.current?.click()}
              >
                {t('importLrc')}
              </Button>
            </div>
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
            <div aria-label={t('lyrics')} className={styles.lyrics} data-empty={lines.length === 0}>
              {lines.length === 0 ? (
                <div className={styles.emptyLyrics}>
                  <AudioLines aria-hidden size={35} strokeWidth={1} />
                  <p>{t('emptyLyrics')}</p>
                  <span>{t('lyricHint')}</span>
                </div>
              ) : (
                lines.map((line, index) => (
                  <p
                    aria-current={index === currentLine}
                    key={String(index) + ':' + line.timeMs}
                    ref={index === currentLine ? highlight : undefined}
                  >
                    <button onClick={() => engine.seek(line.timeMs)}>{line.text || '♪'}</button>
                  </p>
                ))
              )}
            </div>
          </section>
        </div>

        <section aria-label={t('collection')} className={styles.collection}>
          <div className={styles.collectionHeader}>
            <div className={styles.tabs}>
              <button
                aria-pressed={view === 'library'}
                className={styles.tab}
                data-active={view === 'library'}
                onClick={() => setView('library')}
              >
                {t('library')}
                <span>{tracks.length}</span>
              </button>
              <button
                aria-pressed={view === 'queue'}
                className={styles.tab}
                data-active={view === 'queue'}
                onClick={() => setView('queue')}
              >
                {t('queue')}
                <span>{s.queue.length}</span>
              </button>
            </div>
            <div className={styles.collectionActions}>
              {view === 'library' && (
                <Input
                  allowClear
                  aria-label={t('search')}
                  className={styles.search}
                  maxLength={200}
                  placeholder={t('search')}
                  prefix={<Search aria-hidden size={15} />}
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onPressEnter={() => setRevision((value) => value + 1)}
                />
              )}
              <Button
                disabled={!displayedTracks.length}
                icon={Play}
                size="small"
                onClick={() => {
                  engine.enqueue(displayedTracks);
                  if (displayedTracks[0]) engine.playTrack(displayedTracks[0]);
                }}
              >
                {t('playAll')}
              </Button>
            </div>
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
              <Disc3 aria-hidden size={34} strokeWidth={1.2} />
              <h3>
                {view === 'queue'
                  ? t('emptyQueue')
                  : query
                    ? t('noSearchResults')
                    : t('emptyLibrary')}
              </h3>
              <p>
                {view === 'queue'
                  ? t('chooseTrackHint')
                  : query
                    ? t('noSearchResultsHint')
                    : t('chooseTrackHint')}
              </p>
              {view === 'library' && !query && (
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
          {view === 'library' ? (
            <ul aria-label={t('library')} className={styles.libraryGrid}>
              {tracks.map((track, index) => (
                <li
                  aria-current={s.activeId === track.id}
                  className={styles.libraryCard}
                  key={track.id}
                >
                  <span aria-hidden className={styles.trackArt} data-tone={index % 4}>
                    <CoverIllustration />
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
                      onClick={() => engine.playTrack(track)}
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
          ) : (
            <ol aria-label={t('queue')} className={styles.list}>
              {s.queue.map((track, index) => (
                <li
                  aria-current={s.activeId === track.id}
                  className={styles.trackRow}
                  key={track.id}
                >
                  <span aria-hidden className={styles.rowNumber}>
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span aria-hidden className={styles.trackArt} data-tone={index % 4}>
                    <CoverIllustration />
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
                      onClick={() => engine.playTrack(track)}
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
          )}
        </section>
      </div>
    </main>
  );
}
