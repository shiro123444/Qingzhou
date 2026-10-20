import type { Context } from 'hono';

import { getServerDB } from '@/database/core/db-adaptor';
import { BotDeliveryService } from '@/server/services/bot/BotDeliveryService';
import { BotInboundService } from '@/server/services/bot/BotInboundService';

/** Requires CRON_SECRET middleware. No caller can supply payloads, tenant IDs or destinations here. */
export async function botDeliveryCron(c: Context): Promise<Response> {
  c.header('Cache-Control', 'no-store');
  try {
    const db = await getServerDB();
    if (c.req.query('lane') === 'control') {
      const inbound = await new BotInboundService(db).sweep({ controlsOnly: true });
      return c.json({ inbound, success: true });
    }
    const [deliveryResult, inboundResult] = await Promise.allSettled([
      new BotDeliveryService(db).sweep(),
      new BotInboundService(db).sweep(),
    ]);
    if (deliveryResult.status === 'rejected' || inboundResult.status === 'rejected')
      throw new Error('worker_unavailable');
    const result = deliveryResult.value;
    const inbound = inboundResult.value;
    return c.json({ ...result, inbound, success: true });
  } catch {
    c.header('Retry-After', '10');
    return c.json({ error: 'Delivery worker unavailable', success: false }, 503);
  }
}
