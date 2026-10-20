import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import realPage from './__fixtures__/trial-text-overflow.json';
import { trialEditableTexts } from './trial-evaluation';
import { assertTrialCanvas, fitTrialPageText, inspectTrialTextBounds } from './trial-text-layout';

const signal = () => new AbortController().signal;
const page = (content: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 250"><rect x="20" y="20" width="360" height="210" fill="#fff"/>${content}</svg>`;

async function pixelsBeyondBodyPanel(svg: string) {
  const document = parseString(svg);
  const root = document.documentElement;
  // Expand the viewport so clipping cannot conceal the old overflow. Keep only
  // the two paragraphs; the footer intentionally lives outside this panel.
  const paragraphs = Array.from(document.getElementsByTagName('text')).filter(
    (node) =>
      (node.textContent ?? '').startsWith('在2024') ||
      (node.textContent ?? '').startsWith('万亿底座'),
  );
  for (const child of Array.from(root.childNodes)) root.removeChild(child);
  for (const paragraph of paragraphs) root.appendChild(paragraph);
  root.setAttribute('viewBox', '0 0 2000 540');
  root.setAttribute('width', '2000');
  root.setAttribute('height', '540');
  const { data, info } = await sharp(Buffer.from(document.toString()))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let painted = 0;
  for (let y = 0; y < info.height; y++)
    for (let x = 912; x < info.width; x++)
      if (data[(y * info.width + x) * info.channels + 3] > 0) painted++;
  return painted;
}

describe('lossless trial text layout', () => {
  it('repairs the exact real overflow, preserves every original textContent and leaves source bytes unchanged', () => {
    const sourceBytes = realPage.source.svg;
    expect(inspectTrialTextBounds(realPage.overflowSvg).status).toBe('failed');
    const repaired = fitTrialPageText(realPage.overflowSvg, signal());
    expect(inspectTrialTextBounds(repaired).status).toBe('passed');
    expect(trialEditableTexts(repaired)).toEqual(trialEditableTexts(realPage.source.svg));
    const raw = (svg: string) =>
      Array.from(parseString(svg).getElementsByTagName('text')).map((node) => node.textContent);
    expect(raw(repaired)).toEqual(raw(realPage.overflowSvg));
    expect(realPage.source.svg).toBe(sourceBytes);
    expect(fitTrialPageText(repaired, signal())).toBe(repaired);
  });
  it('proves with expanded real pixels that clipping does not hide text outside the panel', async () => {
    expect(await pixelsBeyondBodyPanel(realPage.overflowSvg)).toBeGreaterThan(0);
    expect(await pixelsBeyondBodyPanel(fitTrialPageText(realPage.overflowSvg, signal()))).toBe(0);
  });
  it('keeps a safe page byte-identical', () => {
    const svg = page('<text x="40" y="70" font-size="24">Safe page</text>');
    expect(fitTrialPageText(svg, signal())).toBe(svg);
  });
  it('wraps mixed Chinese, English and numbers without breaking an English word or deleting whitespace', () => {
    const text =
      '课程介绍 Experiment2026 保留所有 42 个参数并验证原始文字。继续保留内容并保证可编辑文字完整。';
    const svg = page(`<text x="40" y="65" font-size="18">${text}</text>`);
    const repaired = fitTrialPageText(svg, signal());
    expect(trialEditableTexts(repaired)).toEqual([text]);
    const rows = Array.from(parseString(repaired).getElementsByTagName('tspan')).map(
      (node) => node.textContent ?? '',
    );
    expect(rows.join('')).toBe(text);
    expect(rows.some((row) => row.includes('Experiment2026'))).toBe(true);
    expect(inspectTrialTextBounds(repaired).status).toBe('passed');
  });
  it('rejects vertical overflow instead of shrinking, truncating, or overlapping the next heading', () => {
    const svg = page(
      `<text x="40" y="65" font-size="24">${'必须逐字保留内容'.repeat(12)}</text><text x="40" y="100" font-size="24">下一段</text>`,
    );
    expect(() => fitTrialPageText(svg, signal())).toThrow('TRIAL_TEXT_NO_FIT');
  });
  it('rejects bottom overflow and detects overlapping text blocks', () => {
    expect(() =>
      fitTrialPageText(page('<text x="40" y="250" font-size="24">Bottom</text>'), signal()),
    ).toThrow('TRIAL_TEXT_NO_FIT');
    expect(
      inspectTrialTextBounds(
        page(
          '<text x="40" y="60" font-size="24">First</text><text x="40" y="65" font-size="24">Second</text>',
        ),
      ).status,
    ).toBe('failed');
  });
  it('keeps bullet boundaries and the exact source string', () => {
    const svg = page(
      '<text x="40" y="60" font-size="18"><tspan x="40" dy="0">· 第一项包含多种信息，需要换行但不能改字。</tspan><tspan x="40" dy="80">· 第二项继续保持独立的项目符号与内容。</tspan></text>',
    );
    const fixed = fitTrialPageText(svg, signal());
    expect(trialEditableTexts(fixed)).toEqual(trialEditableTexts(svg));
    expect(inspectTrialTextBounds(fixed).status).toBe('passed');
  });
  it('measures anchored text and inherited styles, not only direct start-aligned attributes', () => {
    const safe = page(
      '<g style="font-size:20px;font-family:Arial"><text x="350" y="70" text-anchor="end">Right aligned</text></g>',
    );
    expect(inspectTrialTextBounds(safe).status).toBe('passed');
    expect(inspectTrialTextBounds(safe.replace('x="350"', 'x="80"')).status).toBe('failed');
    expect(
      inspectTrialTextBounds(safe.replace('text-anchor="end"', 'text-anchor="middle"')).status,
    ).toBe('failed');
  });
  it.each([
    'transform="rotate(5)"',
    'textLength="100"',
    'clip-path="url(#hidden)"',
    'direction="rtl"',
  ])('does not certify unsupported geometry %s', (attribute) => {
    const svg = page(`<text x="40" y="60" font-size="24" ${attribute}>Data</text>`);
    expect(inspectTrialTextBounds(svg).status).toBe('unknown');
    expect(() => fitTrialPageText(svg, signal())).toThrow('TRIAL_TEXT_LAYOUT_UNSUPPORTED');
  });
  it('does not silently certify a vertical or clipped child tspan', () => {
    const svg = page(
      '<text x="40" y="60" font-size="24"><tspan writing-mode="vertical-rl">Data</tspan></text>',
    );
    expect(inspectTrialTextBounds(svg).status).toBe('unknown');
  });
  it('rejects a changed canvas, including viewport aspect changes', () => {
    const svg = page('<text x="40" y="70" font-size="24">Data</text>');
    expect(() => assertTrialCanvas(svg, svg.replace('400 250', '500 250'))).toThrow(
      'TRIAL_CANVAS_MISMATCH',
    );
    expect(() =>
      assertTrialCanvas(svg, svg.replace('<svg ', '<svg width="400" height="500" ')),
    ).toThrow('TRIAL_CANVAS_MISMATCH');
  });
  it('honors cancellation before measuring and bounds synchronous work', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => fitTrialPageText(realPage.overflowSvg, controller.signal)).toThrow(
      'TRIAL_CANCELLED',
    );
    expect(() =>
      fitTrialPageText(page('<text x="40" y="60">' + 'x'.repeat(20001) + '</text>'), signal()),
    ).toThrow('TRIAL_TEXT_LAYOUT_LIMIT');
  });
});
