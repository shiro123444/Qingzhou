'use client';

import {
  ActionIcon,
  Button,
  DropdownMenu,
  Flexbox,
  Icon,
  Input,
  Markdown,
  Modal,
  Segmented,
  Text,
  TextArea,
} from '@lobehub/ui';
import { cx, useResponsive } from 'antd-style';
import {
  ArrowUp,
  BookOpen,
  ExternalLink,
  History,
  MoreHorizontal,
  PanelLeft,
  Plus,
  Settings2,
  Sparkles,
  Terminal,
  Undo2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams } from 'react-router-dom';
import useSWR from 'swr';

import Link from '@/components/Link';
import NavHeader from '@/features/NavHeader';
import { NavPanelPortal } from '@/features/NavPanel';
import { QingzhouComposerOrnaments, qingzhouStyles } from '@/features/QingzhouBrand';

import SiteDialogs, { type SiteDialog } from './Dialogs';
import { articleBody, articleMetadata, articleTitle } from './markdown';
import SitesSidebar from './Sidebar';
import { styles } from './style';
import { useWorkspace } from './useWorkspace';

export function SitesWorkspace() {
  const { t } = useTranslation('home');
  const { mobile } = useResponsive();
  const w = useWorkspace();
  const [dialog, setDialog] = useState<SiteDialog>();
  const [instruction, setInstruction] = useState('');
  const hasArticle = !!w.path;
  const published = w.site?.published?.revision === w.site?.draft.revision;
  const metadata = articleMetadata(w.content);
  const sidebar = (
    <SitesSidebar
      mobile={mobile}
      workspace={w}
      onCreate={() => setDialog('create')}
      onHistory={() => setDialog('history')}
      onLocal={() => setDialog('local')}
      onNavigate={mobile ? () => setDialog(undefined) : undefined}
    />
  );

  return (
    <>
      {!mobile && <NavPanelPortal navKey="sites">{sidebar}</NavPanelPortal>}
      <main className={styles.workspace}>
        <NavHeader
          className={styles.workspaceHeader}
          height="auto"
          showTogglePanelButton={!mobile}
          left={
            <>
              {mobile && (
                <ActionIcon
                  aria-label={t('sites.articles')}
                  icon={PanelLeft}
                  title={t('sites.articles')}
                  onClick={() => setDialog('navigation')}
                />
              )}
              <Text ellipsis weight={500}>
                {w.site?.name ?? t('sites.title')}
              </Text>
            </>
          }
          right={
            hasArticle && (
              <Flexbox horizontal align="center" gap={8}>
                <Button
                  disabled={!w.dirty || w.busy}
                  size="small"
                  variant="text"
                  onClick={() => void w.save()}
                >
                  {t('sites.save')}
                </Button>
                <Button
                  disabled={w.dirty || w.busy || published}
                  size="small"
                  type="primary"
                  onClick={() => void w.publish()}
                >
                  {t('sites.publish')}
                </Button>
                <DropdownMenu
                  placement="bottomRight"
                  items={[
                    {
                      disabled: w.busy,
                      icon: <Icon icon={Settings2} />,
                      key: 'metadata',
                      label: t('sites.metadata'),
                      onClick: () => setDialog('metadata'),
                    },
                    {
                      disabled: !w.site?.published,
                      icon: <Icon icon={ExternalLink} />,
                      key: 'visit',
                      label: t('sites.visit'),
                      onClick: () =>
                        window.open(`/sites/view/${w.site?.id}`, '_blank', 'noopener,noreferrer'),
                    },
                    { type: 'divider' },
                    {
                      icon: <Icon icon={Terminal} />,
                      key: 'local',
                      label: t('sites.local'),
                      onClick: () => setDialog('local'),
                    },
                    {
                      disabled: w.busy || w.dirty || !w.site?.history.length,
                      icon: <Icon icon={History} />,
                      key: 'history',
                      label: t('sites.history'),
                      onClick: () => setDialog('history'),
                    },
                    {
                      disabled: w.busy || !w.dirty,
                      icon: <Icon icon={Undo2} />,
                      key: 'discard',
                      label: t('sites.discard'),
                      onClick: w.discard,
                    },
                  ]}
                >
                  <ActionIcon icon={MoreHorizontal} size="small" title={t('sites.more')} />
                </DropdownMenu>
              </Flexbox>
            )
          }
        >
          {hasArticle && !mobile && (
            <Flexbox align="center">
              <Segmented
                size="small"
                value={w.preview ? 'preview' : 'edit'}
                options={[
                  { label: t('sites.edit'), value: 'edit' },
                  { label: t('sites.preview'), value: 'preview' },
                ]}
                onChange={(value) => w.setPreview(value === 'preview')}
              />
            </Flexbox>
          )}
        </NavHeader>
        {mobile && hasArticle && (
          <div className={styles.mobileToolbar}>
            <Segmented
              size="small"
              value={w.preview ? 'preview' : 'edit'}
              options={[
                { label: t('sites.edit'), value: 'edit' },
                { label: t('sites.preview'), value: 'preview' },
              ]}
              onChange={(value) => w.setPreview(value === 'preview')}
            />
          </div>
        )}
        <div className={styles.scrollArea}>
          {w.failure && (
            <div className={styles.error} role="alert">
              {w.failure}
            </div>
          )}
          {hasArticle ? (
            <article className={styles.paper}>
              <div className={styles.articleMeta}>
                <span>{w.site?.author}</span>
                <span aria-hidden="true">/</span>
                <span>{String(metadata.publishDate ?? '').slice(0, 10)}</span>
                <span className={styles.state} data-dirty={w.dirty}>
                  {w.dirty
                    ? t('sites.unsaved')
                    : published && !metadata.draft
                      ? t('sites.publishedState')
                      : t('sites.draft')}
                </span>
              </div>
              {w.preview ? (
                <>
                  <h1 className={styles.articleTitle}>{metadata.title || t('sites.newArticle')}</h1>
                  <Markdown
                    allowHtml={false}
                    enableHtmlPreview={false}
                    enableMermaid={false}
                    fontSize={16}
                    headerMultiple={0.5}
                    lineHeight={1.9}
                  >
                    {articleBody(w.content)}
                  </Markdown>
                </>
              ) : (
                <>
                  <Input
                    aria-label={t('sites.articleTitle')}
                    className={styles.titleInput}
                    disabled={w.busy}
                    maxLength={60}
                    placeholder={t('sites.articleTitle')}
                    value={metadata.title ?? ''}
                    variant="borderless"
                    onChange={(event) => w.edit({ title: event.target.value })}
                  />
                  <TextArea
                    aria-label={t('sites.content')}
                    autoSize={{ minRows: 14 }}
                    className={styles.bodyInput}
                    disabled={w.busy}
                    placeholder={t('sites.write')}
                    spellCheck={false}
                    value={articleBody(w.content)}
                    variant="borderless"
                    onChange={(event) => w.edit({ body: event.target.value })}
                  />
                </>
              )}
            </article>
          ) : (
            <div className={styles.empty}>
              <Icon icon={BookOpen} size={32} />
              <h1>{w.site ? w.site.name : t('sites.title')}</h1>
              {!w.isLoading && (
                <Button
                  icon={<Icon icon={Plus} />}
                  type="primary"
                  onClick={() => (w.site ? w.newArticle() : setDialog('create'))}
                >
                  {w.site ? t('sites.newArticle') : t('sites.create')}
                </Button>
              )}
            </div>
          )}
        </div>
        {hasArticle && (
          <footer className={styles.composerDock}>
            <div className={cx(styles.composer, qingzhouStyles.composer)}>
              <QingzhouComposerOrnaments />
              <form
                data-testid="chat-input"
                onSubmit={(event) => {
                  event.preventDefault();
                  void w.agent(instruction.trim()).then((success) => {
                    if (success) setInstruction('');
                  });
                }}
              >
                <TextArea
                  aria-label={t('sites.instruction')}
                  autoSize={{ minRows: 1, maxRows: 4 }}
                  disabled={w.busy}
                  maxLength={4000}
                  placeholder={t('sites.instruction')}
                  value={instruction}
                  variant="borderless"
                  onChange={(event) => setInstruction(event.target.value)}
                />
                <div className={styles.composerActions}>
                  <Text fontSize={12} type="secondary">
                    <Icon icon={Sparkles} size={14} /> Qingzhou
                  </Text>
                  <Button
                    aria-label={t('sites.agent')}
                    disabled={!instruction.trim() || w.busy || w.dirty}
                    htmlType="submit"
                    icon={<Icon icon={ArrowUp} size={16} />}
                    size="small"
                    type="primary"
                  />
                </div>
              </form>
            </div>
            <span aria-live="polite" className={styles.status} role="status">
              {w.busy ? t('sites.working') : w.notice}
            </span>
          </footer>
        )}
      </main>
      <SiteDialogs dialog={dialog} workspace={w} onClose={() => setDialog(undefined)} />
      <Modal
        footer={null}
        open={dialog === 'navigation'}
        width={360}
        title={
          <Flexbox horizontal align="center" gap={8}>
            <Text weight={500}>{t('sites.title')}</Text>
            <ActionIcon
              aria-label={t('sites.create')}
              disabled={w.busy || w.dirty}
              icon={Plus}
              size="small"
              title={t('sites.create')}
              onClick={() => setDialog('create')}
            />
          </Flexbox>
        }
        onCancel={() => setDialog(undefined)}
      >
        <div className={styles.mobileSidebar}>{sidebar}</div>
      </Modal>
    </>
  );
}

export function PublicBlog() {
  const { siteId } = useParams();
  const { t } = useTranslation('home');
  const { data, error } = useSWR(siteId ? `/api/sites/public/${siteId}` : null, async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(t('sites.unpublished'));
    return response.json() as Promise<{
      id: string;
      name: string;
      author: string;
      files: Record<string, string>;
    }>;
  });
  useEffect(() => {
    if (data) document.title = `${data.name} · Qingzhou`;
  }, [data]);
  return (
    <main className={styles.publicPage}>
      <div className={styles.publicInner}>
        <header className={styles.publicHeader}>
          <Link href="/">Qingzhou</Link>
          <Link href="/sites">{t('sites.writeAction')}</Link>
        </header>
        {error && <p role="alert">{error.message}</p>}
        {!data && !error && <p role="status">{t('sites.working')}</p>}
        {data && (
          <>
            <header className={styles.blogTitle}>
              <h1>{data.name}</h1>
              <Text type="secondary">{data.author}</Text>
            </header>
            {Object.entries(data.files).map(([path, content]) => (
              <article className={styles.publicArticle} key={path}>
                <h2>{articleTitle(path, content)}</h2>
                <Markdown
                  allowHtml={false}
                  enableHtmlPreview={false}
                  enableMermaid={false}
                  fontSize={16}
                  headerMultiple={0.5}
                  lineHeight={1.9}
                >
                  {articleBody(content)}
                </Markdown>
              </article>
            ))}
          </>
        )}
      </div>
    </main>
  );
}
