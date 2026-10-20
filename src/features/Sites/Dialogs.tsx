'use client';

import { Button, CopyButton, Flexbox, Input, Modal, Text, TextArea } from '@lobehub/ui';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { articleMetadata } from './markdown';
import { styles } from './style';
import type { Workspace } from './useWorkspace';

export type SiteDialog = 'create' | 'history' | 'local' | 'metadata' | 'navigation' | undefined;

export default function SiteDialogs({
  dialog,
  onClose,
  workspace: w,
}: {
  dialog: SiteDialog;
  onClose: () => void;
  workspace: Workspace;
}) {
  const { t } = useTranslation('home');
  const [name, setName] = useState('');
  const [author, setAuthor] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState('');
  const [tags, setTags] = useState('');
  useEffect(() => {
    if (dialog !== 'metadata') return;
    const metadata = articleMetadata(w.content);
    setDescription(metadata.description ?? '');
    setDate(String(metadata.publishDate ?? '').slice(0, 10));
    setTags(metadata.tags?.join(', ') ?? '');
  }, [dialog, w.content]);
  const checkout = `node scripts/qingzhou-blog.mjs checkout ${w.site?.id} ../my-blog`;
  return (
    <>
      <Modal
        footer={null}
        open={dialog === 'create'}
        title={t('sites.create')}
        width={400}
        onCancel={w.busy ? undefined : onClose}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void w.create(name.trim(), author.trim()).then((success) => {
              if (success) {
                setName('');
                setAuthor('');
                onClose();
              }
            });
          }}
        >
          <Flexbox gap={20}>
            <label className={styles.field}>
              {t('sites.name')}
              <Input
                autoFocus
                required
                maxLength={60}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className={styles.field}>
              {t('sites.author')}
              <Input
                required
                maxLength={80}
                value={author}
                onChange={(event) => setAuthor(event.target.value)}
              />
            </label>
            {w.failure && (
              <Text role="alert" type="danger">
                {w.failure}
              </Text>
            )}
            <Button
              block
              disabled={!name.trim() || !author.trim()}
              htmlType="submit"
              loading={w.busy}
              type="primary"
            >
              {t('sites.create')}
            </Button>
          </Flexbox>
        </form>
      </Modal>
      <Modal
        footer={null}
        open={dialog === 'local'}
        title={t('sites.local')}
        width={560}
        onCancel={onClose}
      >
        <div className={styles.command}>
          <code>{checkout}</code>
          <CopyButton content={checkout} />
        </div>
      </Modal>
      <Modal
        footer={null}
        open={dialog === 'history'}
        title={t('sites.history')}
        width={480}
        onCancel={w.busy ? undefined : onClose}
      >
        <Flexbox gap={8}>
          {w.site?.history.toReversed().map((version) => (
            <div className={styles.historyRow} key={version.revision}>
              <Text>{new Date(version.createdAt).toLocaleString()}</Text>
              <Button
                disabled={w.dirty}
                loading={w.busy}
                size="small"
                onClick={() =>
                  void w.restore(version.revision).then((success) => {
                    if (success) onClose();
                  })
                }
              >
                {t('sites.restore')}
              </Button>
            </div>
          ))}
        </Flexbox>
        {w.failure && (
          <Text role="alert" type="danger">
            {w.failure}
          </Text>
        )}
      </Modal>
      <Modal
        footer={null}
        open={dialog === 'metadata'}
        title={t('sites.metadata')}
        width={440}
        onCancel={onClose}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            w.edit({
              description,
              publishDate: date,
              tags: tags
                .split(',')
                .map((tag) => tag.trim())
                .filter(Boolean),
            });
            onClose();
          }}
        >
          <Flexbox gap={20}>
            <label className={styles.field}>
              {t('sites.description')}
              <TextArea
                maxLength={160}
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </label>
            <label className={styles.field}>
              {t('sites.date')}
              <Input
                required
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
            <label className={styles.field}>
              {t('sites.tags')}
              <Input value={tags} onChange={(event) => setTags(event.target.value)} />
            </label>
            <Button block htmlType="submit" type="primary">
              {t('sites.done')}
            </Button>
          </Flexbox>
        </form>
      </Modal>
    </>
  );
}
