import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  captureGlassSources,
  isLocalGlassResource,
  planGlassAtlas,
  serializeGlassSource,
  serializeGlassWallpaper,
} from './sources';

const bounds = { height: 300, width: 500, x: 0, y: 0 };

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('glass source resource boundary', () => {
  it('does not instantiate custom elements while cloning', async () => {
    let constructions = 0;
    class CaptureFixtureElement extends HTMLElement {
      constructor() {
        super();
        constructions += 1;
      }
    }
    customElements.define('qz-source-fixture', CaptureFixtureElement);
    const root = document.createElement('div');
    root.innerHTML = '<qz-source-fixture>Safe content</qz-source-fixture>';
    document.body.append(root);
    const before = constructions;
    const result = await serializeGlassSource(root, { bounds });
    expect(result).toContain('Safe content');
    expect(result).not.toContain('qz-source-fixture');
    expect(constructions).toBe(before);
  });

  it('only accepts already loaded local or raster data resources', () => {
    const origin = 'https://qingzhou.test/app';
    expect(isLocalGlassResource('/cover.png', origin)).toBe(true);
    expect(isLocalGlassResource('blob:https://qingzhou.test/local', origin)).toBe(true);
    expect(isLocalGlassResource('data:image/png;base64,AAAA', origin)).toBe(true);
    for (const resource of [
      'https://external.test/cover.png',
      'blob:https://external.test/id',
      'data:image/svg+xml,<svg/>',
      'javascript:alert(1)',
      'file:///private/cover.png',
    ])
      expect(isLocalGlassResource(resource, origin)).toBe(false);
  });

  it('serializes local text and vector icons without URL paint, scripts or optical output', async () => {
    const root = document.createElement('div');
    root.innerHTML = `<p onclick="danger()" style="background-image:url(https://external.test/bg.png)">Hello</p>
      <svg viewBox="0 0 24 24"><path d="M1 2 L3 4"/><image href="https://external.test/icon.svg"/></svg>
      <script>danger()</script><iframe src="https://external.test/frame"></iframe>
      <canvas data-qz-glass-canvas></canvas><svg data-qz-glass-definitions><path d="M9 9"/></svg>`;
    document.body.append(root);
    const fetch = vi.spyOn(globalThis, 'fetch');
    const original = root.outerHTML;
    const result = await serializeGlassSource(root, { bounds });
    expect(result).toContain('Hello');
    expect(result).toContain('M1 2 L3 4');
    expect(result).not.toMatch(/external\.test|danger\(|<iframe|<script|M9 9|<canvas/);
    expect(fetch).not.toHaveBeenCalled();
    expect(root.outerHTML).toBe(original);
  });
});

describe('glass source layer separation', () => {
  it('separates theme wallpaper from transparent page content without copying foreground', async () => {
    const root = document.createElement('div');
    root.style.background = 'linear-gradient(90deg, red, blue) rgb(240, 245, 250)';
    root.innerHTML = '<p>Page foreground</p><svg><path d="M1 2 L3 4"/></svg>';
    document.body.append(root);
    const original = root.outerHTML;
    const wallpaper = serializeGlassWallpaper(root, bounds);
    const content = await serializeGlassSource(root, { bounds, foreground: true });
    expect(wallpaper).toContain('linear-gradient(90deg, red, blue)');
    expect(wallpaper).not.toContain('Page foreground');
    expect(wallpaper).not.toContain('M1 2 L3 4');
    expect(content).toContain('Page foreground');
    expect(content).toContain('background: transparent');
    expect(content).not.toContain('linear-gradient');
    expect(root.outerHTML).toBe(original);
    root.style.backgroundImage = 'url(https://external.test/wallpaper.png)';
    expect(serializeGlassWallpaper(root, bounds)).not.toContain('external.test');
  });

  it('keeps shell content, omits independent layers without changing their layout slot', async () => {
    const root = document.createElement('div');
    root.dataset.qzGlass = 'shell';
    root.style.background = 'red';
    root.innerHTML =
      '<p>Background article</p><aside style="width:120px;height:40px">Toolbar text</aside>';
    document.body.append(root);
    const layer = root.querySelector('aside')!;
    const result = await serializeGlassSource(root, { bounds, exclude: new Set([layer]) });
    expect(result).toContain('Background article');
    expect(result).not.toContain('Toolbar text');
    expect(result).toContain('data-qz-source-placeholder');
    expect(result).toContain('120px');
    expect(root.style.background).toBe('red');
    const parsed = new DOMParser().parseFromString(result, 'image/svg+xml');
    const copiedRoot = parsed.querySelector('foreignObject > div > div') as HTMLElement;
    expect(copiedRoot.getAttribute('style')).toContain('background: transparent');
  });

  it('captures changed foreground text while excluding nested independent layers', async () => {
    const root = document.createElement('div');
    root.innerHTML = '<strong>Old lyric</strong><aside>Nested menu</aside>';
    document.body.append(root);
    const options = { bounds, exclude: new Set([root.querySelector('aside')!]), foreground: true };
    const first = await serializeGlassSource(root, options);
    root.querySelector('strong')!.textContent = 'New lyric';
    const second = await serializeGlassSource(root, options);
    expect(first).toContain('Old lyric');
    expect(second).toContain('New lyric');
    expect(second).not.toContain('Old lyric');
    expect(second).not.toContain('Nested menu');
  });

  it('preserves the formatting context while serializing a scrolled content viewport', async () => {
    const root = document.createElement('div');
    root.style.cssText = 'display:flex;flex-direction:column;gap:12px;padding:8px;';
    root.innerHTML = '<span>First</span><span>Second</span>';
    Object.defineProperties(root, {
      clientHeight: { value: 200 },
      clientWidth: { value: 300 },
      scrollHeight: { value: 600 },
      scrollTop: { value: 70 },
    });
    document.body.append(root);
    const result = await serializeGlassSource(root, { bounds });
    const parsed = new DOMParser().parseFromString(result, 'image/svg+xml');
    const scrolled = parsed.querySelector('foreignObject > div > div > div')!;
    expect(scrolled.getAttribute('style')).toContain('translate(0px,-70px)');
    expect(scrolled.getAttribute('style')).toContain('display: flex');
    expect(scrolled.getAttribute('style')).toContain('flex-direction: column');
    expect(scrolled.getAttribute('style')).toContain('gap: 12px');
    expect(scrolled.getAttribute('style')).toContain('width: 284px');
    expect(scrolled.getAttribute('style')).toContain('height: 184px');
    expect(root.scrollTop).toBe(70);
  });

  it('aborts without touching the source and rejects an oversized tree', async () => {
    const root = document.createElement('div');
    root.textContent = 'Still interactive';
    const controller = new AbortController();
    controller.abort();
    await expect(
      serializeGlassSource(root, { bounds, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(root.textContent).toBe('Still interactive');
    root.innerHTML = '<span>Item</span>'.repeat(900);
    await expect(serializeGlassSource(root, { bounds })).rejects.toThrow('node budget');
  });
});

describe('glass atlas layout', () => {
  it('bounds wallpaper, page content and seven foreground planes without overlapping tiles', () => {
    const atlas = planGlassAtlas([
      { height: 2160, width: 3840 },
      { height: 2160, width: 3840 },
      ...Array.from({ length: 7 }, () => ({ height: 800, width: 1200 })),
    ]);
    expect(atlas.width).toBeLessThanOrEqual(2048);
    expect(atlas.height).toBeLessThanOrEqual(2048);
    for (const [index, tile] of atlas.tiles.entries()) {
      expect(tile.x).toBeGreaterThanOrEqual(2);
      expect(tile.y).toBeGreaterThanOrEqual(2);
      expect(tile.x + tile.width).toBeLessThan(atlas.width);
      expect(tile.y + tile.height).toBeLessThan(atlas.height);
      for (const other of atlas.tiles.slice(index + 1)) {
        expect(
          tile.x + tile.width < other.x ||
            other.x + other.width < tile.x ||
            tile.y + tile.height < other.y ||
            other.y + other.height < tile.y,
        ).toBe(true);
      }
    }
  });

  it('rejects unbounded dimensions and more than nine planes before allocating a canvas', () => {
    for (const invalid of [
      [],
      [{ width: 0, height: 10 }],
      [{ width: Infinity, height: 10 }],
      Array.from({ length: 10 }, () => ({ width: 10, height: 10 })),
    ]) {
      expect(() => planGlassAtlas(invalid)).toThrow(RangeError);
    }
  });
});

describe('incremental glass source capture', () => {
  function captureFixture() {
    const root = document.createElement('main');
    root.innerHTML =
      '<p>Page text</p><aside><b>Sidebar text</b><span>Nested text</span></aside><section><strong>Paused</strong></section>';
    document.body.append(root);
    const sidebar = root.querySelector('aside')!;
    const capsule = root.querySelector('section')!;
    const setBounds = (element: HTMLElement, x: number, y: number, width: number, height: number) =>
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(x, y, width, height));
    setBounds(root, 0, 0, 500, 300);
    setBounds(sidebar, 0, 0, 100, 300);
    const capsuleBounds = setBounds(capsule, 200, 20, 200, 60);
    const context = { drawImage() {} };
    const draw = vi.spyOn(context, 'drawImage');
    const canvases: HTMLCanvasElement[] = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (
      this: HTMLCanvasElement,
    ) {
      canvases.push(this);
      return context as unknown as ReturnType<HTMLCanvasElement['getContext']>;
    });
    const images: string[] = [];
    vi.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (
      this: HTMLImageElement,
      src: string,
    ) {
      images.push(src);
      queueMicrotask(() => this.dispatchEvent(new Event('load')));
    });
    const options = {
      height: 300,
      layers: [
        { element: sidebar, id: 'sidebar' },
        { element: capsule, id: 'capsule' },
      ],
      root,
      width: 500,
    };
    return { canvases, capsule, capsuleBounds, draw, images, options, root, setBounds, sidebar };
  }

  it('rasterizes only dirty foreground and reuses static content while the capsule moves', async () => {
    const { capsule, capsuleBounds, draw, images, options } = captureFixture();
    const first = await captureGlassSources(options);
    expect(first.stats).toMatchObject({ captured: 4, reused: 0 });
    const firstNodes = first.stats.nodes;
    capsule.querySelector('strong')!.textContent = 'Playing';
    images.length = 0;
    draw.mockClear();
    const second = await captureGlassSources({
      ...options,
      dirtyIds: new Set(['capsule']),
      previous: first,
    });
    expect(second.stats).toMatchObject({ captured: 1, reused: 3 });
    expect(second.stats.nodes).toBeLessThan(firstNodes);
    expect(images).toHaveLength(1);
    expect(decodeURIComponent(images[0])).toContain('Playing');
    expect(draw.mock.calls.filter((call) => (call as unknown[])[0] === first.canvas)).toHaveLength(
      3,
    );
    first.dispose();
    expect(first.canvas.width).toBe(0);
    expect(second.canvas.width).toBeGreaterThan(0);

    capsuleBounds.mockReturnValue(new DOMRect(260, 100, 200, 60));
    images.length = 0;
    const moved = await captureGlassSources({ ...options, dirtyIds: new Set(), previous: second });
    expect(moved.stats).toMatchObject({ captured: 0, nodes: 0, reused: 4 });
    expect(images).toEqual([]);
    expect(moved.planes.find(({ id }) => id === 'capsule')?.bounds).toMatchObject({
      x: 260,
      y: 100,
    });
    second.dispose();
    moved.dispose();
  });

  it('invalidates changed exclusion ownership, dimensions and disposed caches', async () => {
    const { capsuleBounds, options, setBounds, sidebar } = captureFixture();
    const first = await captureGlassSources(options);
    const nested = sidebar.querySelector('span')!;
    setBounds(nested, 4, 50, 80, 30);
    const second = await captureGlassSources({
      ...options,
      dirtyIds: new Set(),
      layers: [...options.layers, { element: nested, id: 'nested' }],
      previous: first,
    });
    expect(second.stats).toMatchObject({ captured: 3, reused: 2 });
    first.dispose();
    capsuleBounds.mockReturnValue(new DOMRect(200, 20, 230, 60));
    const resized = await captureGlassSources({
      ...options,
      dirtyIds: new Set(),
      previous: second,
    });
    // Removing the nested plane updates its parents; changing the capsule size updates its tile.
    expect(resized.stats).toMatchObject({ captured: 3, reused: 1 });
    second.dispose();
    resized.dispose();
    const fresh = await captureGlassSources({ ...options, dirtyIds: new Set(), previous: resized });
    expect(fresh.stats).toMatchObject({ captured: 4, reused: 0 });
    fresh.dispose();
  });

  it('releases a cancelled partial atlas and keeps the previous frame intact', async () => {
    const { canvases, capsule, options } = captureFixture();
    const first = await captureGlassSources(options);
    const originalWidth = first.canvas.width;
    const controller = new AbortController();
    const getStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
      if (element === capsule) controller.abort();
      return getStyle(element, pseudo);
    });
    await expect(
      captureGlassSources({
        ...options,
        dirtyIds: new Set(['capsule']),
        previous: first,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(first.canvas.width).toBe(originalWidth);
    expect(canvases.at(-1)?.width).toBe(0);
    expect(capsule.textContent).toBe('Paused');
    first.dispose();
  });
});
