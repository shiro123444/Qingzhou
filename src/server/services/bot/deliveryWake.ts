import { after } from 'next/server';

import type { LobeChatDatabase } from '@/database/type';

/** Latency optimization only. SQL/Redis durability + independently scheduled cron provide recovery. */
export function wakeBotDelivery(db: LobeChatDatabase): void {
  try {
    after(async () => {
      try {
        const { BotDeliveryService } = await import('./BotDeliveryService');
        const { BotInboundService } = await import('./BotInboundService');
        const results = await Promise.allSettled([
          new BotDeliveryService(db).sweep(),
          new BotInboundService(db).sweep(),
        ]);
        if (results.some((r) => r.status === 'rejected')) throw new Error('drain_deferred');
      } catch {
        console.error('Bot delivery background drain deferred to scheduler');
      }
    });
  } catch {
    // CLI/non-Next callers have no request lifetime. Never drop durability or start an untracked timer.
  }
}
