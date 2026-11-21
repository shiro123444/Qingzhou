import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { readUiAttention, useUiAttentionStore } from '@/store/uiAttention';

import { attentionArea, useCompanionAwareness } from './useCompanionAwareness';

function Subject({ enabled = true, owner = 'owner' }: { enabled?: boolean; owner?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useCompanionAwareness({ ownerId: owner, agentId: 'agent', avatar: ref, enabled });
  return (
    <>
      <span ref={ref} />
      <div data-qz-attention="computer" data-testid="computer">
        Computer
      </div>
      <textarea aria-label="Composer" />
      <input aria-label="Password" defaultValue="private-secret" type="password" />
    </>
  );
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useUiAttentionStore.setState({
    ownerId: undefined,
    agentId: undefined,
    signal: undefined,
    enabled: true,
  });
});

it('recognizes the current workspace without reading text or exposing route identifiers', () => {
  const workspace = document.createElement('div');
  workspace.dataset.companionContent = '';
  const content = document.createElement('p');
  content.textContent = 'private document text';
  workspace.append(content);
  expect(attentionArea(content, '/agent/private-id')).toBe('conversation');
  expect(attentionArea(content, '/music')).toBe('music');
  expect(attentionArea(content, '/page/private-id')).toBe('documents');
  expect(attentionArea(content, '/settings/provider')).toBeUndefined();
  expect(attentionArea(document.createElement('p'), '/music')).toBeUndefined();
});

it('recovers an editor that already focused before the lazy companion mounted', () => {
  const editor = document.createElement('textarea');
  document.body.append(editor);
  editor.focus();
  const view = render(<Subject />);
  expect(readUiAttention('owner', 'agent')).toMatchObject({ area: 'compose', evidence: 'focus' });
  view.unmount();
  editor.remove();
});

it('waits for sustained pointer dwell and never starts an action', () => {
  vi.useFakeTimers();
  const view = render(<Subject />),
    region = view.getByTestId('computer');
  fireEvent.pointerMove(region, { clientX: 80, clientY: 80, pointerType: 'mouse' });
  act(() => vi.advanceTimersByTime(600));
  fireEvent.pointerMove(region, { clientX: 81, clientY: 80, pointerType: 'mouse' });
  expect(readUiAttention('owner', 'agent')).toBeUndefined();
  act(() => vi.advanceTimersByTime(600));
  expect(readUiAttention('owner', 'agent')).toMatchObject({ area: 'computer', evidence: 'dwell' });
  expect(readUiAttention('another-owner', 'agent')).toBeUndefined();
  expect(readUiAttention('owner', 'another-agent')).toBeUndefined();
});

it('uses coarse focus only, clears private focus, disables capture and discards data on unmount', () => {
  const view = render(<Subject />);
  fireEvent.focusIn(view.getByRole('textbox', { name: 'Composer' }));
  expect(readUiAttention('owner', 'agent')).toMatchObject({ area: 'compose', evidence: 'focus' });
  fireEvent.focusIn(view.getByLabelText('Password'));
  expect(readUiAttention('owner', 'agent')).toBeUndefined();
  expect(JSON.stringify(useUiAttentionStore.getState())).not.toContain('private-secret');
  view.rerender(<Subject enabled={false} />);
  fireEvent.focusIn(view.getByRole('textbox', { name: 'Composer' }));
  expect(readUiAttention('owner', 'agent')).toBeUndefined();
  view.unmount();
  expect(useUiAttentionStore.getState().ownerId).toBeUndefined();
});
