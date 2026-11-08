import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import { MusicPlayerProvider } from '@/features/MusicPlayer/context';
import { AudioEngine } from '@/features/MusicPlayer/engine';
import music from '@/locales/default/music';
import { type MusicTrack } from '@/types/music';

import MusicStudio from '.';

afterEach(cleanup);

it('discards another account search even when its transport completes after cancellation', async () => {
  i18n.addResourceBundle('zh-CN', 'music', music);
  let alice!: (tracks: MusicTrack[]) => void;
  let bob!: (tracks: MusicTrack[]) => void;
  const search = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          alice = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          bob = resolve;
        }),
    );
  const engine = new AudioEngine({
    client: { search, track: vi.fn(), resolve: vi.fn(), uploadAudio: vi.fn() },
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  const page = (userId: string | null) => (
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <MusicPlayerProvider engine={engine} userId={userId}>
          <MusicStudio />
        </MusicPlayerProvider>
      </I18nextProvider>
    </MemoryRouter>
  );
  const view = render(page('alice'));
  await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
  const signal = search.mock.calls[0][2] as AbortSignal;
  view.rerender(page('bob'));
  await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
  expect(signal.aborted).toBe(true);
  const track: MusicTrack = {
    id: 'a',
    name: 'Alice private audio',
    mimeType: 'audio/mpeg',
    size: 100,
    source: 'library',
    version: '1',
  };
  await act(async () => {
    alice([track]);
  });
  expect(screen.queryByText('Alice private audio')).not.toBeInTheDocument();
  await act(async () => {
    bob([{ ...track, id: 'b', name: 'Bob audio' }]);
  });
  expect(await screen.findByText('Bob audio')).toBeInTheDocument();
  view.rerender(page(null));
  expect(screen.queryByText('Bob audio')).not.toBeInTheDocument();
  expect(screen.getByText(music.login)).toBeInTheDocument();
});

it('lets the lyrics plugin be disabled and enabled without changing playback', async () => {
  i18n.addResourceBundle('zh-CN', 'music', music);
  const engine = new AudioEngine({
    client: {
      search: vi.fn().mockResolvedValue([]),
      track: vi.fn(),
      resolve: vi.fn(),
      uploadAudio: vi.fn(),
    },
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  const play = vi.spyOn(engine, 'play');
  const pause = vi.spyOn(engine, 'pause');
  render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <MusicPlayerProvider engine={engine} userId="lyrics-ui-test">
          <MusicStudio />
        </MusicPlayerProvider>
      </I18nextProvider>
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByRole('tab', { name: music.plugins }));
  expect(await screen.findByText(music.pluginEnabled)).toBeVisible();
  fireEvent.click(screen.getByRole('switch', { name: music.lyricsPlugin }));
  expect(await screen.findByText(music.pluginDisabled)).toBeVisible();
  expect(screen.getByRole('switch', { name: music.lyricsPlugin })).not.toBeChecked();

  fireEvent.click(screen.getByRole('tab', { name: music.nowPlaying }));
  expect(screen.getByText(music.lyricsPluginDisabled)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: music.enableLyricsPlugin }));
  expect(await screen.findByText(music.emptyLyrics)).toBeVisible();
  expect(play).not.toHaveBeenCalled();
  expect(pause).not.toHaveBeenCalled();
});

it('searches Kugou separately from local files and shows real artwork and preview access', async () => {
  i18n.addResourceBundle('zh-CN', 'music', music);
  const track: MusicTrack = {
    id: 'kugou:' + 'a'.repeat(32) + ':12:34',
    name: 'Real catalog song',
    artist: 'Recording artist',
    album: 'Real album',
    coverUrl: '/api/runtime/music/tracks/kugou%3Atest/cover',
    durationMs: 60000,
    mimeType: 'audio/mpeg',
    playbackKind: 'preview',
    size: 960000,
    source: 'kugou',
    version: '1',
  };
  const search = vi.fn().mockResolvedValue([track]);
  const engine = new AudioEngine({
    client: { search, track: vi.fn(), resolve: vi.fn(), uploadAudio: vi.fn() },
    storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  const play = vi.spyOn(engine, 'playTrack').mockImplementation((selected) => {
    engine.store.setState({ activeId: selected.id, queue: [selected], status: 'paused' });
  });
  const page = render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <MusicPlayerProvider engine={engine} userId="kugou-ui">
          <MusicStudio />
        </MusicPlayerProvider>
      </I18nextProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('tab', { name: music.library }));
  expect(screen.getByRole('button', { name: music.kugou })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.change(screen.getByRole('searchbox', { name: music.searchKugou }), {
    target: { value: 'Real song' },
  });
  await waitFor(() =>
    expect(search).toHaveBeenLastCalledWith('Real song', 50, expect.any(AbortSignal), 'kugou'),
  );
  fireEvent.click(await screen.findByRole('button', { name: music.play + ' Real catalog song' }));
  expect(play).toHaveBeenCalledWith(track);
  expect(screen.getByText(music.kugouPreview)).toBeVisible();
  expect(page.container.querySelector('img[src="' + track.coverUrl + '"]')).toBeVisible();
  fireEvent.click(screen.getByRole('tab', { name: music.library }));
  fireEvent.click(screen.getByRole('button', { name: music.localLibrary }));
  await waitFor(() =>
    expect(search).toHaveBeenLastCalledWith('', 50, expect.any(AbortSignal), 'library'),
  );
});
