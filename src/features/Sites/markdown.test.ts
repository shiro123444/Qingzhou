import { describe, expect, it } from 'vitest';

import { articleBody, articleMetadata, updateArticle } from './markdown';

describe('blog article editing', () => {
  it('edits the body while retaining publishing metadata and custom fields', () => {
    const content =
      '---\ntitle: Welcome\ndescription: My blog\npublishDate: 2026-10-09\ntags: [writing]\ndraft: true\ncustom: keep-me\n---\n\nOld body';
    const updated = updateArticle(content, { body: '# New body\n\n---\n\nMore words' });
    expect(articleMetadata(updated)).toMatchObject({
      title: 'Welcome',
      publishDate: '2026-10-09',
      tags: ['writing'],
      draft: true,
      custom: 'keep-me',
    });
    expect(articleBody(updated)).toBe('# New body\n\n---\n\nMore words');
  });

  it('quotes title punctuation safely without changing the body', () => {
    const updated = updateArticle(
      '---\r\ntitle: Old\r\ndescription: Test\r\npublishDate: 2026-10-09\r\ntags: []\r\n---\r\n\r\n正文',
      { title: '清舟: "写作" # 记录' },
    );
    expect(articleMetadata(updated).title).toBe('清舟: "写作" # 记录');
    expect(articleBody(updated)).toBe('正文');
  });

  it('does not silently overwrite malformed metadata', () => {
    expect(() =>
      updateArticle('---\ntitle: [broken\n---\n\nKeep my text', { body: 'New text' }),
    ).toThrow('Invalid article metadata');
  });
});
