import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { afterEach, expect, it } from 'vitest';

import FloatingPlayerLayer from './FloatingPlayerLayer';

afterEach(cleanup);

function PlayerState() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(count + 1)}>Player {count}</button>;
}

function Workspace({ label }: { label: string }) {
  return (
    <div data-qz-glass-scene style={{ '--test-player-theme': 'celadon' } as React.CSSProperties}>
      <div data-workspace style={{ isolation: 'isolate', overflow: 'hidden' }}>
        {label}
        <FloatingPlayerLayer>
          <PlayerState />
        </FloatingPlayerLayer>
      </div>
    </div>
  );
}

it('escapes the workspace into one themed scene layer and preserves controls across route renders', () => {
  const view = render(
    <StrictMode>
      <Workspace label="Chat" />
    </StrictMode>,
  );
  const button = screen.getByRole('button', { name: 'Player 0' });
  const layer = document.querySelector('[data-music-player-layer]')!;
  expect(layer.parentElement).toBe(document.querySelector('[data-qz-glass-scene]'));
  expect(button.closest('[data-workspace]')).toBeNull();
  expect(document.querySelectorAll('[data-music-player-layer]')).toHaveLength(1);
  fireEvent.click(button);
  view.rerender(
    <StrictMode>
      <Workspace label="Presentation" />
    </StrictMode>,
  );
  expect(screen.getByRole('button', { name: 'Player 1' })).toBe(button);
  expect(document.querySelector('[data-music-player-layer]')).toBe(layer);
  view.unmount();
  expect(document.querySelector('[data-music-player-layer]')).toBeNull();
});
