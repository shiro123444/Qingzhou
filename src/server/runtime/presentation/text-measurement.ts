import { createCanvas } from '@napi-rs/canvas';

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
