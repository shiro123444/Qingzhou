'use client';

import { Flexbox } from '@lobehub/ui';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import Link from '@/components/Link';
import DailyBrief from '@/features/DailyBrief';
import { QingzhouHomeFrame } from '@/features/QingzhouBrand';
import { useUserStore } from '@/store/user';
import { authSelectors } from '@/store/user/slices/auth/selectors';

import AgentSelect from './AgentSelect';
import InputArea from './InputArea';
import WelcomeText from './WelcomeText';

const Home = memo(() => {
  const { t } = useTranslation('home');
  const isLogin = useUserStore(authSelectors.isLogin);

  return (
    <QingzhouHomeFrame>
      <Flexbox gap={40}>
        <Flexbox gap={24}>
          <Flexbox gap={8}>
            <AgentSelect />
            <WelcomeText />
          </Flexbox>
          <InputArea />
        </Flexbox>

        <Link href="/sites">{t('sites.createOwn')}</Link>
        {isLogin && (
          <Flexbox gap={40}>
            <DailyBrief />
          </Flexbox>
        )}
      </Flexbox>
    </QingzhouHomeFrame>
  );
});

export default Home;
