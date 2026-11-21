import { measurePowerPointFrame, measureSlideText } from './text-measurement';

type Region = { x: number; y: number; width: number; height: number };

const inherited = (element: Element, attribute: string): string | undefined => {
  for (
    let node: Element | null = element;
    node;
    node = node.parentNode?.nodeType === 1 ? (node.parentNode as Element) : null
  )
    if (node.hasAttribute(attribute)) return node.getAttribute(attribute)!;
  return undefined;
};
// Common card layouts use translated/scaled groups and multiline tspans.
// They must participate in occupancy checks just like untransformed text.
const worldRect = (element: Element, rect: Region): Region | undefined => {
  const transforms: string[] = [];
  for (
    let node: Element | null = element;
    node;
    node = node.parentNode?.nodeType === 1 ? (node.parentNode as Element) : null
  )
    if (node.hasAttribute('transform')) transforms.unshift(node.getAttribute('transform')!);
  let sx = 1,
    sy = 1,
    tx = 0,
    ty = 0;
  for (const transform of transforms) {
    const operations = [...transform.matchAll(/([a-z]+)\s*\(([^)]*)\)/giu)];
    if (transform.replaceAll(/([a-z]+)\s*\(([^)]*)\)/giu, '').trim()) return undefined;
    for (const [, name, arguments_] of operations) {
      const values = arguments_
        .trim()
        .split(/[\s,]+/u)
        .map(Number);
      if (!values.length || !values.every(Number.isFinite)) return undefined;
      if (name === 'translate' && values.length <= 2) {
        tx += sx * values[0];
        ty += sy * (values[1] ?? 0);
      } else if (name === 'scale' && values.length <= 2) {
        sx *= values[0];
        sy *= values[1] ?? values[0];
      } else return undefined;
    }
  }
  const x1 = tx + sx * rect.x,
    x2 = tx + sx * (rect.x + rect.width);
  const y1 = ty + sy * rect.y,
    y2 = ty + sy * (rect.y + rect.height);
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
};

export function* svgTextBounds(text: Element, powerPoint = false) {
  const measure = powerPoint ? measurePowerPointFrame : measureSlideText;
  const spans = Array.from(text.getElementsByTagName('tspan')).filter(
    (span) => !span.getElementsByTagName('tspan').length,
  );
  let x = Number.parseFloat(text.getAttribute('x') ?? '0');
  let y = Number.parseFloat(text.getAttribute('y') ?? '0');
  for (const run of spans.length ? spans : [text]) {
    if (run.hasAttribute('x')) x = Number.parseFloat(run.getAttribute('x')!);
    if (run.hasAttribute('y')) y = Number.parseFloat(run.getAttribute('y')!);
    x += Number.parseFloat(run.getAttribute('dx') ?? '0');
    y += Number.parseFloat(run.getAttribute('dy') ?? '0');
    const size = Number.parseFloat(inherited(run, 'font-size') ?? '');
    if (![size, x, y].every(Number.isFinite) || !run.textContent?.trim()) continue;
    const width = measure(
      run.textContent,
      size,
      inherited(run, 'font-family') ?? 'Arial, Microsoft YaHei',
      inherited(run, 'font-weight'),
    );
    const anchor = inherited(run, 'text-anchor');
    const rect = worldRect(run, {
      x: x - (anchor === 'middle' ? width / 2 : anchor === 'end' ? width : 0),
      y: y - size * (powerPoint ? 0.85 : 0.8),
      width,
      height: size * (powerPoint ? 1.2 : 1),
    });
    x += width;
    if (!rect) continue;
    yield rect;
  }
}
