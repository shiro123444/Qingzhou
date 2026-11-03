'use client';

import { Button } from '@lobehub/ui';
import { Modal, Select } from 'antd';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import useSWR from 'swr';

import { agentService } from '@/services/agent';
import { useUserStore } from '@/store/user';

import { CHANNEL_PLATFORMS, configurationPath } from '../constants';

export default function CreateBot({ platform }: { platform?: string }) {
  const { t } = useTranslation('common');
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [agentId, setAgentId] = useState<string>();
  const [selectedPlatform, setSelectedPlatform] = useState(platform ?? 'wechat');
  const userId = useUserStore((state) => state.user?.id);
  useEffect(() => {
    setOpen(false);
    setAgentId(undefined);
  }, [userId]);
  const agents = useSWR(open && userId ? ['channel-workspace:agents', userId] : null, () =>
    agentService.queryAgents({ limit: 100 }),
  );
  return (
    <>
      <Button
        icon={Plus}
        type="primary"
        onClick={() => {
          setSelectedPlatform(platform ?? 'wechat');
          setOpen(true);
        }}
      >
        {t('channels.addBot')}
      </Button>
      <Modal
        cancelText={t('channels.cancel')}
        okButtonProps={{ disabled: !agentId }}
        okText={t('channels.configure')}
        open={open}
        title={t('channels.addBot')}
        onCancel={() => setOpen(false)}
        onOk={() => {
          if (agentId) navigate(configurationPath(agentId, selectedPlatform));
        }}
      >
        <label htmlFor="channel-agent">{t('channels.agent')}</label>
        <Select
          id="channel-agent"
          loading={agents.isLoading}
          placeholder={t('channels.chooseAgent')}
          style={{ marginBlock: 8, width: '100%' }}
          value={agentId}
          options={(agents.data ?? []).map((agent) => ({
            label: agent.title || t('channels.untitledAgent'),
            value: agent.id,
          }))}
          onChange={setAgentId}
        />
        {!platform && (
          <>
            <label htmlFor="channel-platform">{t('channels.platform')}</label>
            <Select
              id="channel-platform"
              style={{ marginBlockStart: 8, width: '100%' }}
              value={selectedPlatform}
              options={CHANNEL_PLATFORMS.map((value) => ({
                label: t(`channels.platforms.${value}`),
                value,
              }))}
              onChange={setSelectedPlatform}
            />
          </>
        )}
        {agents.error && <p role="alert">{t('channels.loadFailed')}</p>}
        {!agents.isLoading && agents.data?.length === 0 && (
          <Link to="/">{t('channels.createAgentFirst')}</Link>
        )}
      </Modal>
    </>
  );
}
