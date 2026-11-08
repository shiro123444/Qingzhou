import { z } from 'zod';

import { checkAuth } from '@/app/(backend)/middleware/auth';
import { accountErrorResponse } from '@/server/runtime/music/account-handler';
import { createMusicAccountService } from '@/server/runtime/music/account-production';
import { MusicError } from '@/server/runtime/music/contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ playlistId: string }> }) {
  return checkAuth(async (req, { serverDB, userId }) => {
    try {
      if (req.headers.get('sec-fetch-site') === 'cross-site')
        throw new MusicError('MUSIC_FORBIDDEN', 403);
      const { playlistId } = z
        .object({ playlistId: z.string().regex(/^\d{1,20}$/u) })
        .parse(await context.params);
      z.string().uuid().parse(new URL(req.url).searchParams.get('revision'));
      return await createMusicAccountService(serverDB, userId).playlistCover(playlistId, req);
    } catch (error) {
      return accountErrorResponse(error, req);
    }
  })(request, { params: Promise.resolve({}) });
}
