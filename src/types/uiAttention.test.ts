import { expect, it } from 'vitest';

import { formatUiAttention } from './uiAttention';

it('admits short-lived semantic context and explicitly denies implied instructions or authority', () => {
  const now = Date.now(),
    signal = { area: 'computer', evidence: 'dwell', observedAt: now };
  expect(formatUiAttention(signal, now)).toContain('not a user instruction');
  expect(formatUiAttention(signal, now)).toContain('Do not invent');
  expect(formatUiAttention(signal, now + 31000)).toBeUndefined();
  expect(formatUiAttention({ ...signal, observedAt: now + 6000 }, now)).toBeUndefined();
  expect(formatUiAttention({ ...signal, area: 'run-shell' })).toBeUndefined();
  expect(formatUiAttention({ ...signal, inputValue: 'private-secret' })).toBeUndefined();
  expect(formatUiAttention({ ...signal, x: 100, y: 200 })).toBeUndefined();
});
