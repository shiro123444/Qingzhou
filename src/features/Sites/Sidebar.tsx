'use client';

import {
  ActionIcon,
  Button,
  DropdownMenu,
  Flexbox,
  Icon,
  Input,
  Skeleton,
  Text,
} from '@lobehub/ui';
import { ChevronDown, FileText, History, NotebookPen, Plus, Search, Terminal } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import NavItem from '@/features/NavPanel/components/NavItem';
import SideBarHeaderLayout from '@/features/NavPanel/SideBarHeaderLayout';
import SideBarLayout from '@/features/NavPanel/SideBarLayout';

import { articleTitle } from './markdown';
import { styles } from './style';
import type { Workspace } from './useWorkspace';

interface SidebarProps {
  mobile?: boolean;
  onCreate: () => void;
  onHistory: () => void;
  onLocal: () => void;
  onNavigate?: () => void;
  workspace: Workspace;
}

export default function SitesSidebar({
  workspace: w,
  onCreate,
  onHistory,
  onLocal,
  onNavigate,
  mobile,
}: SidebarProps) {
  const { t } = useTranslation('home');
  const [search, setSearch] = useState('');
  const files = Object.entries(w.site?.draft.files ?? {}).filter(([path, content]) =>
    articleTitle(path, content).toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  return (
    <div className={styles.sidebar}>
      <SideBarLayout
        body={
          <Flexbox gap={4} paddingInline={8}>
            <Flexbox horizontal align="center" justify="space-between" padding={'8px 4px'}>
              <Text fontSize={12} type="secondary">
                {t('sites.articles')} · {Object.keys(w.site?.draft.files ?? {}).length}
              </Text>
              <ActionIcon
                aria-label={t('sites.newArticle')}
                disabled={!w.site || w.busy || w.dirty}
                icon={Plus}
                size="small"
                title={t('sites.newArticle')}
                onClick={() => {
                  w.newArticle();
                  onNavigate?.();
                }}
              />
            </Flexbox>
            {w.isLoading ? (
              <Skeleton active paragraph={{ rows: 3 }} />
            ) : (
              files.map(([path, content]) => (
                <NavItem
                  active={w.path === path}
                  aria-disabled={w.busy || w.dirty}
                  aria-pressed={w.path === path}
                  as="button"
                  className={styles.navItem}
                  disabled={w.busy || w.dirty}
                  icon={FileText}
                  key={path}
                  title={articleTitle(path, content)}
                  onClick={() => {
                    if (w.site) w.select(w.site, path);
                    onNavigate?.();
                  }}
                />
              ))
            )}
            {w.site && !(w.path in w.site.draft.files) && (
              <NavItem active icon={FileText} title={t('sites.newArticle')} />
            )}
          </Flexbox>
        }
        header={
          <>
            {!mobile && (
              <SideBarHeaderLayout
                left={t('sites.title')}
                showBack={!mobile}
                showTogglePanelButton={!mobile}
                right={
                  <ActionIcon
                    aria-label={t('sites.create')}
                    disabled={w.busy || w.dirty}
                    icon={Plus}
                    title={t('sites.create')}
                    onClick={onCreate}
                  />
                }
              />
            )}
            {w.site && (
              <div className={styles.siteSwitcher}>
                <DropdownMenu
                  items={
                    w.sites?.map((site) => ({
                      disabled: w.busy || w.dirty,
                      icon: <Icon icon={NotebookPen} />,
                      key: site.id,
                      label: site.name,
                      onClick: () => {
                        w.select(site);
                        setSearch('');
                        onNavigate?.();
                      },
                    })) ?? []
                  }
                >
                  <Button block disabled={w.busy || w.dirty} variant="text">
                    <Icon icon={NotebookPen} size={18} />
                    <Text ellipsis style={{ flex: 1, textAlign: 'start' }} weight={500}>
                      {w.site.name}
                    </Text>
                    <Icon icon={ChevronDown} size={14} />
                  </Button>
                </DropdownMenu>
              </div>
            )}
            <div className={styles.search}>
              <Input
                allowClear
                aria-label={t('sites.search')}
                placeholder={t('sites.search')}
                prefix={<Icon icon={Search} size={16} />}
                size="small"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </>
        }
      />
      {w.site && (
        <div className={styles.sidebarFooter}>
          <NavItem
            as="button"
            className={styles.navItem}
            icon={Terminal}
            title={t('sites.local')}
            onClick={onLocal}
          />
          <NavItem
            aria-disabled={!w.site.history.length || w.busy || w.dirty}
            as="button"
            className={styles.navItem}
            disabled={!w.site.history.length || w.busy || w.dirty}
            icon={History}
            title={t('sites.history')}
            onClick={onHistory}
          />
        </div>
      )}
    </div>
  );
}
