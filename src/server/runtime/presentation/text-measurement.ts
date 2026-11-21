import { createCanvas } from '@napi-rs/canvas';

/** These runs form a single typographic unit in a heading, paragraph or table cell. */
export const slideTextTokens = (text: string): string[] =>
  text.match(/—{2,}|…{2,}|\d{1,2}:\d{2}|[\w.%+/-]+|\n|./gu) ?? [];

const context = createCanvas(1, 1).getContext('2d');

/** Measure mixed CJK/Latin text, including mathematical Unicode, before clipping it. */
export function measureSlideText(
  text: string,
  size: number,
  family = 'Arial, Microsoft YaHei',
  weight = 'normal',
) {
  context.font = `${weight} ${size}px ${family}`;
  // Some CI hosts lack CJK fonts. Missing-glyph metrics must not weaken clipping checks.
  const minimum =
    [...text].reduce(
      (sum, c) => sum + (/[\p{Script=Han}\u3000-\u303F\uFF00-\uFFEF]/u.test(c) ? 1 : 0.25),
      0,
    ) * size;
  return Math.max(minimum, context.measureText(text).width);
}

/** A PowerPoint single-line text frame is wider than the visible glyphs.
 * PPT Master's DrawingML export reserves separate CJK and Latin headroom;
 * otherwise a cover can fit on the canvas but overflow its editable module. */
export function measurePowerPointFrame(
  text: string,
  size: number,
  family: string,
  weight = 'normal',
) {
  const faces = family.split(',').map((face) => face.trim().replaceAll(/['"]/gu, ''));
  const eastAsian =
    /cjk|songti|simsun|simhei|yahei|fangsong|kaiti|hiragino|gothic|mingliu|pingfang|meiryo|[\p{Script=Han}]/iu;
  const latinFace = faces.find((face) => !eastAsian.test(face)) ?? faces[0];
  const eastAsianFace = faces.find((face) => eastAsian.test(face)) ?? latinFace;
  const segments = text.split(
    /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF00-\uFFEF]+)/gu,
  );
  return segments.reduce((width, run, index) => {
    if (!run) return width;
    const face = index % 2 === 1 ? eastAsianFace : latinFace;
    const serif =
      !/sans/iu.test(face) &&
      /serif|songti|simsun|fangsong|kaiti|mingliu|mincho|georgia|cambria|garamond|times|palatino|book antiqua/iu.test(
        face,
      );
    const base = serif ? 1.12 : 1.06;
    const cap = serif ? 1.36 : 1.12;
    const cased = run.match(/[\p{Lu}\p{Ll}\p{Lt}]/gu)?.length ?? 0;
    const caps = run.match(/\p{Lu}/gu)?.length ?? 0;
    const headroom = base + (cased ? ((cap - base) * caps) / cased : 0);
    return width + measureSlideText(run, size, family, weight) * headroom;
  }, 0);
}
