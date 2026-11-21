import type { DeckVisualSystem } from './deck-visual-system';
import { escapeSvgText } from './semantic-blocks';
import { measureSlideText, slideTextTokens } from './text-measurement';

/** Wrap native text at its actual font size; never reduce typography to hide overflow. */
export function learnedTextLines(
  text: string,
  width: number,
  size: number,
  font: string,
  bold = false,
  measure: (
    text: string,
    size: number,
    family: string,
    weight: string,
  ) => number = measureSlideText,
) {
  const lines: string[] = [];
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
  for (const paragraph of text.split('\n')) {
    const parts = slideTextTokens(paragraph);
    const boundaries = new Set([...segmenter.segment(paragraph)].map((part) => part.index));
    boundaries.add(paragraph.length);
    const offsets = [0];
    for (const part of parts) offsets.push(offsets.at(-1)! + part.length);
    const costs = Array.from({ length: parts.length + 1 }, () => Infinity);
    const next = Array.from({ length: parts.length }, () => 0);
    costs[parts.length] = 0;
    for (let i = parts.length - 1; i >= 0; i--) {
      let line = '';
      for (let j = i; j < parts.length; j++) {
        line += parts[j];
        const used = measure(line, size, font, bold ? 'bold' : 'normal');
        if (used > width + 0.01) break;
        const last = j === parts.length - 1;
        const punctuation =
          /^[，。！？；：、）》】」』]/u.test(parts[i]) || /[（《【「『]$/u.test(parts[j]);
        const cost =
          100 +
          (punctuation ? 4000 : 0) +
          (last && i > 0 && [...line.trim()].length < 3 ? 2000 : 0) +
          (!last && !boundaries.has(offsets[j + 1]) ? 24 : 0) +
          ((width - used) / width) ** 2 * 12 +
          costs[j + 1];
        if (cost < costs[i]) {
          costs[i] = cost;
          next[i] = j + 1;
        }
      }
    }
    if (!parts.length) lines.push('');
    for (let i = 0; i < parts.length; i = next[i]) {
      if (!next[i]) throw new Error('Text token exceeds the source slot width');
      lines.push(parts.slice(i, next[i]).join(''));
    }
  }
  return lines;
}

export const learnedFooter = (system: DeckVisualSystem, page?: number, total?: number) =>
  page && total && page <= total
    ? `<text id="learned-page-number" x="${Math.round(system.width * 0.95)}" y="${system.height - 16}" text-anchor="end" font-size="16" fill="${system.colors.muted}">${page} / ${total}</text>`
    : '';

/** Identify chrome by page context, never by a fraction embedded in approved body facts. */
export function isLearnedFooter(
  text: { text: string; y: number; size: number },
  height: number,
  page?: number,
  total?: number,
  deckTitle?: string,
) {
  if (text.y <= height * 0.9 || text.size > 18) return false;
  if (deckTitle && text.text === deckTitle) return true;
  if (!page || !total) return false;
  const fraction = text.text.match(/(?:^|[\s·•])0*(\d{1,3})\s*\/\s*0*(\d{1,3})$/u);
  if (fraction) return Number(fraction[1]) === page && Number(fraction[2]) === total;
  const number = text.text.match(/(?:^|[\s·•])0*(\d{1,3})$/u);
  return !!number && Number(number[1]) === page;
}

export function learnedTextSvg(
  lines: string[],
  x: number,
  y: number,
  size: number,
  color: string,
  bold = false,
) {
  return lines
    .map(
      (line, i) =>
        `<text x="${x}" y="${y + size + i * size * 1.35}" font-size="${size}" font-weight="${bold ? 'bold' : 'normal'}" fill="${color}">${escapeSvgText(line)}</text>`,
    )
    .join('');
}
