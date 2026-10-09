import { z } from 'zod';

import { checkAuth } from '@/app/(backend)/middleware/auth';
import { MultimodalChatProviderError } from '@/server/runtime/presentation/multimodal-chat-provider';
import { createUserChatProvider } from '@/server/runtime/presentation/user-chat-provider';
import { SiteError } from '@/server/runtime/sites/contracts';
import { getSitesRuntime } from '@/server/runtime/sites/runtime';
import { resolveUserChatProvider } from '@/server/services/modelProvider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = checkAuth(async (request, { userId, serverDB }) => {
  try {
    const origin = request.headers.get('origin');
    const localDevelopment =
      process.env.NODE_ENV === 'development' &&
      origin &&
      ['localhost', '127.0.0.1'].includes(new URL(origin).hostname) &&
      ['localhost', '127.0.0.1'].includes(new URL(request.url).hostname);
    if (origin && origin !== new URL(request.url).origin && !localDevelopment)
      throw new SiteError('SITE_FORBIDDEN', 'Use the same origin for site operations', 403);
    if (Number(request.headers.get('content-length')) > 1_200_000)
      throw new SiteError('SITE_LIMIT', 'Request too large', 413);
    const text = await request.text();
    if (Buffer.byteLength(text) > 1_200_000)
      throw new SiteError('SITE_LIMIT', 'Request too large', 413);
    const body = z
      .object({
        operation: z.enum([
          'sites.sources',
          'sites.source.read',
          'sites.list',
          'sites.create',
          'sites.read',
          'sites.change',
          'sites.publish',
          'sites.rollback',
          'sites.agent.edit',
        ]),
        input: z.unknown(),
      })
      .strict()
      .parse(JSON.parse(text));
    const result = await getSitesRuntime().runtime.invoke(body.operation, body.input, {
      scope: { userId, sessionId: `sites:${userId}` },
      signal: request.signal,
      services:
        body.operation === 'sites.agent.edit'
          ? {
              sitesChat: createUserChatProvider({
                fetcher: fetch,
                requiresVision: false,
                resolve: (scope) => resolveUserChatProvider(serverDB, scope.userId),
              }),
            }
          : undefined,
    });
    return Response.json({ success: true, result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof MultimodalChatProviderError)
      return Response.json(
        { success: false, code: 'SITE_AGENT_UNAVAILABLE', message: error.message },
        { status: 503 },
      );
    if (error instanceof SiteError)
      return Response.json(
        { success: false, code: error.code, message: error.message },
        { status: error.status },
      );
    if (
      error instanceof z.ZodError ||
      error instanceof SyntaxError ||
      (error as { code?: string })?.code === 'PRESENTATION_INVALID'
    )
      return Response.json(
        { success: false, code: 'SITE_INVALID', message: 'Invalid site request' },
        { status: 400 },
      );
    return Response.json(
      { success: false, code: 'SITE_OPERATION_FAILED', message: 'Site operation failed' },
      { status: 500 },
    );
  }
});
