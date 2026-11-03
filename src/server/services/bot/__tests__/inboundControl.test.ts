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
