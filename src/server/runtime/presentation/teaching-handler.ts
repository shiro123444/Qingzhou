import { teachingReviewSchema, teachingSourceReferenceSchema } from '@/types/presentationTeaching';

import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import type { TeachingLearning } from './teaching-memory';

/** Browser review is separate from the agent's typed, allowlisted atomic interface. */
export async function handleTeachingRequest(
  request: Request,
  scope: RuntimeScope,
  learning: TeachingLearning,
  verifyBrowserSession: () => Promise<boolean>,
): Promise<Response> {
  if (request.method === 'GET')
    return Response.json({ records: await learning.memory.list(scope) });
  if (request.method !== 'POST')
    return new Response(null, { status: 405, headers: { Allow: 'GET, POST' } });
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return Response.json(
      { error: { message: 'Teaching request must be a JSON object' } },
      { status: 400 },
    );
  if (body.action === 'analyze') {
    const reference = teachingSourceReferenceSchema.safeParse(body.reference);
    if (!reference.success)
      return Response.json({ error: { message: reference.error.message } }, { status: 400 });
    return Response.json({
      records: await learning.analyze(scope, reference.data, request.signal),
    });
  }
  if (body.action !== 'review')
    return Response.json({ error: { message: 'Unknown teaching action' } }, { status: 400 });
  // An agent/tool payload cannot grant approval. Require a real authenticated browser
  // session and same-origin mutation, not OIDC/tool auth or a supplied user id.
  if (
    request.headers.get('origin') !== new URL(request.url).origin ||
    !request.headers.get('content-type')?.startsWith('application/json') ||
    !(await verifyBrowserSession())
  )
    return Response.json(
      { error: { message: 'Teacher review requires a same-origin browser session' } },
      { status: 403 },
    );
  const review = teachingReviewSchema.safeParse(body.review);
  if (!review.success)
    return Response.json({ error: { message: review.error.message } }, { status: 400 });
  return Response.json({ record: await learning.memory.review(scope, review.data) });
}
