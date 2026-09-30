import { after } from 'next/server';

import type { LobeChatDatabase } from '@/database/type';

/** Latency optimization only. SQL/Redis durability + independently scheduled cron provide recovery. */
export function wakeBotDelivery(db: LobeChatDatabase): void {
  try {
    after(async () => {
      try {
        const { BotDeliveryService } = await import('./BotDeliveryService');
        await new BotDeliveryService(db).sweep();
      } catch {
        console.error('Bot delivery background drain deferred to scheduler');
      }
    });
  } catch {
    // CLI/non-Next callers have no request lifetime. Never drop durability or start an untracked timer.
  }
}
