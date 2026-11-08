'use client';

import { Button, Icon } from '@lobehub/ui';
import { Alert, Input } from 'antd';
import { cx } from 'antd-style';
import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  ChevronDown,
  Disc3,
  Heart,
  Library,
  ListMusic,
  ListPlus,
  Music2,
  Pause,
  Play,
  Puzzle,
  Repeat2,
  Search,
  Shuffle,
  SkipBack,
  SkipForward,
  TextQuote,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { useAudioEngine, useMusicPlayer } from '@/features/MusicPlayer/context';
import { MAX_MUSIC_QUEUE_LENGTH, type RepeatMode } from '@/features/MusicPlayer/engine';
import { formatTime, MAX_LRC_BYTES } from '@/features/MusicPlayer/lyrics';
import { musicTheme } from '@/features/MusicPlayer/musicTheme';
import MusicTrackList from '@/features/MusicPlayer/MusicTrackList';
import { useMusicPluginState } from '@/features/MusicPlayer/plugins/context';
import LyricsPanel from '@/features/MusicPlayer/plugins/LyricsPanel';
import MusicPluginSettings from '@/features/MusicPlayer/plugins/MusicPluginSettings';
import { liquidGlass } from '@/styles/liquidGlass';
import { type MusicTrack } from '@/types/music';
import { type MusicPlaylistTracks } from '@/types/music-account';

import KugouAccount, { type KugouAccountHandle } from './KugouAccount';
import KugouLibrary, { type KugouLibrarySection, librarySectionLabels } from './KugouLibrary';
import { libraryStyles } from './library.style';
import { styles } from './style';

const views = ['player', 'library', 'queue', 'plugins'] as const;
type StudioView = (typeof views)[number];
const viewIcons = { library: Library, player: AudioLines, plugins: Puzzle, queue: ListMusic };
const kugouSections = ['discover', 'liked', 'created', 'collected', 'album'] as const;
const kugouSectionIcons = {
  album: Disc3,
  collected: Library,
  created: ListMusic,
  discover: Search,
  liked: Heart,
};

export default function MusicStudio({ navigation }: { navigation?: ReactNode }) {
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
  const [source, setSource] = useState<'library' | 'kugou'>('kugou');
  const [kugouSection, setKugouSection] = useState<KugouLibrarySection>('discover');
  const [view, setView] = useState<StudioView>('player');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<'requestError' | 'uploadError' | 'lyricError' | null>(null);
  const [revision, setRevision] = useState(0);
  const [queueNotice, setQueueNotice] = useState<{
    count: number;
    key:
      | 'queueAdded'
      | 'queueAlreadyAdded'
      | 'queueFull'
      | 'queuePartiallyAdded'
      | 'queueAddedAfterPlaylist';
  } | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const lyricInput = useRef<HTMLInputElement>(null);
  const kugouAccount = useRef<KugouAccountHandle>(null);
  const lifetime = useRef<AbortController | null>(null);
  const active = s.queue.find((item) => item.id === s.activeId);
  const playing = ['playing', 'buffering', 'loading'].includes(s.status);
  const activeIndex = s.queue.findIndex((track) => track.id === s.activeId);
  const queueTotal = s.playlist?.total ?? s.queue.length;
  const queueIndex = s.playlist?.currentIndex ?? activeIndex;
  const displayedTracks = view === 'library' ? tracks : s.queue;
  const personalLibrary = view === 'library' && source === 'kugou' && kugouSection !== 'discover';
  const audioFormat = (track: MusicTrack) =>
    track.mimeType === 'audio/mpeg' ? 'MP3' : track.mimeType.split('/')[1]?.toUpperCase();
  const audioSize = (track: MusicTrack) => (track.size / (1024 * 1024)).toFixed(1) + ' MB';

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setUploading(false);
    setError(null);
    setQueueNotice(null);
    return () => controller.abort();
  }, [s.userId]);

  useEffect(() => {
    setLibrary({ tracks: [], userId: s.userId });
    setLoading(false);
    setError((current) => (current === 'requestError' ? null : current));
    if (!s.userId || (source === 'kugou' && kugouSection !== 'discover')) return;
    const controller = new AbortController();
    const isCurrent = () =>
      !controller.signal.aborted && engine.store.getState().userId === s.userId;
    const timer = setTimeout(() => {
      setLoading(true);
      void engine.client
        .search(query, 50, controller.signal, source)
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
  }, [engine, kugouSection, query, revision, s.userId, source]);

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
        setSource('library');
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
    setQueueNotice(null);
    engine.playTrack(track);
    setView('player');
  }

  function playTracks(items: MusicTrack[]) {
    setQueueNotice(null);
    engine.playTracks(items);
    setView('player');
  }

  function playPlaylist(page: MusicPlaylistTracks, activeId?: string) {
    setQueueNotice(null);
    engine.playPlaylist(page, activeId);
    setView('player');
  }

  function enqueueTracks(items: MusicTrack[]) {
    const before = engine.store.getState();
    if (before.playlist) {
      engine.enqueue(items);
      const total = engine.store.getState().playlist?.appendedCount ?? 0;
      const added = total - before.playlist.appendedCount;
      setQueueNotice({
        count: added,
        key:
          before.playlist.appendedCount >= MAX_MUSIC_QUEUE_LENGTH
            ? 'queueFull'
            : added &&
                total >= MAX_MUSIC_QUEUE_LENGTH &&
                new Set(items.map((item) => item.id)).size > added
              ? 'queuePartiallyAdded'
              : added
                ? 'queueAddedAfterPlaylist'
                : 'queueAlreadyAdded',
      });
      return;
    }
    const queue = before.queue;
    const incoming = [...new Map(items.map((track) => [track.id, track])).values()].filter(
      (track) => !queue.some((item) => item.id === track.id),
    );
    const remaining = Math.max(0, MAX_MUSIC_QUEUE_LENGTH - queue.length);
    engine.enqueue(items);
    setQueueNotice({
      count: Math.min(incoming.length, remaining),
      key: !incoming.length
        ? 'queueAlreadyAdded'
        : !remaining
          ? 'queueFull'
          : incoming.length > remaining
            ? 'queuePartiallyAdded'
            : 'queueAdded',
    });
  }

  return (
    <main
      aria-label={t('player')}
      className={cx(styles.studio, musicTheme, liquidGlass)}
      data-view={view}
    >
      <div className={styles.inner}>
        <header className={styles.header}>
          <div className={styles.brand}>
            {navigation}
            <span aria-hidden className={styles.brandIcon}>
              <Icon icon={Music2} size={18} />
            </span>
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
                  <Icon aria-hidden icon={viewIcons[item]} size={16} />
                  <span>{label}</span>
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
              <Icon aria-hidden icon={ChevronDown} size={20} />
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
        {queueNotice && (
          <Alert
            closable
            showIcon
            role="status"
            title={t(queueNotice.key, { count: queueNotice.count })}
            type="info"
            onClose={() => setQueueNotice(null)}
          />
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
              {active?.coverUrl ? (
                <img alt="" decoding="async" key={active.coverUrl} src={active.coverUrl} />
              ) : (
                <Icon icon={Music2} size={{ size: 88, strokeWidth: 1.25 }} />
              )}
            </div>
            <div className={styles.trackInfo}>
              <h2 className={styles.trackTitle} title={active?.name}>
                {active?.name ?? t('chooseTrack')}
              </h2>
              <p className={styles.trackDescription}>
                {active?.source === 'kugou'
                  ? [active.artist, active.album].filter(Boolean).join(' · ')
                  : active
                    ? audioFormat(active) + ' · ' + audioSize(active)
                    : t('fromLibrary')}
              </p>
              {active?.source === 'kugou' && (
                <p className={styles.sourceNote}>
                  {t(active.playbackKind === 'preview' ? 'kugouPreview' : 'kugouSource')}
                </p>
              )}
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
                  background: `linear-gradient(to right, var(--music-accent) ${Math.min(100, (s.positionMs / (s.durationMs || 1)) * 100)}%, var(--music-range-track) 0)`,
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
                <Icon aria-hidden icon={Shuffle} size={20} />
              </button>
              <button
                aria-label={t('previous')}
                className={styles.iconButton}
                disabled={!s.queue.length}
                onClick={() => engine.previous()}
              >
                <Icon aria-hidden icon={SkipBack} size={22} />
              </button>
              <button
                aria-label={t(playing ? 'pause' : 'play')}
                className={styles.playButton}
                data-qz-glass="control"
                disabled={!s.queue.length}
                onClick={() => (playing ? engine.pause() : engine.play())}
              >
                {playing ? (
                  <Icon aria-hidden fill="currentColor" icon={Pause} size={24} />
                ) : (
                  <Icon aria-hidden fill="currentColor" icon={Play} size={24} />
                )}
              </button>
              <button
                aria-label={t('next')}
                className={styles.iconButton}
                disabled={!s.queue.length}
                onClick={() => engine.next()}
              >
                <Icon aria-hidden icon={SkipForward} size={22} />
              </button>
              <label className={styles.repeatControl} data-active={s.repeat !== 'sequence'}>
                <Icon aria-hidden icon={Repeat2} size={20} />
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
                <Icon aria-hidden icon={ListMusic} size={16} />
                {queueIndex >= 0 ? queueIndex + 1 : '—'} / {queueTotal}
              </button>
              <span className={styles.status}>{t(s.status)}</span>
              <label className={styles.volume}>
                {s.volume === 0 ? (
                  <Icon aria-hidden icon={VolumeX} size={16} />
                ) : (
                  <Icon aria-hidden icon={Volume2} size={16} />
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
              {active?.source !== 'kugou' && (
                <Button
                  disabled={!active || lyricsStatus !== 'active'}
                  icon={TextQuote}
                  size="small"
                  type="text"
                  onClick={() => lyricInput.current?.click()}
                >
                  {t('importLrc')}
                </Button>
              )}
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
            {!personalLibrary && (
              <span>{view === 'queue' ? queueTotal : displayedTracks.length}</span>
            )}
          </div>
          {view === 'library' && (
            <div className={styles.sourceRow}>
              <div aria-label={t('musicSource')} className={styles.sourceSelector} role="group">
                {(['kugou', 'library'] as const).map((item) => (
                  <button
                    aria-pressed={source === item}
                    key={item}
                    onClick={() => {
                      setSource(item);
                      setQuery('');
                    }}
                  >
                    {t(item === 'kugou' ? 'kugou' : 'localLibrary')}
                  </button>
                ))}
              </div>
              {source === 'kugou' && (
                <KugouAccount
                  ref={kugouAccount}
                  userId={s.userId}
                  onBeforeDisconnect={() => engine.invalidatePlayback()}
                  onChanged={() => {
                    void engine.refreshPlayback();
                    setRevision((value) => value + 1);
                  }}
                />
              )}
            </div>
          )}
          {view === 'library' && source === 'kugou' && (
            <nav aria-label={t('kugouPersonalLibrary')} className={libraryStyles.navigation}>
              {kugouSections.map((section) => (
                <button
                  aria-pressed={kugouSection === section}
                  key={section}
                  onClick={() => setKugouSection(section)}
                >
                  <Icon aria-hidden icon={kugouSectionIcons[section]} size={16} />
                  {t(librarySectionLabels[section])}
                </button>
              ))}
            </nav>
          )}
          {personalLibrary && (
            <KugouLibrary
              activeId={s.activeId}
              key={`${s.userId}:${revision}:${kugouSection}`}
              revision={revision}
              section={kugouSection}
              userId={s.userId}
              onEnqueue={enqueueTracks}
              onPlayPlaylist={playPlaylist}
              onSignIn={() => kugouAccount.current?.show()}
            />
          )}
          <div hidden={personalLibrary}>
            {view === 'queue' && s.playlist && (
              <div className={styles.playlistQueueInfo}>
                <strong>{s.playlist.name}</strong>
                <p>{t('queuePlaylistHint')}</p>
                <span>
                  {t('queueLoadedCount', { loaded: s.queue.length, total: s.playlist.total })}
                </span>
                {s.playlist.appendedCount > 0 && (
                  <span>{t('queueAfterPlaylist', { count: s.playlist.appendedCount })}</span>
                )}
                {s.playlist.loading && <p role="status">{t('queueLoadingNext')}</p>}
                {s.playlist.error && <p role="alert">{t('queueLoadFailed')}</p>}
                {(s.playlist.error || s.playlist.hasMore) && (
                  <Button
                    loading={s.playlist.loading}
                    size="small"
                    onClick={() =>
                      s.playlist?.error ? engine.retryPlaylist() : void engine.loadMorePlaylist()
                    }
                  >
                    {t(s.playlist.error ? 'retry' : 'queueLoadMore')}
                  </Button>
                )}
              </div>
            )}
            <div className={styles.collectionToolbar}>
              <Button
                disabled={!displayedTracks.length}
                icon={view === 'queue' && s.playlist && playing ? Pause : Play}
                onClick={() =>
                  view === 'queue' && s.playlist
                    ? playing
                      ? engine.pause()
                      : engine.play()
                    : playTracks(displayedTracks)
                }
              >
                {t(view === 'queue' && s.playlist ? (playing ? 'pause' : 'play') : 'playAll')}
              </Button>
              {view !== 'queue' && (
                <Input
                  allowClear
                  aria-label={t(source === 'kugou' ? 'searchKugou' : 'search')}
                  className={styles.search}
                  maxLength={200}
                  placeholder={t(source === 'kugou' ? 'searchKugou' : 'search')}
                  prefix={<Icon aria-hidden icon={Search} size={16} />}
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
                <Icon aria-hidden icon={Music2} size={{ size: 40, strokeWidth: 1.5 }} />
                <h3>
                  {view === 'queue'
                    ? t('emptyQueue')
                    : query
                      ? t('noSearchResults')
                      : t(source === 'kugou' ? 'kugouSearchHint' : 'emptyLibrary')}
                </h3>
                <p>
                  {query
                    ? t('noSearchResultsHint')
                    : t(
                        source === 'kugou' && view === 'library'
                          ? 'kugouAvailability'
                          : 'chooseTrackHint',
                      )}
                </p>
                {view !== 'queue' && source === 'library' && !query && (
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
                <li
                  aria-current={s.activeId === track.id}
                  className={styles.trackRow}
                  key={track.id}
                >
                  <span aria-hidden className={styles.rowNumber}>
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span aria-hidden className={styles.trackArt}>
                    {track.coverUrl ? (
                      <img alt="" decoding="async" loading="lazy" src={track.coverUrl} />
                    ) : (
                      <Icon icon={Music2} size={20} />
                    )}
                  </span>
                  <div className={styles.rowInfo}>
                    <span className={styles.name} title={track.name}>
                      {track.name}
                    </span>
                    <span className={styles.fileMeta}>{track.artist || audioFormat(track)}</span>
                  </div>
                  <span className={styles.fileSize}>
                    {track.source === 'kugou'
                      ? `${formatTime(track.durationMs ?? 0)}${track.playbackKind === 'preview' ? ' · ' + t('preview') : ''}`
                      : audioSize(track)}
                  </span>
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
                      onClick={() => enqueueTracks([track])}
                    />
                  </div>
                </li>
              ))}
            </ul>
            {view === 'queue' && (
              <MusicTrackList
                className={styles.list}
                initialIndex={activeIndex}
                items={s.queue}
                key={s.playlist?.startIndex ?? 'manual'}
                label={t('queue')}
                offset={s.playlist?.startIndex ?? 0}
                total={queueTotal}
                renderItem={(track, index) => (
                  <li
                    aria-current={s.activeId === track.id}
                    className={styles.trackRow}
                    key={track.id}
                  >
                    <span aria-hidden className={styles.rowNumber}>
                      {String((s.playlist?.startIndex ?? 0) + index + 1).padStart(2, '0')}
                    </span>
                    <span aria-hidden className={styles.trackArt}>
                      {track.coverUrl ? (
                        <img alt="" decoding="async" loading="lazy" src={track.coverUrl} />
                      ) : (
                        <Icon icon={Music2} size={20} />
                      )}
                    </span>
                    <div className={styles.rowInfo}>
                      <span className={styles.name} title={track.name}>
                        {track.name}
                      </span>
                      <span className={styles.fileMeta}>
                        {track.source === 'kugou'
                          ? track.artist
                          : audioFormat(track) + ' · ' + audioSize(track)}
                      </span>
                    </div>
                    <div className={styles.rowActions}>
                      <Button
                        aria-label={t('play') + ' ' + track.name}
                        icon={Play}
                        size="small"
                        type="text"
                        onClick={() => {
                          engine.playQueuedTrack(track.id);
                          setView('player');
                        }}
                      />
                      {!s.playlist && (
                        <>
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
                        </>
                      )}
                    </div>
                  </li>
                )}
              />
            )}
          </div>
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
