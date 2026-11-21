import { expect, it } from 'vitest';

import type { ComputerView } from '@/types/agentComputer';

import { companionState } from './companionState';

const ready: ComputerView = {
  enabled: true,
  commands: [],
  session: { id: 's', control: 'agent', state: 'ready', busy: false, revision: 1, updatedAt: '' },
};
it('shows a computer only for real activity or human control, never just an allocated session', () => {
  expect(companionState(ready)).toBe('idle');
  expect(companionState({ ...ready, botActivity: { phase: 'working', topicId: 't' } })).toBe(
    'thinking',
  );
  expect(companionState({ ...ready, botActivity: { phase: 'queued', topicId: 't' } })).toBe(
    'queued',
  );
  expect(companionState({ ...ready, activity: { phase: 'working', topicId: 't' } })).toBe(
    'working',
  );
  expect(companionState({ ...ready, activity: { phase: 'approval', topicId: 't' } })).toBe(
    'approval',
  );
  expect(companionState({ ...ready, session: { ...ready.session!, control: 'human' } })).toBe(
    'human',
  );
  expect(companionState(ready, true)).toBe('unavailable');
  expect(companionState({ ...ready, bindingChanged: true })).toBe('unavailable');
  expect(companionState({ ...ready, session: { ...ready.session!, state: 'unknown' } })).toBe(
    'unavailable',
  );
});
