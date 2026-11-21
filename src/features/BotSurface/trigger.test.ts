import { expect, it, vi } from 'vitest';

import { attachBotTrigger } from './trigger';

it('handles an explicit token at the caret in a dialog, ignores email, private input and IME, and disposes the listener', () => {
  const dialog = document.createElement('dialog'),
    field = document.createElement('textarea');
  dialog.append(field);
  document.body.append(dialog);
  const open = vi.fn(),
    dispose = attachBotTrigger(open);
  function space(value: string, composing = false) {
    field.value = value;
    field.setSelectionRange(value.length, value.length);
    return field.dispatchEvent(
      new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        data: ' ',
        inputType: 'insertText',
        isComposing: composing,
      }),
    );
  }
  try {
    expect(space('address@bot')).toBe(true);
    expect(space('@bot', true)).toBe(true);
    field.dataset.private = '';
    expect(space('@bot')).toBe(true);
    delete field.dataset.private;
    expect(space('hello @bot')).toBe(false);
    expect(field.value).toBe('hello @bot');
    dispose();
    expect(space('@bot')).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  } finally {
    dispose();
    dialog.remove();
  }
});
