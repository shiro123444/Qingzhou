// @vitest-environment node
import { MarketSDK } from '@lobehub/market-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { marketDetailError, readPublicMarketDetail } from './readPublicDetail';

const response = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('public community detail authentication', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('reads an authenticated detail without retrying', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(response(200, { identifier: 'agent' }));
    const market = new MarketSDK({ accessToken: 'account-token' });
    await expect(
      readPublicMarketDetail(market, (client) => client.agents.getAgentDetail('agent')),
    ).resolves.toEqual({ identifier: 'agent' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries public content without bearer credentials and preserves the account client', async () => {
    vi.stubEnv('MARKET_API_KEY', 'environment-token');
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response(401, { error: 'invalid_token' }))
      .mockResolvedValueOnce(response(200, { identifier: 'agent' }))
      .mockResolvedValueOnce(response(200, { identifier: 'agent' }));
    const market = new MarketSDK({ accessToken: 'account-token' });

    await expect(
      readPublicMarketDetail(market, (client) => client.agents.getAgentDetail('agent')),
    ).resolves.toEqual({ identifier: 'agent' });
    expect(new Headers(fetch.mock.calls[1][1]?.headers).has('Authorization')).toBe(false);
    expect(new Headers(fetch.mock.calls[1][1]?.headers).has('x-lobe-trust-token')).toBe(false);
    await market.agents.getAgentDetail('agent');
    expect(new Headers(fetch.mock.calls[2][1]?.headers).get('Authorization')).toBe(
      'Bearer account-token',
    );
  });

  it.each([404, 500])('preserves HTTP %s without an authentication retry', async (status) => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(response(status, { error: 'unavailable' }));
    const market = new MarketSDK();
    await expect(
      readPublicMarketDetail(market, (client) => client.agents.getAgentDetail('agent')),
    ).rejects.toMatchObject({ status });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('cannot expose a detail rejected by both authenticated and public requests', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => response(401, { error: 'unauthorized' }));
    const market = new MarketSDK({ accessToken: 'account-token' });
    await expect(
      readPublicMarketDetail(market, (client) =>
        client.marketSkills.getSkillDetail('private-skill'),
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps missing content distinct from upstream and authentication failures', () => {
    expect(marketDetailError({ status: 404 }, 'Detail failed').code).toBe('NOT_FOUND');
    expect(marketDetailError({ status: 401 }, 'Detail failed').code).toBe('UNAUTHORIZED');
    expect(marketDetailError({ status: 500 }, 'Detail failed').code).toBe('INTERNAL_SERVER_ERROR');
  });
});
