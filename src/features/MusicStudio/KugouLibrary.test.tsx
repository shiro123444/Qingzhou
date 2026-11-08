import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import music from '@/locales/default/music';
import { musicAccountClient } from '@/services/music-account';
import { type MusicTrack } from '@/types/music';
import { type MusicLibrary, type MusicLibraryPlaylist } from '@/types/music-account';

import KugouLibrary from './KugouLibrary';

const revision = '55d73ef1-8f31-4e90-abf7-2d3e663d988e';
const collected: MusicLibraryPlaylist = {
  coverUrl: `/api/runtime/music/account/playlists/12/cover?revision=${revision}`,
  id: '12',
  kind: 'collected',
  name: 'Saved collection',
  trackCount: 2,
};
const liked: MusicLibraryPlaylist = { ...collected, id: '13', kind: 'liked', name: 'My likes' };
const track: MusicTrack = {
  artist: 'Artist',
  coverUrl: '/api/runtime/music/tracks/kugou%3Atest/cover',
  durationMs: 180000,
  id: 'kugou:' + 'a'.repeat(32) + ':1:2',
  mimeType: 'audio/mpeg',
  name: 'Saved song',
  size: 120000,
  source: 'kugou',
  version: '1',
};
const library = (playlists: MusicLibraryPlaylist[]): MusicLibrary => ({
  hasMore: false,
  page: 1,
  playlists,
  revision,
});
const callbacks = () => ({
  onEnqueue: vi.fn(),
  onPlayPlaylist: vi.fn(),
  onSignIn: vi.fn(),
});
function page(props: Partial<React.ComponentProps<typeof KugouLibrary>> = {}) {
  return (
    <I18nextProvider i18n={i18n}>
      <KugouLibrary
        activeId={null}
        revision={0}
        section="collected"
        userId="alice"
        {...callbacks()}
        {...props}
      />
    </I18nextProvider>
  );
}
beforeEach(() => {
  i18n.addResourceBundle('zh-CN', 'music', music);
  vi.spyOn(musicAccountClient, 'library').mockResolvedValue(library([collected, liked]));
  vi.spyOn(musicAccountClient, 'playlist').mockResolvedValue({
    hasMore: false,
    page: 1,
    playlist: collected,
    revision,
    total: 1,
    tracks: [track],
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('opens only the chosen account collection, preserves artwork, and plays or queues real returned tracks', async () => {
  const actions = callbacks();
  const view = render(page(actions));
  const card = await screen.findByRole('button', { name: collected.name });
  expect(screen.queryByRole('button', { name: liked.name })).not.toBeInTheDocument();
  expect(view.container.querySelector(`img[src="${collected.coverUrl}"]`)).toBeVisible();
  fireEvent.click(card);
  await screen.findByRole('button', { name: music.play + ' ' + track.name });
  expect(musicAccountClient.playlist).toHaveBeenCalledWith(
    collected.id,
    1,
    expect.any(AbortSignal),
  );
  fireEvent.click(screen.getByRole('button', { name: music.enqueue + ' ' + track.name }));
  expect(actions.onEnqueue).toHaveBeenCalledWith([track]);
  expect(actions.onPlayPlaylist).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: music.play + ' ' + track.name }));
  expect(actions.onPlayPlaylist).toHaveBeenCalledWith(
    expect.objectContaining({ playlist: collected, tracks: [track], page: 1 }),
    track.id,
  );
  fireEvent.click(screen.getByRole('button', { name: music.playAll }));
  expect(actions.onPlayPlaylist).toHaveBeenLastCalledWith(
    expect.objectContaining({ playlist: collected, tracks: [track], page: 1 }),
  );
  expect(view.container.querySelector(`img[src="${track.coverUrl}"]`)).toBeVisible();
});

it('opens the actual liked playlist and appends pages without duplicating songs', async () => {
  const actions = callbacks();
  const next = { ...track, id: 'second', name: 'Second song' };
  vi.mocked(musicAccountClient.playlist)
    .mockResolvedValueOnce({
      hasMore: true,
      page: 1,
      playlist: liked,
      revision,
      total: 669,
      tracks: [track],
    })
    .mockResolvedValueOnce({
      hasMore: false,
      page: 2,
      playlist: liked,
      revision,
      total: 669,
      tracks: [track, next],
    });
  render(page({ ...actions, section: 'liked' }));
  await screen.findByRole('button', { name: music.play + ' ' + track.name });
  expect(musicAccountClient.playlist).toHaveBeenCalledWith(liked.id, 1, expect.any(AbortSignal));
  expect(screen.getByRole('button', { name: music.playAll })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: music.kugouLoadMore }));
  await screen.findByRole('button', { name: music.play + ' ' + next.name });
  expect(musicAccountClient.playlist).toHaveBeenLastCalledWith(
    liked.id,
    2,
    expect.any(AbortSignal),
  );
  expect(screen.getAllByText(track.name)).toHaveLength(1);
  expect(screen.queryByRole('button', { name: music.kugouLoadMore })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: music.playAll }));
  expect(actions.onPlayPlaylist).toHaveBeenLastCalledWith(
    expect.objectContaining({
      page: 1,
      total: 669,
      tracks: [track],
      hasMore: true,
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: music.play + ' ' + next.name }));
  expect(actions.onPlayPlaylist).toHaveBeenLastCalledWith(
    expect.objectContaining({
      page: 2,
      total: 669,
      tracks: [track, next],
    }),
    next.id,
  );
});

it('offers QR sign-in for a disconnected library and reloads after the account revision changes', async () => {
  const actions = callbacks();
  vi.mocked(musicAccountClient.library).mockRejectedValueOnce(new Error('MUSIC_ACCOUNT_REQUIRED'));
  const view = render(page(actions));
  fireEvent.click(await screen.findByRole('button', { name: music.kugouLogin }));
  expect(actions.onSignIn).toHaveBeenCalledOnce();
  expect(musicAccountClient.playlist).not.toHaveBeenCalled();
  view.rerender(page({ ...actions, revision: 1 }));
  expect(await screen.findByRole('button', { name: collected.name })).toBeVisible();
  expect(screen.queryByText(music.kugouLibrarySignIn)).not.toBeInTheDocument();
});

it('discards a previous Qingzhou account response even when its transport ignores cancellation', async () => {
  let finish!: (result: MusicLibrary) => void;
  vi.mocked(musicAccountClient.library).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(page());
  await waitFor(() => expect(musicAccountClient.library).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(musicAccountClient.library).mock.calls[0][1]!;
  const bob = { ...collected, id: '14', name: 'Bob collection' };
  vi.mocked(musicAccountClient.library).mockResolvedValue(library([bob]));
  view.rerender(page({ userId: 'bob' }));
  expect(signal.aborted).toBe(true);
  expect(await screen.findByRole('button', { name: bob.name })).toBeVisible();
  await act(async () => finish(library([collected])));
  expect(screen.queryByRole('button', { name: collected.name })).not.toBeInTheDocument();
});

it('retries failed library requests and shows a genuine empty collection without synthetic songs', async () => {
  vi.mocked(musicAccountClient.library)
    .mockRejectedValueOnce(new Error('MUSIC_SOURCE_UNAVAILABLE'))
    .mockResolvedValueOnce(library([]));
  render(page());
  fireEvent.click(await screen.findByRole('button', { name: music.retry }));
  expect(await screen.findByText(music.kugouLibraryEmpty)).toBeVisible();
  expect(musicAccountClient.playlist).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: music.playAll })).not.toBeInTheDocument();
});
