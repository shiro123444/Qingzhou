import type { Context } from 'hono';

import { getServerDB } from '@/database/core/db-adaptor';
import { BotDeliveryService } from '@/server/services/bot/BotDeliveryService';

/** Requires CRON_SECRET middleware. No caller can supply payloads, tenant IDs or destinations here. */
export async function botDeliveryCron(c: Context): Promise<Response> {
  c.header('Cache-Control', 'no-store');
  try {
    const result = await new BotDeliveryService(await getServerDB()).sweep();
    return c.json({ ...result, success: true });
  } catch {
    c.header('Retry-After', '10');
    return c.json({ error: 'Delivery worker unavailable', success: false }, 503);
  }
}
