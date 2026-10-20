import nodePath from 'node:path';

import type { PluginBundle, PluginProfile } from '@lobechat/cordis-runtime';

import {
  type AtomicPlugin,
  type AtomicRuntime,
  createAtomicRuntimeFromProfile,
} from '../atomic-runtime';
import type { MultimodalChatPort } from '../presentation/multimodal-chat-provider';
import type { SkillsPluginOptions } from '../skills-plugin';
import { createSiteSkillsPlugin } from './composition';
import { SiteError } from './contracts';
import { createSitesPlugin } from './plugin';
import type { SiteSource } from './sources';
import { SiteStore } from './store';

export interface SitesRuntimeOptions {
  bundles?: Readonly<Record<string, PluginBundle>>;
  /** Trusted modules are mounted only when selected by the profile. */
  plugins?: Readonly<Record<string, AtomicPlugin>>;
  profile?: PluginProfile;
  skills?: SkillsPluginOptions;
  sources?: SiteSource[];
  store: SiteStore;
}

export const DEFAULT_SITES_PROFILE: PluginProfile = { bundles: ['sites'] };
export const SITES_RUNTIME_BUNDLES: Readonly<Record<string, PluginBundle>> = {
  sites: {
    entries: [
      { id: 'sites', use: 'sites' },
      { id: 'skills', use: 'skills' },
    ],
  },
};

export function createSitesRuntime(options: SitesRuntimeOptions) {
  if (
    Object.hasOwn(options.plugins ?? {}, 'sites') ||
    Object.hasOwn(options.plugins ?? {}, 'skills')
  )
    throw new SiteError(
      'SITE_PROFILE_INVALID',
      'Use a named replacement module in profile patches',
    );
  // Factories only register lazy callbacks. AtomicRuntime mounts on its pending
  // promise, after this assignment, so every nested invocation uses this host.
  const modules: Record<string, AtomicPlugin> = {
    ...options.plugins,
    sites: createSitesPlugin(options.store, undefined, options.sources, () => runtime),
    skills: createSiteSkillsPlugin(() => runtime, options.store, options.skills),
  };
  const runtime: AtomicRuntime = createAtomicRuntimeFromProfile({
    bundles: { ...SITES_RUNTIME_BUNDLES, ...options.bundles },
    modules,
    profile: options.profile ?? DEFAULT_SITES_PROFILE,
  });
  return { runtime, store: options.store };
}

let active: Promise<ReturnType<typeof createSitesRuntime>> | undefined;
let siteStore: SiteStore | undefined;

export function getSitesStore() {
  siteStore ??= new SiteStore(
    process.env.CORDIS_SITES_DATA_DIR ?? nodePath.join(process.cwd(), '.data/sites'),
  );
  return siteStore;
}

/** Trusted deployment profile; optional domains are imported only when selected. */
export async function createProductionSitesRuntime(
  options: Pick<SitesRuntimeOptions, 'store' | 'sources'>,
  profile = process.env.QINGZHOU_SITES_PROFILE ?? 'sites',
) {
  if (profile !== 'sites' && profile !== 'education')
    throw new SiteError('SITE_PROFILE_INVALID', 'Choose sites or education');
  if (profile === 'sites') return createSitesRuntime(options);
  const [{ createTeachingPlugin }, { createContentPlugin }] = await Promise.all([
    import('../teaching/atomic-plugin'),
    import('../content/atomic-plugin'),
  ]);
  return createSitesRuntime({
    ...options,
    plugins: {
      teaching: createTeachingPlugin({
        chat: (ctx) => {
          const provider = ctx.services?.sitesChat as MultimodalChatPort | undefined;
          if (
            !provider?.providerId ||
            typeof provider.chat !== 'function' ||
            !provider.manifest?.model
          )
            throw new SiteError(
              'SITE_AGENT_UNAVAILABLE',
              'Select an enabled model in Qingzhou first',
              503,
            );
          return provider;
        },
      }),
      content: createContentPlugin(),
    },
    profile: {
      bundles: ['sites'],
      patches: [
        { op: 'add', entry: { id: 'teaching', use: 'teaching' } },
        { op: 'add', entry: { id: 'content', use: 'content' } },
      ],
    },
    skills: {
      recipes: [
        { id: 'edit-site-draft', steps: ['sites.read', 'sites.edit'] },
        {
          id: 'lesson-to-article',
          description:
            'Compile public lesson stages, format a Markdown draft and save it to an owned site. Publication remains a separate explicit action.',
          steps: ['teaching.lesson.compile', 'content.lesson.markdown', 'sites.edit'],
        },
      ],
    },
  });
}

export function getSitesRuntime() {
  if (active) return active;
  const initialization = createProductionSitesRuntime({
    store: getSitesStore(),
    sources: [
      ...(process.env.CORDIS_DOCS_URL
        ? [{ id: 'docs' as const, name: '清舟手册', url: process.env.CORDIS_DOCS_URL }]
        : []),
      ...(process.env.CORDIS_BLOG_URL
        ? [{ id: 'blog' as const, name: '清舟博客', url: process.env.CORDIS_BLOG_URL }]
        : []),
    ],
  });
  active = initialization;
  // A failed initialization must not poison the process or clear a newer host.
  void initialization.catch(() => {
    if (active === initialization) active = undefined;
  });
  return initialization;
}
