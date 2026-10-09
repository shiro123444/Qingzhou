import { z } from 'zod';

export const siteIdSchema = z.string().uuid();
export const revisionSchema = z.string().uuid();
export const contentPathSchema = z
  .string()
  .max(180)
  .regex(
    /^src\/content\/blog\/(?:[a-z0-9][a-z0-9_-]*\/)*[a-z0-9][a-z0-9_-]*\.md$/,
    'Use a Markdown article path under src/content/blog',
  );
export const filesSchema = z.record(contentPathSchema, z.string().max(200_000));
export const changesSchema = z.record(contentPathSchema, z.string().max(200_000).nullable());
export const siteSnapshotSchema = z.object({
  revision: revisionSchema,
  files: filesSchema,
  createdAt: z.string(),
});
export const siteSchema = z.object({
  id: siteIdSchema,
  ownerId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  author: z.string().trim().min(1).max(80),
  draft: siteSnapshotSchema,
  published: siteSnapshotSchema.optional(),
  history: z.array(siteSnapshotSchema).max(20),
});
export type Site = z.infer<typeof siteSchema>;
export type SiteSnapshot = z.infer<typeof siteSnapshotSchema>;

export class SiteError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

export const publicSite = (site: Site) => {
  if (!site.published) throw new SiteError('SITE_NOT_FOUND', 'Site is not published', 404);
  return { id: site.id, name: site.name, author: site.author, ...site.published };
};
