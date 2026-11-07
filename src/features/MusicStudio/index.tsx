'use client';

import { Button } from '@lobehub/ui';
import { Alert, Input } from 'antd';
import { ArrowDown, ArrowUp, ListPlus, Play, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAudioEngine, useMusicPlayer } from '@/features/MusicPlayer/context';
import { activeLyric, MAX_LRC_BYTES } from '@/features/MusicPlayer/lyrics';
import { styles } from '@/features/MusicPlayer/style';
import { type MusicTrack } from '@/types/music';

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
      <header className={styles.header}>
        <div>
          <h1>{t('title')}</h1>
          <p className={styles.muted}>{t('subtitle')}</p>
        </div>
        <Button
          disabled={!s.userId}
          loading={uploading}
          type="primary"
          onClick={() => upload.current?.click()}
        >
          {t('upload')}
        </Button>
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
      </header>
      {!s.userId && <Alert showIcon title={t('login')} type="info" />}
      {error && (
        <Alert closable showIcon title={t(error)} type="error" onClose={() => setError(null)} />
      )}
      <div className={styles.grid}>
        <section className={styles.card}>
          <h2>{t('library')}</h2>
          <Input.Search
            allowClear
            aria-label={t('search')}
            maxLength={200}
            placeholder={t('search')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onSearch={() => setRevision((value) => value + 1)}
          />
          {loading && <p role="status">{t('loading')}</p>}
          {error === 'requestError' && (
            <Button onClick={() => setRevision((value) => value + 1)}>{t('retry')}</Button>
          )}
          {!loading && tracks.length === 0 && <p className={styles.muted}>{t('emptyLibrary')}</p>}
          <ul aria-label={t('library')} className={styles.list}>
            {tracks.map((track) => (
              <li aria-current={s.activeId === track.id} className={styles.row} key={track.id}>
                <span className={styles.name} title={track.name}>
                  {track.name}
                </span>
                <Button
                  aria-label={`${t('play')} ${track.name}`}
                  icon={Play}
                  size="small"
                  onClick={() => engine.playTrack(track)}
                />
                <Button
                  aria-label={`${t('enqueue')} ${track.name}`}
                  icon={ListPlus}
                  size="small"
                  onClick={() => engine.enqueue([track])}
                />
              </li>
            ))}
          </ul>
        </section>
        <div className={styles.stack}>
          <section className={styles.card}>
            <div className={styles.header}>
              <h2>{active?.name ?? t('nowPlaying')}</h2>
              <Button disabled={!active} size="small" onClick={() => lyricInput.current?.click()}>
                {t('importLrc')}
              </Button>
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
            </div>
            <p className={styles.muted}>{t('lyricHint')}</p>
            <div aria-label={t('lyrics')} className={styles.lyrics}>
              {lines.length === 0 && <p>{t('emptyLyrics')}</p>}
              {lines.map((line, index) => (
                <p
                  aria-current={index === currentLine}
                  key={`${index}:${line.timeMs}`}
                  ref={index === currentLine ? highlight : undefined}
                >
                  <button onClick={() => engine.seek(line.timeMs)}>{line.text || '♪'}</button>
                </p>
              ))}
            </div>
          </section>
          <section className={styles.card}>
            <h2>
              {t('queue')} · {s.queue.length}/100
            </h2>
            {!s.queue.length && <p className={styles.muted}>{t('emptyQueue')}</p>}
            <ol aria-label={t('queue')} className={styles.list}>
              {s.queue.map((track, index) => (
                <li aria-current={s.activeId === track.id} className={styles.row} key={track.id}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <span className={styles.name} title={track.name}>
                    {track.name}
                  </span>
                  <Button
                    aria-label={`${t('play')} ${track.name}`}
                    icon={Play}
                    size="small"
                    onClick={() => engine.playTrack(track)}
                  />
                  <Button
                    aria-label={`${t('moveUp')} ${track.name}`}
                    disabled={index === 0}
                    icon={ArrowUp}
                    size="small"
                    onClick={() => engine.move(track.id, -1)}
                  />
                  <Button
                    aria-label={`${t('moveDown')} ${track.name}`}
                    disabled={index === s.queue.length - 1}
                    icon={ArrowDown}
                    size="small"
                    onClick={() => engine.move(track.id, 1)}
                  />
                  <Button
                    aria-label={`${t('remove')} ${track.name}`}
                    icon={Trash2}
                    size="small"
                    onClick={() => engine.remove(track.id)}
                  />
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </main>
  );
}
