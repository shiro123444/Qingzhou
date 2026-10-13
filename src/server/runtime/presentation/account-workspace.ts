import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const presentationAccountScope = (userId: string): RuntimeScope => {
  if (!userId?.trim()) throw new Error('Authenticated account is required');
  return { userId, sessionId: `presentation-account:${userId}` };
};

/** Session ids must come from the server's authenticated user/session table, never a request body. */
export async function migratePresentationSessions(
  root: string,
  userId: string,
  verifiedSessionIds: string[],
) {
  const account = presentationAccountScope(userId);
  const accountKey = hash(JSON.stringify([account.userId, account.sessionId]));
  const report = { copied: 0, kept: 0 };
  async function merge(source: string, destination: string) {
    // User data is supplied at runtime and must not be scanned into build artifacts.
    const entries = await readdir(/* turbopackIgnore: true */ source, {
      withFileTypes: true,
    }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name.endsWith('.tmp')) continue;
      const from = path.join(/* turbopackIgnore: true */ source, entry.name);
      const to = path.join(/* turbopackIgnore: true */ destination, entry.name);
      if (entry.isDirectory()) {
        await merge(from, to);
        continue;
      }
      if (!entry.isFile()) continue;
      await mkdir(destination, { recursive: true, mode: 0o700 });
      const existing = await readFile(/* turbopackIgnore: true */ to).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (existing) {
        // Jobs have mutable snapshots. Only adopt a strictly newer trusted snapshot.
        if (!source.endsWith('/jobs') || !entry.name.endsWith('.json')) {
          report.kept++;
          continue;
        }
        const old = JSON.parse(existing.toString());
        const incoming = JSON.parse(await readFile(/* turbopackIgnore: true */ from, 'utf8'));
        if ((old.job?.updatedAt ?? '') >= (incoming.job?.updatedAt ?? '')) {
          report.kept++;
          continue;
        }
      }
      const temporary = `${to}.${randomUUID()}.tmp`;
      try {
        await copyFile(from, temporary);
        await rename(temporary, to);
        report.copied++;
      } finally {
        await unlink(temporary).catch(() => {});
      }
    }
  }
  for (const sessionId of new Set(verifiedSessionIds)) {
    if (!sessionId || sessionId === account.sessionId) continue;
    const legacyKey = hash(JSON.stringify([userId, sessionId]));
    // Events remain execution-session history; current jobs provide a fresh snapshot on reconnect.
    for (const kind of ['jobs', 'artifacts'])
      await merge(
        path.join(/* turbopackIgnore: true */ root, legacyKey, kind),
        path.join(/* turbopackIgnore: true */ root, accountKey, kind),
      );
    await merge(
      path.join(/* turbopackIgnore: true */ root, 'templates', legacyKey, 'templates'),
      path.join(/* turbopackIgnore: true */ root, 'templates', accountKey, 'templates'),
    );
  }
  return report;
}
