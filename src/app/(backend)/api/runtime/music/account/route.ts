import { checkAuth } from '@/app/(backend)/middleware/auth';
import { accountErrorResponse, handleMusicAccount } from '@/server/runtime/music/account-handler';
import { createMusicAccountService } from '@/server/runtime/music/account-production';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = checkAuth(async (request, { serverDB, userId }) => {
  try {
    return await handleMusicAccount(request, createMusicAccountService(serverDB, userId));
  } catch (error) {
    return accountErrorResponse(error, request);
  }
});
