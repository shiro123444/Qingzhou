import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { AtomicPlugin, AtomicRuntime } from '../atomic-runtime';
import type { SkillChatPort } from '../skills-plugin';
import {
  assertSiteAgentAccess,
  readSiteAgentTarget,
  recordSiteAgentRevision,
  siteDraftView,
  siteReadResult,
  withSiteAgentScope,
} from './composition';
import {
  changesSchema,
  filesSchema,
  revisionSchema,
  siteEditReceiptSchema,
  SiteError,
  siteIdSchema,
} from './contracts';
import { type SiteSource, sourceOperations } from './sources';
import type { SiteStore } from './store';

const owned = z.object({ id: siteIdSchema }).strict();
const versioned = owned.extend({ baseRevision: revisionSchema });

export function createSitesPlugin(
  store: SiteStore,
  chat?: SkillChatPort,
  sources: SiteSource[] = [],
  runtime?: () => AtomicRuntime,
): AtomicPlugin {
  return {
    id: 'sites',
    version: '1.0.0',
    operations: [
      ...sourceOperations(sources),
      {
        name: 'sites.list',
        description: 'List blogs owned by the authenticated account.',
        input: z.object({}).strict(),
        execute: (_, ctx) => store.list(ctx.scope.userId),
      },
      {
        name: 'sites.create',
        description: 'Create an owned blog with a portable Markdown article.',
        input: z
          .object({
            name: z.string().trim().min(1).max(60),
            author: z.string().trim().min(1).max(80),
          })
          .strict(),
        execute: ({ name, author }, ctx) => store.create(ctx.scope.userId, name, author),
      },
      {
        name: 'sites.read',
        agent: { contexts: ['sites.edit', 'skills'], maxCalls: 2 },
        description: 'Read owned draft content and its base revision.',
        input: owned,
        execute: async ({ id }, ctx) => {
          assertSiteAgentAccess(ctx, id);
          return siteReadResult(await store.read(ctx.scope.userId, id), ctx);
        },
      },
      {
        name: 'sites.edit',
        agent: { contexts: ['sites.edit', 'skills'], maxCalls: 1 },
        description:
          'Save complete Markdown articles to an owned draft using its exact base revision. Accepts text only; deletion and publication are unavailable. Returns the site ID, new draft revision and changed paths.',
        input: versioned.extend({ changes: filesSchema }).strict(),
        output: siteEditReceiptSchema,
        execute: async ({ id, baseRevision, changes }, ctx) => {
          assertSiteAgentAccess(ctx, id, baseRevision);
          const site = await store.change(ctx.scope.userId, id, baseRevision, changes);
          recordSiteAgentRevision(ctx, site);
          return {
            id: site.id,
            draft: { revision: site.draft.revision, createdAt: site.draft.createdAt },
            changedPaths: Object.keys(changes),
          };
        },
      },
      {
        name: 'sites.change',
        description:
          'Apply explicit manual Markdown changes to a draft using its exact base revision. Null explicitly deletes an article. This operation is not exposed to composition.',
        input: versioned.extend({ changes: changesSchema }).strict(),
        execute: ({ id, baseRevision, changes }, ctx) =>
          store.change(ctx.scope.userId, id, baseRevision, changes),
      },
      {
        name: 'sites.publish',
        description: 'Publish the reviewed draft as a publicly readable blog.',
        input: versioned.strict(),
        execute: ({ id, baseRevision }, ctx) => store.publish(ctx.scope.userId, id, baseRevision),
      },
      {
        name: 'sites.rollback',
        description: 'Restore a previously published revision.',
        input: versioned.extend({ revision: revisionSchema }).strict(),
        execute: ({ id, baseRevision, revision }, ctx) =>
          store.rollback(ctx.scope.userId, id, baseRevision, revision),
      },
      {
        name: 'sites.agent.edit',
        description:
          'Ask Qingzhou to propose and save Markdown edits. Publishing remains a separate action.',
        input: versioned.extend({ instruction: z.string().trim().min(1).max(4000) }).strict(),
        execute: async ({ id, baseRevision, instruction }, ctx) => {
          const site = await readSiteAgentTarget(store, ctx, id, baseRevision);
          if (!runtime)
            throw new SiteError(
              'SITE_AGENT_UNAVAILABLE',
              'Mount the native sites composition profile',
              503,
            );
          const requestId = `site-edit:${createHash('sha256')
            .update(JSON.stringify([id, baseRevision, instruction]))
            .digest('hex')}`;
          const result = await withSiteAgentScope(
            {
              ...ctx,
              services: { ...ctx.services, ...(chat ? { sitesChat: chat } : {}) },
            },
            {
              kind: 'edit',
              site,
              revision: baseRevision,
            },
            async (invocation) =>
              runtime().invoke<{
                steps: { operation: string; result?: unknown; error?: string }[];
                summary: string;
              }>(
                'skills.autorun',
                {
                  instruction,
                  requestId,
                  resources: { siteId: id, baseRevision, site: siteDraftView(site) },
                },
                invocation,
              ),
          );
          if (!result.steps.some((step) => step.operation === 'sites.edit' && !step.error))
            throw new SiteError('SITE_AGENT_INCOMPLETE', 'The agent did not save a draft');
          return {
            site: await store.read(ctx.scope.userId, id),
            summary: result.summary.slice(0, 2000),
          };
        },
      },
    ],
  };
}
