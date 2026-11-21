import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import MusicArtwork, { MUSIC_ARTWORK } from './MusicArtwork';

afterEach(cleanup);

it('uses celadon for missing or failed covers and accepts the next real album cover', () => {
  const view = render(<MusicArtwork />);
  const image = view.container.querySelector('img')!;
  expect(image).toHaveAttribute('src', MUSIC_ARTWORK);
  view.rerender(<MusicArtwork coverUrl="/album-a.jpg" />);
  expect(image).toHaveAttribute('src', '/album-a.jpg');
  fireEvent.error(image);
  expect(image).toHaveAttribute('src', MUSIC_ARTWORK);
  view.rerender(<MusicArtwork coverUrl="/album-b.jpg" />);
  expect(image).toHaveAttribute('src', '/album-b.jpg');
  expect(image).toHaveAttribute('data-music-artwork', 'cover');
});
