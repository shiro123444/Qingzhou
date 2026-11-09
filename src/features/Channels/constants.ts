import { Activity, LayoutDashboard, MessageCircle, Radio, ShieldCheck } from 'lucide-react';

export const CHANNEL_PLATFORMS = ['wechat', 'qq', 'feishu'] as const;
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];
export const CHANNEL_SECTIONS = ['overview', 'access', 'activity'] as const;
export type ChannelSection = (typeof CHANNEL_SECTIONS)[number];
export const SECTION_ICONS = { access: ShieldCheck, activity: Activity, overview: LayoutDashboard };
export const PLATFORM_ICONS = { feishu: Radio, qq: MessageCircle, wechat: MessageCircle };

export const isChannelPlatform = (value?: string): value is ChannelPlatform =>
  (CHANNEL_PLATFORMS as readonly string[]).includes(value ?? '');

export const matchesPlatform = (actual: string, selected: string) =>
  actual === selected ||
  (selected === 'qq' && actual === 'napcat') ||
  (selected === 'feishu' && actual === 'lark');

export const channelPath = (platform: string, providerId: string, section = 'overview') =>
  `/channels/${platform === 'lark' ? 'feishu' : platform === 'napcat' ? 'qq' : platform}/${encodeURIComponent(providerId)}/${section}`;

export const configurationPath = (agentId: string, platform: string) =>
  `/agent/${encodeURIComponent(agentId)}/channel?platform=${encodeURIComponent(platform)}`;
