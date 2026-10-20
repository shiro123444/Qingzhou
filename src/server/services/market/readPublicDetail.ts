import { MarketSDK } from '@lobehub/market-sdk';
import { TRPCError } from '@trpc/server';

import { getMarketBaseUrl } from '@/services/_url';

/** Public catalogue details must remain readable when a client token is rejected. */
export async function readPublicMarketDetail<T>(
  market: MarketSDK,
  read: (client: MarketSDK) => Promise<T>,
): Promise<T> {
  try {
    return await read(market);
  } catch (error) {
    if ((error as { status?: number } | null)?.status !== 401) throw error;

    // Use an isolated client: authenticated installation and account actions keep their token.
    const publicClient = new MarketSDK({ baseURL: getMarketBaseUrl() });
    publicClient.clearAuthToken();
    return read(publicClient);
  }
}

export function marketDetailError(error: unknown, message: string) {
  const status = (error as { status?: number } | null)?.status;
  return new TRPCError({
    cause: error,
    code:
      status === 404
        ? 'NOT_FOUND'
        : status === 401
          ? 'UNAUTHORIZED'
          : status === 403
            ? 'FORBIDDEN'
            : 'INTERNAL_SERVER_ERROR',
    message,
  });
}
