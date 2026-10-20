'use client';

import { memo } from 'react';

import SideBarHeaderLayout from '@/features/NavPanel/SideBarHeaderLayout';
import { qingzhouStyles, QingzhouWordmark } from '@/features/QingzhouBrand';

import InboxButton from './components/InboxButton';
import Nav from './components/Nav';
import User from './components/User';

const Header = memo(() => {
  return (
    <>
      <div className={qingzhouStyles.sidebarBrand}>
        <QingzhouWordmark compact />
        <span aria-hidden="true">QING ZHOU</span>
      </div>
      <SideBarHeaderLayout left={<User />} right={<InboxButton />} showBack={false} />
      <Nav />
    </>
  );
});

export default Header;
