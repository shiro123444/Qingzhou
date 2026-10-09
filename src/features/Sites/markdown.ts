import { parseDocument } from 'yaml';

const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function articleBody(content: string) {
  return content.replace(frontmatter, '').replace(/^\r?\n/, '');
}

export function articleMetadata(content: string): {
  draft?: boolean;
  description?: string;
  publishDate?: string;
  tags?: string[];
  title?: string;
} {
  const match = content.match(frontmatter);
  if (!match) return {};
  try {
    return parseDocument(match[1]).toJS({ maxAliasCount: 0 }) ?? {};
  } catch {
    return {};
  }
}

export function updateArticle(
  content: string,
  changes: {
    body?: string;
    description?: string;
    publishDate?: string;
    tags?: string[];
    title?: string;
  },
) {
  const match = content.match(frontmatter);
  const document = parseDocument(match?.[1] ?? '');
  if (document.errors.length) throw new Error('Invalid article metadata');
  const { body, ...metadata } = changes;
  for (const [key, value] of Object.entries(metadata)) document.set(key, value);
  return `---\n${document.toString()}---\n\n${body ?? articleBody(content)}`;
}

export const articleTitle = (path: string, content: string) =>
  articleMetadata(content).title || path.split('/').at(-1)?.replace(/\.md$/, '') || path;
