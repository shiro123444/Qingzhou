import type { ConnectionMode, DmPolicy, GroupPolicy } from '@/server/services/bot/platforms';

import type { BotRuntimeStatusSnapshot } from './botRuntimeStatus';

export type ManagedChannelPlatform = 'wechat' | 'napcat' | 'qq' | 'feishu' | 'lark';

export interface ChannelProviderSummary {
  agentId: string;
  agentTitle: string | null;
  applicationId: string;
  connectionMode: ConnectionMode;
  enabled: boolean;
  id: string;
  platform: ManagedChannelPlatform;
  runtimeStatus: Omit<BotRuntimeStatusSnapshot, 'errorMessage'>;
  updatedAt: Date | string;
}

export interface ChannelAccessSettings {
  allowFrom: Array<{ id: string; name?: string }>;
  channelIdentity: { requireBinding: boolean };
  dmPolicy: DmPolicy;
  groupAllowFrom: Array<{ id: string; name?: string }>;
  groupPolicy: GroupPolicy;
}

export interface ChannelActivitySummary {
  attempts: number;
  createdAt: Date | string;
  direction: 'inbound';
  id: string;
  status: 'pending' | 'running' | 'processed' | 'unknown' | 'dead';
  updatedAt: Date | string;
}

export interface ChannelDetail {
  activity: ChannelActivitySummary[];
  provider: ChannelProviderSummary;
  settings: ChannelAccessSettings;
}
