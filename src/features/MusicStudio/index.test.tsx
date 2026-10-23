import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { I18nextProvider } from 'react-i18next';
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
    <I18nextProvider i18n={i18n}>
      <MusicPlayerProvider engine={engine} userId={userId}>
        <MusicStudio />
      </MusicPlayerProvider>
    </I18nextProvider>
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
