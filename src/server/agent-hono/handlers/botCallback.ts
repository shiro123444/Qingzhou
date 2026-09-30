import type { Context } from 'hono';

import { getServerDB } from '@/database/core/db-adaptor';
import { BotDeliveryConflict } from '@/database/models/botDelivery';
import { BotDeliveryService } from '@/server/services/bot/BotDeliveryService';
import { durableCallbackSchema, MAX_CALLBACK_BYTES } from '@/server/services/bot/deliveryEnvelope';
import { wakeBotDelivery } from '@/server/services/bot/deliveryWake';

/** QStash-authenticated compatibility ingress. ACK means SQL receipt, not platform delivery. */
export async function botCallback(c: Context): Promise<Response> {
  let body: unknown;
  try {
    const text = await c.req.text();
    if (Buffer.byteLength(text) > MAX_CALLBACK_BYTES)
      return c.json({ error: 'Callback too large' }, 413);
    body = JSON.parse(text);
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = durableCallbackSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Invalid callback identity or payload' }, 400);

  try {
    const db = await getServerDB();
    const receipt = await new BotDeliveryService(db).accept(body);
    if (receipt.status === 'skipped') return c.json({ status: 'skipped', success: true });
    if (receipt.status === 'pending' || receipt.status === 'running') wakeBotDelivery(db);
    return c.json(
      { deliveryStatus: receipt.status, receiptId: receipt.id, status: 'accepted', success: true },
      202,
    );
  } catch (error) {
    if (error instanceof BotDeliveryConflict)
      return c.json({ status: 'payload_conflict', success: false }, 409);
    c.header('Retry-After', '10');
    return c.json({ status: 'receipt_unavailable', success: false }, 503);
  }
}
