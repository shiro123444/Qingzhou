import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { expect, it, vi } from 'vitest';

import CreationGallery, { StylePicker } from './CreationGallery';

it('can inspect an alternative and switch all samples without changing the selected design', async () => {
  const onSelect = vi.fn();
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <CreationGallery recent={[]} selected="academic-research" onSelect={onSelect} />
    </ConfigProvider>,
  );

  const alternative = screen.getByTestId('presentation-style-technical-deepdive');
  const previewButton = within(alternative.parentElement!).getByRole('button', {
    name: 'presentationGallery.enlarge',
  });
  fireEvent.click(previewButton);
  let dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'presentationGallery.content' }));
  expect(
    within(dialog).getByRole('img', { name: 'presentationGallery.sample.content' }),
  ).toHaveAttribute('src', '/images/presentation-styles/technical-deepdive-content.svg');
  for (const card of screen.getAllByTestId(/^presentation-style-/))
    expect(card.querySelector('img')?.getAttribute('src')).toMatch(/-content\.svg$/);

  fireEvent.click(within(dialog).getByRole('button', { name: /close/i }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(onSelect).not.toHaveBeenCalled();
  expect(screen.getByTestId('presentation-style-academic-research')).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  fireEvent.click(previewButton);
  dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'presentationGallery.useDesign' }));
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('technical-deepdive');
});

it('opens visual style cards from the composer action and selects a real thumbnail', async () => {
  const onSelect = vi.fn();
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <StylePicker onSelect={onSelect} />
    </ConfigProvider>,
  );

  expect(screen.queryByTestId('presentation-style-narrative-keynote')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'presentationGallery.styles' }));
  const style = await screen.findByTestId('presentation-style-narrative-keynote');
  expect(style.querySelector('img')).toHaveAttribute(
    'src',
    '/images/presentation-styles/narrative-keynote-cover.svg',
  );
  fireEvent.click(style);
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('narrative-keynote');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'presentationGallery.styles' })).toHaveAttribute(
      'aria-expanded',
      'false',
    ),
  );
});
