import { checkAuth } from '@/app/(backend)/middleware/auth';
import { handleMusicCommand, musicErrorResponse } from '@/server/runtime/music/handler';
import { createMusicProvider } from '@/server/runtime/music/production';
import { getMusicRuntime } from '@/server/runtime/music/runtime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = checkAuth(async (request, { serverDB, userId }) => {
  try {
    return await handleMusicCommand(
      request,
      createMusicProvider(serverDB, userId),
      getMusicRuntime(),
    );
  } catch (error) {
    return musicErrorResponse(error, request);
  }
});
