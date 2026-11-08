import { checkAuth } from '@/app/(backend)/middleware/auth';
import { handleMusicCover, musicErrorResponse } from '@/server/runtime/music/handler';
import { createMusicProvider } from '@/server/runtime/music/production';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return checkAuth(async (req, { serverDB, userId }) => {
    try {
      const { id } = await context.params;
      return await handleMusicCover(req, id, createMusicProvider(serverDB, userId));
    } catch (error) {
      return musicErrorResponse(error, req);
    }
  })(request, { params: Promise.resolve({}) });
}
