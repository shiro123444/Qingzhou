'use client';

import { Button, Icon } from '@lobehub/ui';
import { Modal, QRCode } from 'antd';
import { CircleCheck, LogOut, QrCode, RefreshCw, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { styles } from './account.style';
import { useKugouAccount } from './useKugouAccount';

export default function KugouAccount(props: {
  onBeforeDisconnect: () => void;
  onChanged: () => void;
  userId: string | null;
}) {
  const { t } = useTranslation('music');
  const account = useKugouAccount(props);
  const connected = account.account?.state === 'connected';
  const waiting = ['waiting', 'scanned'].includes(account.phase);
  return (
    <>
      <Button
        aria-label={t('kugouAccount')}
        className={styles.entry}
        disabled={!props.userId}
        icon={UserRound}
        size="small"
        type="text"
        onClick={account.show}
      >
        {connected ? account.account?.displayName || t('kugouConnected') : t('kugouLogin')}
      </Button>
      <Modal
        destroyOnHidden
        footer={null}
        open={account.open}
        title={t('kugouAccount')}
        width={380}
        onCancel={account.close}
      >
        <div className={styles.body}>
          {connected ? (
            <>
              <span className={styles.accountIcon}>
                <Icon aria-hidden icon={CircleCheck} size={32} />
              </span>
              <h3>{account.account?.displayName || t('kugouConnected')}</h3>
              <p>{t('kugouRights')}</p>
              <Button
                icon={LogOut}
                loading={account.busy}
                onClick={() => void account.disconnect()}
              >
                {t('kugouDisconnect')}
              </Button>
            </>
          ) : (
            <>
              <div aria-label={t('kugouQr')} className={styles.qr} role="img">
                {waiting && account.challenge ? (
                  <QRCode
                    bgColor="#fff"
                    bordered={false}
                    color="#111316"
                    size={216}
                    type="svg"
                    value={account.challenge.qrUrl}
                  />
                ) : (
                  <Icon aria-hidden icon={QrCode} size={{ size: 52, strokeWidth: 1.25 }} />
                )}
              </div>
              <h3 role="status">
                {t(
                  account.phase === 'starting'
                    ? 'kugouQrLoading'
                    : account.phase === 'scanned'
                      ? 'kugouQrScanned'
                      : account.phase === 'expired'
                        ? 'kugouQrExpired'
                        : 'kugouQrScan',
                )}
              </h3>
              <p>{t('kugouQrHint')}</p>
              {!waiting && (
                <Button
                  icon={RefreshCw}
                  loading={account.phase === 'starting'}
                  onClick={() => void account.start()}
                >
                  {t('kugouQrRefresh')}
                </Button>
              )}
              {account.account?.state === 'expired' && <p>{t('kugouSessionExpired')}</p>}
            </>
          )}
          {account.phase === 'error' && (
            <p className={styles.error} role="alert">
              {t('kugouAccountError')}
            </p>
          )}
        </div>
      </Modal>
    </>
  );
}
