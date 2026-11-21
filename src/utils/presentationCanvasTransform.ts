import svgpath from 'svgpath';

// A uniform scale commutes with the linear part of any ancestor transform.
export function scaleInPage(node: Element, ax: number, ay: number, factor: number) {
  const ancestors: string[] = [];
  for (let p = node.parentNode as Element; p?.localName === 'g'; p = p.parentNode as Element) {
    const transform = p.getAttribute('transform');
    if (transform) ancestors.unshift(transform);
  }
  let ox = 0,
    oy = 0;
  svgpath('M0 0')
    .transform(ancestors.join(' '))
    .iterate((s) => {
      if (s[0] === 'M') [ox, oy] = [s[1], s[2]];
    });
  const wrapper = node.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'g');
  node.parentNode!.insertBefore(wrapper, node);
  wrapper.appendChild(node);
  scaleSvgGeometry(node, factor);
  translateInPage(wrapper, (1 - factor) * (ax - ox), (1 - factor) * (ay - oy));
}

/** Convert a drag in page coordinates into a translation in the object's parent group. */
export function translateInPage(node: Element, dx: number, dy: number) {
  const parents: string[] = [];
  for (
    let parent = node.parentNode as Element;
    parent?.localName === 'g';
    parent = parent.parentNode as Element
  ) {
    const transform = parent.getAttribute('transform');
    if (transform) parents.unshift(transform);
  }
  let x = dx,
    y = dy;
  if (parents.length) {
    const points: number[][] = [];
    svgpath('M0 0 L1 0 L0 1')
      .transform(parents.join(' '))
      .iterate((segment) => {
        if (segment[0] === 'M' || segment[0] === 'L') points.push([segment[1], segment[2]]);
      });
    const [[ox, oy], [xx, xy], [yx, yy]] = points;
    const a = xx - ox,
      b = xy - oy,
      c = yx - ox,
      d = yy - oy;
    const determinant = a * d - b * c;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12)
      throw Error('画布对象无法定位');
    x = (d * dx - c * dy) / determinant;
    y = (a * dy - b * dx) / determinant;
  }
  node.setAttribute(
    'transform',
    ('translate(' + x + ' ' + y + ') ' + (node.getAttribute('transform') ?? '')).trim(),
  );
}

// Bake a uniform scale into geometry so Office can keep text as text. Its native
// converter rejects scale transforms on any group containing text.
export function scaleSvgGeometry(node: Element, factor: number) {
  const number = /[-+]?(?:\d*\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/gi;
  const scaled = (value: string) => value.replace(number, (n) => String(Number(n) * factor));
  const lengths = [
    'x',
    'y',
    'x1',
    'x2',
    'y1',
    'y2',
    'dx',
    'dy',
    'cx',
    'cy',
    'width',
    'height',
    'rx',
    'ry',
    'r',
    'font-size',
    'letter-spacing',
    'textLength',
    'stroke-width',
    'stroke-dasharray',
    'stroke-dashoffset',
    'points',
  ];
  const elements = [node, ...Array.from(node.getElementsByTagName('*'))];
  for (const el of elements) {
    if (el.localName === 'text' && !el.hasAttribute('font-size')) {
      let p = el.parentNode;
      while (p?.nodeType === 1 && !(p as Element).hasAttribute('font-size')) p = p.parentNode;
      el.setAttribute(
        'font-size',
        p?.nodeType === 1 ? (p as Element).getAttribute('font-size')! : '16',
      );
    }
  }
  for (const el of elements) {
    for (const key of lengths) {
      const val = el.getAttribute(key);
      if (val && !val.includes('%') && !/(?:em|ex|rem)\b/iu.test(val))
        el.setAttribute(key, scaled(val));
    }
    if (el.hasAttribute('style'))
      el.setAttribute(
        'style',
        el
          .getAttribute('style')!
          .replace(
            /((?:font-size|letter-spacing|stroke-width)\s*:\s*)([\d.]+)(px|pt)?(?=\s*;|$)/gi,
            (_, key, value, unit) => key + Number(value) * factor + (unit ?? ''),
          ),
      );
    if (el.hasAttribute('d'))
      el.setAttribute('d', svgpath(el.getAttribute('d')!).scale(factor).toString());
    const transform = el.getAttribute('transform');
    if (transform)
      el.setAttribute(
        'transform',
        transform.replace(/(translate|rotate|matrix)\(([^)]+)\)/gi, (_, kind, args) => {
          const values = args
            .trim()
            .split(/[\s,]+/)
            .map(Number);
          return (
            kind +
            '(' +
            values
              .map((v: number, i: number) =>
                kind === 'translate' || (kind === 'rotate' && i > 0) || (kind === 'matrix' && i > 3)
                  ? v * factor
                  : v,
              )
              .join(' ') +
            ')'
          );
        }),
      );
  }
}
