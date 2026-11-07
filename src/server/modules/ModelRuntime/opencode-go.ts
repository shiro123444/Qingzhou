import { createHash } from 'node:crypto';

import { CURRENT_VERSION } from '@/const/version';

/** Go requires an application identity and a stable, user-scoped conversation identity. */
export const getOpenCodeGoHeaders = (
  baseURL: string | undefined,
  scope: { userId: string; sessionId: string },
): Record<string, string> => {
  if (!baseURL || !scope?.userId?.trim() || !scope.sessionId?.trim()) return {};

  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return {};
  }
  if (
    url.origin !== 'https://opencode.ai' ||
    url.username ||
    url.password ||
    !/^\/inference\/go(?:\/|$)/u.test(url.pathname)
  )
    return {};

  return {
    'User-Agent': `Qingzhou/${CURRENT_VERSION}`,
    'x-opencode-session': createHash('sha256')
      .update(JSON.stringify(['qingzhou-opencode-go', scope.userId, scope.sessionId]))
      .digest('hex'),
  };
};
