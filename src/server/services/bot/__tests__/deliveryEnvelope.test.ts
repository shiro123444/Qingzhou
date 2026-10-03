// @vitest-environment node
import { expect, it } from 'vitest';

import { deliveryEnvelope } from '../deliveryEnvelope';

it('gives a pause its own resumable identity without colliding with progress or final completion', () => {
  const body = {
    applicationId: 'app',
    operationId: 'op',
    platformThreadId: 'wechat:sender',
    userId: 'owner',
    type: 'completion',
    reason: 'waiting_for_human',
    steps: 3,
  };
  const pause = deliveryEnvelope(body);
  expect(pause.payload).toMatchObject({ type: 'step', stepIndex: 3, reason: 'waiting_for_human' });
  const progress = deliveryEnvelope({ ...body, type: 'step', reason: undefined, stepIndex: 3 });
  const final = deliveryEnvelope({ ...body, reason: 'done', steps: 6 });
  expect(new Set([pause.eventKey, progress.eventKey, final.eventKey]).size).toBe(3);
  expect(new Set([pause.scopeKey, progress.scopeKey, final.scopeKey]).size).toBe(1);
  expect(deliveryEnvelope({ ...body, duration: 22 }).eventKey).toBe(pause.eventKey);
});
