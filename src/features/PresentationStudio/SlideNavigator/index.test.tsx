import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ArtifactSnapshot } from '../../../../packages/runtime-contracts/src/index';
import SlideNavigator from './index';

const slide = (
  artifactId: string,
  status: ArtifactSnapshot['status'] = 'ready',
): ArtifactSnapshot => ({
  artifactId,
  createdAt: '2026-08-30T10:01:00.000Z',
  mimeType: 'image/svg+xml',
  name: `${artifactId}.svg`,
  sizeBytes: 100,
  status,
  type: 'svg',
  updatedAt: '2026-08-30T10:01:00.000Z',
  uri: status === 'ready' ? 'data:image/svg+xml,test' : undefined,
});

describe('SlideNavigator', () => {
  it('renders a thumbnail per slide with the artifact uri in the preview image', () => {
    const slides = [slide('s-1'), slide('s-2')];
    render(
      <SlideNavigator hasSelection selectedArtifactId="s-1" slides={slides} onSelect={vi.fn()} />,
    );

    expect(screen.getByTestId('slide-navigator-item-s-1')).toBeInTheDocument();
    expect(screen.getByTestId('slide-navigator-item-s-2')).toBeInTheDocument();
    const images = screen.getAllByRole('img');
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute('src', 'data:image/svg+xml,test');
  });

  it('keeps failed slides visible but non-selectable (aria-disabled)', () => {
    const onSelect = vi.fn();
    const slides = [slide('s-failed', 'failed'), slide('s-ok')];
    render(
      <SlideNavigator hasSelection selectedArtifactId={null} slides={slides} onSelect={onSelect} />,
    );

    const failed = screen.getByTestId('slide-navigator-item-s-failed');
    expect(failed).toHaveAttribute('aria-disabled', 'true');
    expect(failed).toHaveAttribute('tabindex', '-1');
    expect(failed).toHaveAttribute('data-ready', 'false');

    fireEvent.click(failed);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('selects a slide on click and on Enter/Space', () => {
    const onSelect = vi.fn();
    render(
      <SlideNavigator
        hasSelection
        selectedArtifactId={null}
        slides={[slide('s-1'), slide('s-2')]}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(screen.getByTestId('slide-navigator-item-s-2'));
    expect(onSelect).toHaveBeenCalledWith('s-2');

    fireEvent.keyDown(screen.getByTestId('slide-navigator-item-s-1'), { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('s-1');
    fireEvent.keyDown(screen.getByTestId('slide-navigator-item-s-1'), { key: ' ' });
    expect(onSelect).toHaveBeenCalledTimes(3);
  });

  it('supports arrow-key navigation through the listbox', () => {
    const onSelect = vi.fn();
    render(
      <SlideNavigator
        hasSelection
        selectedArtifactId="s-1"
        slides={[slide('s-1'), slide('s-2'), slide('s-3')]}
        onSelect={onSelect}
      />,
    );

    const grid = screen.getByTestId('slide-navigator-grid');

    // Right moves forward
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenLastCalledWith('s-2');
    expect(screen.getByTestId('slide-navigator-item-s-2')).toHaveFocus();
    fireEvent.keyDown(grid, { key: 'End' });
    expect(onSelect).toHaveBeenLastCalledWith('s-3');
    expect(screen.getByTestId('slide-navigator-item-s-3')).toHaveFocus();

    // Left and Up move backward with wrap-around
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    expect(onSelect).toHaveBeenLastCalledWith('s-3');

    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenLastCalledWith('s-2');
  });

  it('renders the honest empty state when no slides exist', () => {
    render(
      <SlideNavigator
        hasSelection={false}
        selectedArtifactId={null}
        slides={[]}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByTestId('slide-navigator-empty')).toHaveTextContent('Select a completed job');
  });
});
