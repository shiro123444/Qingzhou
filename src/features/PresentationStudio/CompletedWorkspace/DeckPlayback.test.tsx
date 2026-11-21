import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import type { ArtifactSnapshot } from '../../../../packages/runtime-contracts/src/index';
import { DeckPlayback } from './DeckPlayback';

it('keeps touch navigation, a focus loop and an explicit exit when native fullscreen is denied', () => {
  const slides: ArtifactSnapshot[] = Array.from({ length: 3 }, (_, index) => ({
    artifactId: 'slide-' + index,
    createdAt: '',
    updatedAt: '',
    mimeType: 'image/svg+xml',
    type: 'svg',
    sizeBytes: 40,
    status: 'ready',
    name: 'Slide ' + (index + 1),
    uri: 'slide-' + index + '.svg',
  }));
  const fullscreen = Object.getOwnPropertyDescriptor(document, 'fullscreenEnabled');
  const request = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'requestFullscreen');
  const denied = vi.fn().mockRejectedValue(new DOMException('Unavailable', 'NotAllowedError'));
  Object.defineProperty(document, 'fullscreenEnabled', { configurable: true, value: true });
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
    configurable: true,
    value: denied,
  });
  try {
    const onExit = vi.fn();
    const { unmount } = render(<DeckPlayback slides={slides} startIndex={0} onExit={onExit} />);
    const player = screen.getByRole('dialog');
    expect(denied).toHaveBeenCalledOnce();
    const exit = within(player).getByRole('button', {
      name: /exitPlayback|Exit slideshow|退出放映/i,
    });
    fireEvent.keyDown(player, { key: 'Tab', shiftKey: true });
    expect(exit).toHaveFocus();
    const image = within(player).getByRole('img');
    for (const [type, x] of [
      ['pointerdown', 150],
      ['pointerup', 45],
    ] as const) {
      const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 20 });
      Object.assign(event, { pointerId: 2, pointerType: 'touch', isPrimary: true });
      fireEvent(image, event);
    }
    expect(within(player).getByText('2 / 3')).toBeInTheDocument();
    fireEvent.click(exit);
    expect(onExit).toHaveBeenCalledOnce();
    unmount();
  } finally {
    if (fullscreen) Object.defineProperty(document, 'fullscreenEnabled', fullscreen);
    else Reflect.deleteProperty(document, 'fullscreenEnabled');
    if (request) Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', request);
    else Reflect.deleteProperty(HTMLElement.prototype, 'requestFullscreen');
  }
});
