import { BotDeliveryModel } from '@/database/models/botDelivery';
import { getServerDB } from '@/database/server';

import { deliveryEnvelope, normalizeBotPausePayload } from './deliveryEnvelope';
import { wakeBotDelivery } from './deliveryWake';
import { boundedDeliveryIO } from './postgresCallbackLedger';

/** Used only for the built-in, same-application callback. Custom webhooks keep their transport. */
export async function enqueueBotOutbox(
  payload: Record<string, unknown>,
  assertHeld?: () => void,
): Promise<void> {
  const envelope = deliveryEnvelope(payload);
  payload = normalizeBotPausePayload(payload);
  if (payload.type === 'completion' && payload.reason === 'waiting_for_human') return;
  const db = await getServerDB();
  const receipt = await boundedDeliveryIO(() => {
    assertHeld?.();
    return new BotDeliveryModel(db).enqueue('outbox', envelope);
  });
  if (
    receipt.status === 'pending' ||
    receipt.status === 'running' ||
    receipt.status === 'transferred'
  )
    wakeBotDelivery(db);
}
