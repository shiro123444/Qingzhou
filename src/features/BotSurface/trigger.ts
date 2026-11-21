/** Only inspect the token immediately before the caret. Never copy a host editor's draft. */
export function attachBotTrigger(open: () => void) {
  const allowed = (target: EventTarget | null): target is HTMLElement =>
    target instanceof HTMLElement &&
    !target.closest(
      '[data-private],input[type=password],[autocomplete=one-time-code],[data-bot-compose]',
    );
  function typed(target: HTMLElement) {
    if (!target.closest('[data-bot-mention],[role="dialog"],dialog')) return false;
    let value: string, offset: number;
    if (
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement && target.type === 'text')
    ) {
      if (
        target.readOnly ||
        target.disabled ||
        target.selectionStart === null ||
        target.selectionStart !== target.selectionEnd
      )
        return false;
      offset = target.selectionStart;
      value = target.value;
    } else if (target.isContentEditable) {
      const caret = window.getSelection();
      if (
        !caret?.isCollapsed ||
        !(caret.anchorNode instanceof Text) ||
        !target.contains(caret.anchorNode)
      )
        return false;
      value = caret.anchorNode.data;
      offset = caret.anchorOffset;
    } else return false;
    return /(?:^|\s)@bot$/i.test(value.slice(Math.max(0, offset - 5), offset));
  }
  const key = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing || e.repeat || !allowed(e.target)) return;
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyB') {
      e.preventDefault();
      open();
    }
  };
  const input = (e: InputEvent) => {
    if (
      e.defaultPrevented ||
      e.isComposing ||
      !e.cancelable ||
      e.inputType !== 'insertText' ||
      e.data !== ' ' ||
      !allowed(e.target) ||
      !typed(e.target)
    )
      return;
    e.preventDefault();
    open();
  };
  document.addEventListener('keydown', key);
  document.addEventListener('beforeinput', input);
  return () => {
    document.removeEventListener('keydown', key);
    document.removeEventListener('beforeinput', input);
  };
}
