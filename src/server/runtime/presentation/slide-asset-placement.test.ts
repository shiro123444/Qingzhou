import { describe, expect, it } from 'vitest';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import { composePresentationAssets } from './slide-asset-placement';

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><rect width="960" height="540" fill="white"/><g transform="translate(100,20)"><text x="0" y="40">Editable title</text></g></svg>';
const box = { x: 0.5, y: 0.2, width: 0.4, height: 0.6, fit: 'cover' as const };

describe('owned image composition', () => {
  it('keeps a late opaque picture placeholder below the real subject while preserving the title', () => {
    const source = svg.replace('</svg>', '<rect id="picture-placeholder" x="480" y="108" width="384" height="324" fill="#eeeeee"/></svg>');
    const result = composePresentationAssets(source, [{ href: '/real-subject', layout: box }]);
    expect(result.indexOf('id="picture-placeholder"')).toBeLessThan(result.indexOf('href="/real-subject"'));
    expect(result.indexOf('href="/real-subject"')).toBeLessThan(result.indexOf('Editable title'));
  });
  it('keeps reused artwork above a percentage-sized solid slide background', () => {
    const result = composePresentationAssets(
      svg.replace('width="960" height="540"', 'width="100%" height="100%"'),
      [{ href: '/paper', layout: { ...box, layer: 'background' } }],
    );
    expect(result.indexOf('fill="white"')).toBeLessThan(result.indexOf('href="/paper"'));
    expect(result.indexOf('href="/paper"')).toBeLessThan(result.indexOf('Editable title'));
  });
  it('combines reused backgrounds and generated subjects with explicit stacking and editable text', () => {
    const result = composePresentationAssets(svg, [
      { href: '/generated-robot', layout: { ...box, zIndex: 2 } },
      { href: '/reused-leaf', layout: { ...box, zIndex: 1 } },
      { href: '/reused-paper', layout: { ...box, layer: 'background' } },
    ]);
    const root = parseString(result).documentElement;
    expect(
      Array.from(root.childNodes)
        .filter((node) => node.nodeName === 'image')
        .map((node) => (node as typeof root).getAttribute('href')),
    ).toEqual(['/reused-paper', '/reused-leaf', '/generated-robot']);
    expect(root.getElementsByTagName('text')[0].textContent).toBe('Editable title');
    expect(result.indexOf('/generated-robot')).toBeLessThan(result.indexOf('Editable title'));
  });
  it('pastes in slide coordinates rather than inheriting a text group transform and clips cover crops', () => {
    const result = composePresentationAssets(svg, [{ href: '/subject', layout: box }]);
    const root = parseString(result).documentElement;
    const image = root.getElementsByTagName('image')[0];
    expect(image.parentNode).toBe(root);
    expect(image.getAttribute('x')).toBe('480');
    expect(image.getAttribute('y')).toBe('108');
    expect(image.getAttribute('preserveAspectRatio')).toBe('xMidYMid slice');
    const clip = root.getElementsByTagName('clipPath')[0];
    expect(image.getAttribute('clip-path')).toBe(`url(#${clip.getAttribute('id')})`);
    expect(clip.getElementsByTagName('rect')[0].getAttribute('width')).toBe('384');
  });
  it('repositions an existing owned image without duplicating it or overwriting clip IDs', () => {
    const first = composePresentationAssets(svg, [{ href: '/subject?raw=true', layout: box }]);
    const updated = composePresentationAssets(first, [
      { href: '/subject', layout: { ...box, layer: 'foreground', x: 0.1 } },
    ]);
    const root = parseString(updated).documentElement;
    expect(root.getElementsByTagName('image')).toHaveLength(1);
    expect(root.getElementsByTagName('image')[0].getAttribute('x')).toBe('96');
    expect(root.lastChild?.nodeName).toBe('image');
    expect(
      new Set(
        Array.from(root.getElementsByTagName('clipPath')).map((node) => node.getAttribute('id')),
      ).size,
    ).toBe(2);
  });
});
