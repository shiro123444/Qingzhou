// @vitest-environment node
import { expect, it, vi } from 'vitest';

const { evaluated, factory } = vi.hoisted(() => {
  const evaluated: string[] = [];
  return {
    evaluated,
    factory: (id: string) => {
      evaluated.push(id);
      return class {
        createClient() {
          return { id };
        }
        async validateCredentials() {
          return { valid: true };
        }
        async validateSettings() {
          return { valid: true };
        }
      };
    },
  };
});

// Module-evaluation sentinels catch eager imports before any factory method is called.
vi.mock('./discord/client', () => ({ DiscordClientFactory: factory('discord') }));
vi.mock('./telegram/client', () => ({ TelegramClientFactory: factory('telegram') }));
vi.mock('./slack/client', () => ({ SlackClientFactory: factory('slack') }));
vi.mock('./feishu/client', () => ({ FeishuClientFactory: factory('feishu') }));
vi.mock('./qq/client', () => ({ QQClientFactory: factory('qq') }));
vi.mock('./napcat/client', () => ({ NapCatClientFactory: factory('napcat') }));
vi.mock('./wechat/client', () => ({ WechatClientFactory: factory('wechat') }));
vi.mock('./line/client', () => ({ LineClientFactory: factory('line') }));

it('keeps the full catalog cold and imports only requested platforms, sharing Feishu/Lark code', async () => {
  const { platformRegistry } = await import('./index');
  const catalog = platformRegistry.listSerializedPlatforms();
  expect(catalog.map((entry) => entry.id).sort()).toEqual([
    'discord',
    'feishu',
    'lark',
    'line',
    'napcat',
    'qq',
    'slack',
    'telegram',
    'wechat',
  ]);
  expect(catalog.every((entry) => entry.schema.length > 0 && !('clientFactory' in entry))).toBe(
    true,
  );
  expect(evaluated).toEqual([]);

  const config = { applicationId: 'app', credentials: {}, platform: 'napcat', settings: {} };
  await platformRegistry.createClient('napcat', config);
  expect(evaluated).toEqual(['napcat']);
  await platformRegistry.validateCredentials('wechat', {});
  expect(evaluated).toEqual(['napcat', 'wechat']);
  await Promise.all([
    platformRegistry.validateCredentials('feishu', {}),
    platformRegistry.validateCredentials('lark', {}),
  ]);
  expect(evaluated).toEqual(['napcat', 'wechat', 'feishu']);
});
