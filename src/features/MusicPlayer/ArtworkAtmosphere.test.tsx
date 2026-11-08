import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { type MusicTrack } from '@/types/music';

import ArtworkAtmosphere from './ArtworkAtmosphere';
import { MusicPlayerProvider } from './context';
import { AudioEngine } from './engine';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

it('keeps artwork work off the audio clock and rejects late covers after track/account changes', async () => {
  const root = document.createElement('div');
  root.className = 'qz-glass-scene';
  document.body.append(root);
  const images: HTMLImageElement[] = [];
  vi.spyOn(globalThis, 'Image').mockImplementation(function () {
    const image = document.createElement('img');
    Object.defineProperties(image, { naturalWidth: { value: 480 }, naturalHeight: { value: 480 } });
    images.push(image);
    return image;
  });
  const drawImage = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA');
  const engine = new AudioEngine({
    client: { resolve: vi.fn(), search: vi.fn(), track: vi.fn(), uploadAudio: vi.fn() },
    storage: { getItem: () => null, removeItem: () => {}, setItem: () => {} },
  });
  const track: MusicTrack = {
    id: 'cover-a',
    coverUrl: '/api/runtime/music/tracks/a/cover',
    name: 'A',
    mimeType: 'audio/mpeg',
    size: 0,
    source: 'kugou',
    version: '1',
  };
  const page = (userId: string | null) => (
    <MusicPlayerProvider engine={engine} userId={userId}>
      <ArtworkAtmosphere />
    </MusicPlayerProvider>
  );
  const view = render(page('alice'));
  await act(async () => engine.store.setState({ activeId: track.id, queue: [track] }));
  const first = images.at(-1)!;
  const lateFirstLoad = first.onload!;
  await act(async () =>
    engine.store.setState({ queue: [{ ...track, coverUrl: '/api/runtime/music/tracks/b/cover' }] }),
  );
  const second = images.at(-1)!;
  lateFirstLoad.call(first, new Event('load'));
  expect(drawImage).not.toHaveBeenCalled();
  second.onload!.call(second, new Event('load'));
  expect(root.style.getPropertyValue('--qz-music-artwork')).toContain('data:image/png;base64,AAAA');
  const count = images.length;
  await act(async () => {
    for (let positionMs = 0; positionMs < 1000; positionMs += 10)
      engine.store.setState({ positionMs });
  });
  expect(images).toHaveLength(count);
  expect(drawImage).toHaveBeenCalledTimes(1);
  const lateSecondLoad = second.onload!;
  view.rerender(page('bob'));
  lateSecondLoad.call(second, new Event('load'));
  expect(root.style.getPropertyValue('--qz-music-artwork')).toBe('');
  expect(drawImage).toHaveBeenCalledTimes(1);
  view.unmount();
});
