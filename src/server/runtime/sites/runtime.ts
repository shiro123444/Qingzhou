import nodePath from 'node:path';

import { AtomicRuntime } from '../atomic-runtime';
import { createSitesPlugin } from './plugin';
import { SiteStore } from './store';

let active: { runtime: AtomicRuntime; store: SiteStore } | undefined;
let siteStore: SiteStore | undefined;

export function getSitesStore() {
  siteStore ??= new SiteStore(
    process.env.CORDIS_SITES_DATA_DIR ?? nodePath.join(process.cwd(), '.data/sites'),
  );
  return siteStore;
}

export function getSitesRuntime() {
  if (!active) {
    const store = getSitesStore();
    active = {
      store,
      runtime: new AtomicRuntime([
        createSitesPlugin(store, undefined, [
          ...(process.env.CORDIS_DOCS_URL
            ? [{ id: 'docs' as const, name: '清舟手册', url: process.env.CORDIS_DOCS_URL }]
            : []),
          ...(process.env.CORDIS_BLOG_URL
            ? [{ id: 'blog' as const, name: '清舟博客', url: process.env.CORDIS_BLOG_URL }]
            : []),
        ]),
      ]),
    };
  }
  return active;
}
