import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { InMemoryPresentationArtifactStore } from './artifact-store';
import {
  createArtworkStyleAtlas,
  lockArtworkPrompt,
  mapPool,
  presentationArtworkStyle,
  requestsCutout,
  shouldAutoCutout,
  verifyCutoutTransparency,
} from './artwork-pipeline';
import type { TemplateVisualProfile } from './templates/visual-types';

const visual = {
  families: [
    {
      artwork: 'soft watercolor wash',
      composition: 'title left, artwork lower-right',
      id: 'wash',
      name: 'Wash',
      pages: [1],
      palette: ['#88AACC'],
      preserve: [],
      typography: 'serif',
    },
  ],
  pages: [{ height: 788, nativeTextCount: 0, page: 1, ref: 'template-page-1', width: 1400 }],
  styleAtlas: [
    { familyId: 'wash', ref: 'template-style-1', sourcePage: 1, componentId: 'artwork-1' },
  ],
} as unknown as TemplateVisualProfile;

describe('presentation artwork pipeline', () => {
  it('crops style pixels without reintroducing full-slide headers and rejects text-bearing samples', async () => {
    const store = new InMemoryPresentationArtifactStore();
    const scope = { userId: 'artist', sessionId: 'session' };
    const bytes = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#88aacc"/><rect width="160" height="18" fill="#ff0000"/></svg>',
      ),
    )
      .png()
      .toBuffer();
    await store.put(scope, {
      artifactId: 'template-page-1',
      bytes,
      type: 'image',
      mimeType: 'image/png',
      name: 'page.png',
    });
    const component = {
      id: 'paint',
      familyId: 'wash',
      name: 'Paint sample',
      page: 1,
      box: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 },
      role: 'artwork' as const,
      containsText: false,
      treatment: 'redraw' as const,
      rationale: 'palette sample',
    };
    const result = await createArtworkStyleAtlas(
      {
        ...visual,
        styleAtlas: undefined,
        components: [component, { ...component, id: 'title', containsText: true }],
      },
      store,
      scope,
    );
    expect(result.styleAtlas).toHaveLength(1);
    const ref = result.styleAtlas![0].ref;
    const sample = await store.get(scope, ref);
    const pixels = await sharp(sample!.bytes).removeAlpha().raw().toBuffer();
    expect([...pixels.subarray(0, 3)]).toEqual([136, 170, 204]);
    expect(presentationArtworkStyle(result, undefined, 'cover').referenceAssetRefs).toEqual([ref]);
    expect(
      presentationArtworkStyle({ ...visual, styleAtlas: undefined }, undefined, 'cover')
        .referenceAssetRefs,
    ).toEqual([]);
  });
  it('locks generate calls to cropped style samples and a new-subject prompt', () => {
    const style = presentationArtworkStyle(
      visual,
      {
        slides: [
          {
            assetBrief: 'a watercolor robot with a notebook',
            familyId: 'wash',
            slideId: 'cover',
          },
        ],
      },
      'cover',
    );
    expect(style.referenceAssetRefs).toEqual(['template-style-1']);
    expect(style.background).toBe('opaque');
    expect(style.promptPrefix).toContain('STYLE REFERENCE ONLY');
    expect(style.promptPrefix).toContain('#88AACC');
    expect(style.promptPrefix).toContain('watercolor robot');
    expect(lockArtworkPrompt(style.promptPrefix, 'draw the robot')).toContain('draw the robot');
  });

  it('preserves scenes and textures and cuts out only explicitly transparent subjects', () => {
    expect(
      shouldAutoCutout({
        artwork: { role: 'subject', background: 'transparent' },
        hasProcessing: false,
      }),
    ).toBe(true);
    expect(
      shouldAutoCutout({
        artwork: { role: 'scene', background: 'preserve' },
        hasProcessing: false,
      }),
    ).toBe(false);
    expect(
      shouldAutoCutout({
        artwork: { role: 'texture', background: 'preserve' },
        hasProcessing: false,
      }),
    ).toBe(false);
    expect(shouldAutoCutout({ hasProcessing: false })).toBe(false);
    expect(
      shouldAutoCutout({
        artwork: { role: 'subject', background: 'transparent' },
        hasProcessing: true,
      }),
    ).toBe(false);
  });

  it('preserves the complete subject when the style exceeds the prompt budget', () => {
    const subject = 'A robot teaching at a university. '.repeat(80);
    const prompt = lockArtworkPrompt('Watercolor medium. '.repeat(500), subject);
    expect(prompt).toContain(subject.trim());
    expect(prompt.length).toBeLessThanOrEqual(4000);
    expect(lockArtworkPrompt('style', 'x'.repeat(4000))).toBe('x'.repeat(4000));
  });

  it('stops dispatch after a failure and joins the active sibling before rejecting', async () => {
    const gate = Promise.withResolvers<void>();
    const started: number[] = [];
    let settled = false;
    const failure = new Error('slot failed');
    const pending = mapPool([0, 1, 2, 3], 2, async (item) => {
      started.push(item);
      if (item === 0) throw failure;
      await gate.promise;
      return item;
    }).catch((error) => {
      settled = true;
      return error;
    });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(started).toEqual([0, 1]);
    } finally {
      gate.resolve();
      await pending;
    }
    expect(await pending).toBe(failure);
    expect(started).toEqual([0, 1]);
  });

  it('preserves falsy failure values instead of treating them as success', async () => {
    await expect(
      mapPool([1], 1, async () => {
        throw undefined;
      }),
    ).rejects.toBeUndefined();
  });

  it('overlaps independent slot work up to the concurrency limit', async () => {
    let live = 0;
    let peak = 0;
    const order: number[] = [];
    await mapPool([1, 2, 3, 4], 2, async (item) => {
      live += 1;
      peak = Math.max(peak, live);
      order.push(item);
      await Promise.resolve();
      live -= 1;
      return item;
    });
    expect(peak).toBe(2);
    expect(order).toHaveLength(4);
  });

  it('detects a cutout that came back without any alpha channel', async () => {
    const bytes = await sharp({
      create: { background: { b: 250, g: 250, r: 250 }, channels: 3, height: 64, width: 64 },
    })
      .png()
      .toBuffer();
    expect(await verifyCutoutTransparency(bytes)).toEqual({
      checked: true,
      hasAlphaChannel: false,
      transparentRatio: 0,
      verified: false,
    });
  });

  it('detects an RGBA cutout that stayed fully opaque', async () => {
    const bytes = await sharp({
      create: { background: { alpha: 1, b: 9, g: 9, r: 9 }, channels: 4, height: 64, width: 64 },
    })
      .png()
      .toBuffer();
    const measured = await verifyCutoutTransparency(bytes);
    expect(measured).toMatchObject({ checked: true, hasAlphaChannel: true, transparentRatio: 0 });
    expect(measured.verified).toBe(false);
  });

  it('accepts a real cutout and reports how much of it is transparent', async () => {
    const transparent = await sharp({
      create: { background: { alpha: 0, b: 0, g: 0, r: 0 }, channels: 4, height: 64, width: 64 },
    })
      .png()
      .toBuffer();
    const subject = await sharp({
      create: { background: { b: 200, g: 120, r: 20 }, channels: 3, height: 32, width: 32 },
    })
      .png()
      .toBuffer();
    const bytes = await sharp(transparent)
      .composite([{ input: subject, left: 16, top: 16 }])
      .png()
      .toBuffer();
    const measured = await verifyCutoutTransparency(bytes);
    expect(measured.checked).toBe(true);
    expect(measured.verified).toBe(true);
    expect(measured.transparentRatio).toBeGreaterThan(0.7);
  });

  it('honors a stricter transparency bar and never claims a fact it could not measure', async () => {
    const bytes = await sharp({
      create: { background: { alpha: 0.5, b: 0, g: 0, r: 0 }, channels: 4, height: 32, width: 32 },
    })
      .png()
      .toBuffer();
    expect((await verifyCutoutTransparency(bytes, { minTransparentRatio: 1 })).verified).toBe(
      false,
    );
    expect(await verifyCutoutTransparency(new Uint8Array([1, 2, 3]))).toEqual({
      checked: false,
      hasAlphaChannel: false,
      transparentRatio: 0,
      verified: false,
    });
  });

  it('recognizes which workflows promise transparency', () => {
    expect(
      requestsCutout([
        { id: 'cutout', input: { ref: '$source' }, operation: 'assets.removeBackground' },
      ]),
    ).toBe(true);
    expect(
      requestsCutout([{ id: 'draw', input: { prompt: 'a robot' }, operation: 'assets.generate' }]),
    ).toBe(false);
  });
});
