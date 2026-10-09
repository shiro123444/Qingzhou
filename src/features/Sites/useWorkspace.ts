'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';

import type { Site } from '@/server/runtime/sites/contracts';

import { updateArticle } from './markdown';

async function invoke<T>(operation: string, input: unknown): Promise<T> {
  const response = await fetch('/api/runtime/sites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, input }),
  });
  const body = await response.json();
  if (!response.ok || !body.success)
    throw new Error(body.message ?? `Request failed (${response.status})`);
  return body.result as T;
}

export function useWorkspace() {
  const { t } = useTranslation('home');
  const {
    data: sites,
    error,
    isLoading,
    mutate,
  } = useSWR('owned-sites', () => invoke<Site[]>('sites.list', {}));
  const [selection, setSelection] = useState<{ site: Site; path: string; content: string }>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState(false);
  const site = selection?.site;
  const path = selection?.path ?? '';
  const content = selection?.content ?? '';
  const dirty = !!site && content !== (site.draft.files[path] ?? '');

  const select = useCallback((value: Site, selected = Object.keys(value.draft.files)[0] ?? '') => {
    setSelection({ site: value, path: selected, content: value.draft.files[selected] ?? '' });
    setFailure('');
    setNotice('');
  }, []);

  useEffect(() => {
    if (!site && sites?.[0]) select(sites[0]);
  }, [select, site, sites]);

  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);

  const run = async (operation: () => Promise<void>) => {
    setBusy(true);
    setFailure('');
    setNotice('');
    try {
      await operation();
      await mutate();
      return true;
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : t('sites.failed'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return {
    site,
    sites,
    path,
    content,
    busy,
    dirty,
    preview,
    setPreview,
    select,
    isLoading,
    failure: failure || error?.message,
    notice,
    create: (name: string, author: string) =>
      run(async () => select(await invoke<Site>('sites.create', { name, author }))),
    newArticle: () => {
      if (!site) return;
      setPreview(false);
      setSelection({
        site,
        path: `src/content/blog/article-${Date.now()}.md`,
        content: `---\ntitle: ${JSON.stringify(t('sites.newArticle'))}\ndescription: ""\npublishDate: ${new Date().toISOString().slice(0, 10)}\ntags: []\n---\n\n`,
      });
    },
    edit: (changes: Parameters<typeof updateArticle>[1]) => {
      setSelection((current) =>
        current ? { ...current, content: updateArticle(current.content, changes) } : current,
      );
      setNotice('');
    },
    discard: () => {
      if (site) select(site, path in site.draft.files ? path : undefined);
    },
    save: () =>
      run(async () => {
        if (!site) return;
        select(
          await invoke<Site>('sites.change', {
            id: site.id,
            baseRevision: site.draft.revision,
            changes: { [path]: content },
          }),
          path,
        );
        setNotice(t('sites.saved'));
      }),
    publish: () =>
      run(async () => {
        if (!site) return;
        select(
          await invoke<Site>('sites.publish', { id: site.id, baseRevision: site.draft.revision }),
          path,
        );
        setNotice(t('sites.published'));
      }),
    restore: (revision: string) =>
      run(async () => {
        if (!site) return;
        select(
          await invoke<Site>('sites.rollback', {
            id: site.id,
            baseRevision: site.draft.revision,
            revision,
          }),
        );
        setNotice(t('sites.restored'));
      }),
    agent: (instruction: string) =>
      run(async () => {
        if (!site) return;
        const result = await invoke<{ site: Site; summary: string }>('sites.agent.edit', {
          id: site.id,
          baseRevision: site.draft.revision,
          instruction,
        });
        select(result.site, path);
        setPreview(true);
        setNotice(t('sites.saved'));
      }),
  };
}

export type Workspace = ReturnType<typeof useWorkspace>;
