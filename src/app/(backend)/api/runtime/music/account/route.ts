import { checkAuth } from '@/app/(backend)/middleware/auth';
import { withBuiltinPlugin } from '@/server/runtime/builtin-plugins';
import { accountErrorResponse, handleMusicAccount } from '@/server/runtime/music/account-handler';
import { createMusicAccountService } from '@/server/runtime/music/account-production';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = checkAuth(
  withBuiltinPlugin('music', async (request, { serverDB, userId }) => {
    try {
      return await handleMusicAccount(request, createMusicAccountService(serverDB, userId));
    } catch (error) {
      return accountErrorResponse(error, request);
    }
  }),
);
