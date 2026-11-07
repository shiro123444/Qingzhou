import { describe, expect, it } from 'vitest';

import { isInboundStopCommand } from '../inboundControl';

describe('Feishu/Lark durable control dispatch', () => {
  it.each(['feishu', 'lark'])(
    'lets normalized %s card decisions bypass blocked conversation work',
    (platform) => {
      expect(
        isInboundStopCommand(platform, {
          event: { message: { content: JSON.stringify({ text: '/confirm a123456789bc' }) } },
        }),
      ).toBe(true);
      expect(
        isInboundStopCommand(platform, {
          event: { message: { content: JSON.stringify({ text: '/reject a123456789bc' }) } },
        }),
      ).toBe(true);
      expect(isInboundStopCommand(platform, { event: { message: { content: '{bad json' } } })).toBe(
        false,
      );
    },
  );
});

it('routes result retrieval while another operation holds the conversation', () => {
  expect(isInboundStopCommand('wechat', { item_list: [{ text_item: { text: '/result' } }] })).toBe(
    true,
  );
  expect(isInboundStopCommand('qq', { d: { content: '/result task-id' } })).toBe(true);
  expect(
    isInboundStopCommand('feishu', {
      event: { message: { content: JSON.stringify({ text: '/result' }) } },
    }),
  ).toBe(true);
});

it('allows help while a model task holds the conversation', () => {
  expect(isInboundStopCommand('wechat', { item_list: [{ text_item: { text: '/help' } }] })).toBe(
    true,
  );
});
