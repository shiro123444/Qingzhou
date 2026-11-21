import { expect, it } from 'vitest';

import { streamWords } from './StreamingReply';

it('animates actual Chinese/English prose while preserving code and link semantics', () => {
  const prose = {
    type: 'element',
    tagName: 'p',
    children: [{ type: 'text', value: '你好，世界 Hello world' }],
  };
  const code = {
    type: 'element',
    tagName: 'pre',
    children: [{ type: 'text', value: 'const a = 1;' }],
  };
  const link = {
    type: 'element',
    tagName: 'a',
    properties: { href: '/test' },
    children: [{ type: 'text', value: 'Link' }],
  };
  const tree = { type: 'root', children: [prose, code, link] };
  streamWords()(tree);
  expect(prose.children.length).toBeGreaterThan(4);
  expect(JSON.stringify(prose)).toContain('data-qz-stream-word');
  expect(code.children).toEqual([{ type: 'text', value: 'const a = 1;' }]);
  expect(link.properties.href).toBe('/test');
  expect(JSON.stringify(link)).not.toContain('data-qz-stream-word');
});
