import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import nodePath from 'node:path';

import { parse } from 'yaml';
import { z } from 'zod';

import type { Site, SiteSnapshot } from './contracts';
import {
  changesSchema,
  filesSchema,
  publicSite,
  SiteError,
  siteIdSchema,
  siteSchema,
} from './contracts';

const articleSchema = z.object({
  title: z.string().trim().min(1).max(60),
  description: z.string().max(160),
  publishDate: z.coerce.date(),
  tags: z.array(z.string()).default([]),
  draft: z.boolean().default(false),
});
const articleMetadata = (content: string) => {
  const header = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!header)
    throw new SiteError(
      'SITE_INVALID',
      'Articles require title, description and publishDate frontmatter',
    );
  try {
    return articleSchema.parse(parse(header, { maxAliasCount: 0 }));
  } catch {
    throw new SiteError('SITE_INVALID', 'Invalid Astro article frontmatter');
  }
};

/** Durable account-owned content. No uploaded source code is executed by the host. */
export class SiteStore {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly root: string) {}

  private folder(userId: string) {
    if (!userId.trim()) throw new SiteError('SITE_UNAUTHORIZED', 'Account required', 401);
    return nodePath.join(this.root, createHash('sha256').update(userId).digest('hex'));
  }

  private file(userId: string, id: string) {
    return nodePath.join(this.folder(userId), `${siteIdSchema.parse(id)}.json`);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private snapshot(files: Record<string, string>): SiteSnapshot {
    filesSchema.parse(files);
    if (Object.keys(files).length > 100 || Buffer.byteLength(JSON.stringify(files)) > 1_000_000)
      throw new SiteError('SITE_LIMIT', 'At most 100 articles and 1 MB of text per site');
    for (const content of Object.values(files)) articleMetadata(content);
    return { revision: randomUUID(), files, createdAt: new Date().toISOString() };
  }

  private async write(site: Site) {
    const file = this.file(site.ownerId, site.id);
    await mkdir(this.folder(site.ownerId), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(siteSchema.parse(site)), { mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async read(userId: string, id: string): Promise<Site> {
    try {
      const site = siteSchema.parse(JSON.parse(await readFile(this.file(userId, id), 'utf8')));
      if (site.ownerId !== userId) throw new SiteError('SITE_NOT_FOUND', 'Site not found', 404);
      return site;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new SiteError('SITE_NOT_FOUND', 'Site not found', 404);
      throw error;
    }
  }

  async list(userId: string) {
    let names: string[];
    try {
      names = await readdir(this.folder(userId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    return Promise.all(
      names
        .filter((name) => name.endsWith('.json'))
        .map((name) => this.read(userId, name.slice(0, -5))),
    );
  }

  create(userId: string, name: string, author: string) {
    return this.serialize(async () => {
      if ((await this.list(userId)).length >= 20)
        throw new SiteError('SITE_LIMIT', 'At most 20 sites per account');
      const date = new Date().toISOString().slice(0, 10);
      const site: Site = siteSchema.parse({
        id: randomUUID(),
        ownerId: userId,
        name,
        author,
        history: [],
        draft: this.snapshot({
          'src/content/blog/welcome.md': `---\ntitle: ${JSON.stringify(name)}\ndescription: "我的第一篇博客"\npublishDate: ${date}\ntags: []\n---\n\n欢迎来到我的博客。\n\n这里记录思考、学习与创造。\n`,
        }),
      });
      await this.write(site);
      return site;
    });
  }

  private assertRevision(site: Site, baseRevision: string) {
    if (site.draft.revision !== baseRevision)
      throw new SiteError(
        'SITE_CONFLICT',
        'Content changed. Pull the latest revision before retrying.',
        409,
      );
  }

  change(userId: string, id: string, baseRevision: string, raw: Record<string, string | null>) {
    return this.serialize(async () => {
      const changes = changesSchema.parse(raw);
      if (!Object.keys(changes).length) throw new SiteError('SITE_INVALID', 'No changes supplied');
      const site = await this.read(userId, id);
      this.assertRevision(site, baseRevision);
      const files = { ...site.draft.files };
      for (const [path, content] of Object.entries(changes)) {
        if (content === null) delete files[path];
        else files[path] = content;
      }
      site.draft = this.snapshot(files);
      await this.write(site);
      return site;
    });
  }

  publish(userId: string, id: string, baseRevision: string) {
    return this.serialize(async () => {
      const site = await this.read(userId, id);
      this.assertRevision(site, baseRevision);
      const files = Object.fromEntries(
        Object.entries(site.draft.files).filter(([, content]) => !articleMetadata(content).draft),
      );
      if (!Object.keys(files).length)
        throw new SiteError('SITE_INVALID', 'Add a public article before publishing');
      if (site.published?.revision === baseRevision) return site;
      if (site.published) site.history = [...site.history, site.published].slice(-20);
      site.published = { ...site.draft, files };
      await this.write(site);
      return site;
    });
  }

  rollback(userId: string, id: string, baseRevision: string, revision: string) {
    return this.serialize(async () => {
      const site = await this.read(userId, id);
      this.assertRevision(site, baseRevision);
      const previous = site.history.find((snapshot) => snapshot.revision === revision);
      if (!previous) throw new SiteError('SITE_NOT_FOUND', 'Published revision not found', 404);
      if (site.published) site.history = [...site.history, site.published].slice(-20);
      site.draft = this.snapshot(previous.files);
      site.published = site.draft;
      await this.write(site);
      return site;
    });
  }

  async readPublic(id: string) {
    siteIdSchema.parse(id);
    let accounts: string[];
    try {
      accounts = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new SiteError('SITE_NOT_FOUND', 'Site not found', 404);
      throw error;
    }
    for (const account of accounts.filter((name) => /^[a-f0-9]{64}$/.test(name))) {
      try {
        const site = siteSchema.parse(
          JSON.parse(await readFile(nodePath.join(this.root, account, `${id}.json`), 'utf8')),
        );
        return publicSite(site);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    throw new SiteError('SITE_NOT_FOUND', 'Site not found', 404);
  }
}
