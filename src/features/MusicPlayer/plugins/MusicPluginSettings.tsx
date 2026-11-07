'use client';

import { Button, Icon } from '@lobehub/ui';
import { Switch } from 'antd';
import { BookOpen, MousePointer2, TextQuote } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useMusicPlugins, useMusicPluginState } from './context';
import { styles } from './ui.style';

const statusLabels = {
  active: 'pluginEnabled',
  disabled: 'pluginDisabled',
  error: 'pluginFailed',
  loading: 'pluginLoading',
} as const;

export default function MusicPluginSettings() {
  const { t } = useTranslation('music');
  const host = useMusicPlugins();
  const enabled = useMusicPluginState((state) => state.enabled);
  const status = useMusicPluginState((state) => state.status);
  const userId = useMusicPluginState((state) => state.userId);
  const storageWarning = useMusicPluginState((state) => state.storageWarning);

  return (
    <div className={styles.settings}>
      <h2 className={styles.heading}>{t('plugins')}</h2>
      <article aria-label={t('lyricsPlugin')} className={styles.plugin} data-qz-glass="panel">
        <div className={styles.pluginOverview}>
          <span aria-hidden className={styles.pluginIcon}>
            <Icon icon={TextQuote} size={{ size: 22, strokeWidth: 1.75 }} />
          </span>
          <div className={styles.pluginInfo}>
            <div className={styles.pluginTitle}>
              <h3>{t('lyricsPlugin')}</h3>
              <span>{t('pluginBuiltIn')}</span>
            </div>
            <p>{t('lyricsPluginDescription')}</p>
          </div>
          <div className={styles.pluginControls}>
            <span
              aria-live="polite"
              className={styles.pluginStatus}
              data-status={status === 'active' ? 'enabled' : status}
              role="status"
            >
              {t(statusLabels[status])}
            </span>
            <Switch
              aria-label={t('lyricsPlugin')}
              checked={enabled}
              disabled={!userId || status === 'loading'}
              loading={status === 'loading'}
              title={t(enabled ? 'disableLyricsPlugin' : 'enableLyricsPlugin')}
              onChange={(checked) => void host.setEnabled('lyrics', checked)}
            />
          </div>
        </div>
        <div className={styles.permissions}>
          <h4>{t('pluginPermissions')}</h4>
          <ul className={styles.permissionList}>
            <li>
              <Icon aria-hidden icon={BookOpen} size={{ size: 16, strokeWidth: 1.75 }} />
              {t('lyricsPluginReadPermission')}
            </li>
            <li>
              <Icon aria-hidden icon={MousePointer2} size={{ size: 16, strokeWidth: 1.75 }} />
              {t('lyricsPluginSeekPermission')}
            </li>
          </ul>
        </div>
        {status === 'error' && (
          <div className={styles.pluginError} role="alert">
            <span>{t('lyricsPluginFailedHint')}</span>
            <Button disabled={!userId} size="small" onClick={() => void host.retry('lyrics')}>
              {t('retry')}
            </Button>
          </div>
        )}
        {storageWarning && (
          <p className={styles.pluginWarning} role="status">
            {t('pluginStorageWarning')}
          </p>
        )}
      </article>
    </div>
  );
}
