'use client';

import { Button, Icon } from '@lobehub/ui';
import { ArrowLeft, Heart, ListMusic, ListPlus, Music2, Play, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatTime } from '@/features/MusicPlayer/lyrics';
import MusicTrackList from '@/features/MusicPlayer/MusicTrackList';
import { musicAccountClient } from '@/services/music-account';
import { type MusicTrack } from '@/types/music';
import { type MusicPlaylistTracks } from '@/types/music-account';

import { libraryStyles } from './library.style';
import { styles } from './style';

export type KugouLibrarySection = 'discover' | 'liked' | 'created' | 'collected' | 'album';
type LibraryPage = Awaited<ReturnType<typeof musicAccountClient.library>>;
type Playlist = LibraryPage['playlists'][number];
type TrackPage = Awaited<ReturnType<typeof musicAccountClient.playlist>>;
type Failure = 'account' | 'request' | null;
const failure = (error: unknown): Failure =>
  error instanceof Error && /MUSIC_ACCOUNT_(?:REQUIRED|EXPIRED)/u.test(error.message)
    ? 'account'
    : 'request';

export const librarySectionLabels = {
  album: 'kugouCollectedAlbums',
  collected: 'kugouCollectedPlaylists',
  created: 'kugouCreatedPlaylists',
  discover: 'kugouDiscover',
  liked: 'kugouLiked',
} as const;

interface LibraryProps {
  activeId: string | null;
  onEnqueue: (tracks: MusicTrack[]) => void;
  onPlayPlaylist: (page: MusicPlaylistTracks, activeId?: string) => void;
  onSignIn: () => void;
  revision: number;
  section: Exclude<KugouLibrarySection, 'discover'>;
  userId: string | null;
}

function Feedback({
  empty,
  error,
  loading,
  onRetry,
  onSignIn,
  userId,
}: {
  empty: boolean;
  error: Failure;
  loading: boolean;
  onRetry: () => void;
  onSignIn: () => void;
  userId: string | null;
}) {
  const { t } = useTranslation('music');
  if (loading)
    return (
      <p className={styles.loading} role="status">
        {t('kugouLibraryLoading')}
      </p>
    );
  if (!error && !empty) return null;
  return (
    <div className={styles.emptyCollection}>
      <Icon aria-hidden icon={error === 'account' ? Heart : ListMusic} size={40} />
      <h3 role={error ? 'status' : undefined}>
        {t(
          error === 'account'
            ? 'kugouLibrarySignIn'
            : error
              ? 'kugouLibraryError'
              : 'kugouLibraryEmpty',
        )}
      </h3>
      <p>{t(error === 'account' ? 'kugouLibrarySignInHint' : 'kugouLibrarySyncHint')}</p>
      {error === 'account' ? (
        <Button disabled={!userId} onClick={onSignIn}>
          {t('kugouLogin')}
        </Button>
      ) : (
        <Button icon={RefreshCw} onClick={onRetry}>
          {t(error ? 'retry' : 'kugouLibraryRefresh')}
        </Button>
      )}
    </div>
  );
}

function PlaylistTracks({
  activeId,
  onBack,
  onEnqueue,
  onPlayPlaylist,
  onSignIn,
  playlist,
  userId,
}: Omit<LibraryProps, 'section' | 'revision'> & {
  onBack?: () => void;
  playlist: Playlist;
}) {
  const { t } = useTranslation('music');
  const [data, setData] = useState<TrackPage>();
  const [pages, setPages] = useState<Map<number, TrackPage>>(() => new Map());
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Failure>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void musicAccountClient
      .playlist(playlist.id, page, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setPages((previous) => {
          const next =
            previous.get(1)?.revision === result.revision
              ? new Map(previous)
              : new Map<number, TrackPage>();
          next.set(result.page, result);
          return next;
        });
        setData((previous) => ({
          ...result,
          tracks:
            page > 1 && previous?.revision === result.revision
              ? [
                  ...new Map(
                    [...previous.tracks, ...result.tracks].map((track) => [track.id, track]),
                  ).values(),
                ]
              : result.tracks,
        }));
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(failure(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, playlist.id, retry]);
  const tracks = error === 'account' ? [] : (data?.tracks ?? []);
  return (
    <>
      <div className={libraryStyles.heading}>
        <div className={libraryStyles.title}>
          {onBack && (
            <Button
              aria-label={t('kugouLibraryBack')}
              icon={ArrowLeft}
              type="text"
              onClick={onBack}
            />
          )}
          <h3>{playlist.name}</h3>
          <span>{t('kugouTrackCount', { count: data?.total ?? playlist.trackCount })}</span>
        </div>
        <div className={libraryStyles.actions}>
          <Button
            disabled={!!error || !pages.get(1)?.tracks.length}
            icon={Play}
            onClick={() => {
              const first = pages.get(1);
              if (first) onPlayPlaylist(first);
            }}
          >
            {t('playAll')}
          </Button>
          <Button
            aria-label={t('kugouLibraryRefresh')}
            icon={RefreshCw}
            loading={loading}
            type="text"
            onClick={() => {
              setData(undefined);
              setPages(new Map());
              setPage(1);
              setRetry((value) => value + 1);
            }}
          />
        </div>
      </div>
      <Feedback
        empty={!tracks.length}
        error={error}
        loading={loading}
        userId={userId}
        onRetry={() => setRetry((value) => value + 1)}
        onSignIn={onSignIn}
      />
      <MusicTrackList
        className={styles.list}
        items={tracks}
        label={playlist.name}
        total={data?.total ?? playlist.trackCount}
        renderItem={(track, index) => (
          <li aria-current={activeId === track.id} className={styles.trackRow} key={track.id}>
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
              <span className={styles.fileMeta}>
                {[track.artist, track.album].filter(Boolean).join(' · ')}
              </span>
            </div>
            <span className={styles.fileSize}>{formatTime(track.durationMs ?? 0)}</span>
            <div className={styles.rowActions}>
              <Button
                aria-label={t('play') + ' ' + track.name}
                icon={Play}
                size="small"
                type="text"
                onClick={() => {
                  const sourcePage = [...pages.values()].find((item) =>
                    item.tracks.some((song) => song.id === track.id),
                  );
                  if (sourcePage) onPlayPlaylist(sourcePage, track.id);
                }}
              />
              <Button
                aria-label={t('enqueue') + ' ' + track.name}
                icon={ListPlus}
                size="small"
                type="text"
                onClick={() => onEnqueue([track])}
              />
            </div>
          </li>
        )}
      />
      {data?.hasMore && !error && (
        <div className={libraryStyles.more}>
          <Button loading={loading} onClick={() => setPage((value) => value + 1)}>
            {t('kugouLoadMore')}
          </Button>
        </div>
      )}
    </>
  );
}

/** Mounted per Qingzhou account, account revision and section by MusicStudio. */
function LibraryContent(props: LibraryProps) {
  const { t } = useTranslation('music');
  const [data, setData] = useState<LibraryPage>();
  const [selected, setSelected] = useState<Playlist>();
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Failure>(null);
  useEffect(() => {
    if (!props.userId) {
      setLoading(false);
      setError('account');
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void musicAccountClient
      .library(page, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setData((previous) => ({
          ...result,
          playlists:
            page > 1 && previous?.revision === result.revision
              ? [
                  ...new Map(
                    [...previous.playlists, ...result.playlists].map((item) => [item.id, item]),
                  ).values(),
                ]
              : result.playlists,
        }));
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(failure(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, props.userId, props.revision, retry]);
  const playlists =
    error === 'account'
      ? []
      : (data?.playlists.filter((item) => item.kind === props.section) ?? []);
  const opened = props.section === 'liked' ? playlists[0] : selected;
  useEffect(() => {
    if (props.section === 'liked' && !opened && data?.hasMore && !loading && !error)
      setPage((value) => value + 1);
  }, [data?.hasMore, error, loading, opened, props.section]);
  if (opened)
    return (
      <PlaylistTracks
        activeId={props.activeId}
        key={opened.id}
        playlist={opened}
        userId={props.userId}
        onBack={props.section === 'liked' ? undefined : () => setSelected(undefined)}
        onEnqueue={props.onEnqueue}
        onPlayPlaylist={props.onPlayPlaylist}
        onSignIn={props.onSignIn}
      />
    );
  return (
    <>
      <div className={libraryStyles.heading}>
        <h3>{t(librarySectionLabels[props.section])}</h3>
        <Button
          aria-label={t('kugouLibraryRefresh')}
          icon={RefreshCw}
          loading={loading}
          type="text"
          onClick={() => {
            setData(undefined);
            setPage(1);
            setRetry((value) => value + 1);
          }}
        />
      </div>
      <Feedback
        empty={!playlists.length}
        error={error}
        loading={loading}
        userId={props.userId}
        onRetry={() => setRetry((value) => value + 1)}
        onSignIn={props.onSignIn}
      />
      <ul aria-label={t(librarySectionLabels[props.section])} className={libraryStyles.grid}>
        {playlists.map((playlist) => (
          <li key={playlist.id}>
            <button
              aria-label={playlist.name}
              className={libraryStyles.card}
              onClick={() => setSelected(playlist)}
            >
              <span aria-hidden className={libraryStyles.cover}>
                {playlist.coverUrl ? (
                  <img alt="" decoding="async" loading="lazy" src={playlist.coverUrl} />
                ) : (
                  <Icon icon={ListMusic} size={40} />
                )}
              </span>
              <strong>{playlist.name}</strong>
              <small>{t('kugouTrackCount', { count: playlist.trackCount })}</small>
            </button>
          </li>
        ))}
      </ul>
      {data?.hasMore && !error && (
        <div className={libraryStyles.more}>
          <Button loading={loading} onClick={() => setPage((value) => value + 1)}>
            {t('kugouLoadMore')}
          </Button>
        </div>
      )}
    </>
  );
}

export default function KugouLibrary(props: LibraryProps) {
  return <LibraryContent key={`${props.userId}:${props.revision}:${props.section}`} {...props} />;
}
