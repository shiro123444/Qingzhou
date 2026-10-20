import { zipSync } from 'fflate';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { extractNativeComponent } from './component-source';
import type { TemplateLayout } from './types';

const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
const layout: TemplateLayout = {
  assetSlots: [
    {
      aspectRatio: 2,
      box,
      fit: 'cover',
      reference: 'pptx:ppt/media/image1.png',
      slotId: 'slot-1',
      sourceCrop: { left: 0.25, right: 0.25, top: 0, bottom: 0 },
      sourceTransform: { flipH: false, flipV: false, rotation: 0 },
    },
  ],
  elements: [],
  kind: 'image-led',
  layoutId: 'layout-1',
  referenceSvg: '<svg/>',
  sourceSlideId: 'slide-1',
  textCapacity: 0,
};
const archive = async () =>
  zipSync({
    'ppt/presentation.xml': new TextEncoder().encode(
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="10000000" cy="5000000"/></p:presentation>',
    ),
    'ppt/_rels/presentation.xml.rels': new TextEncoder().encode(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    ),
    'ppt/slides/slide1.xml': new TextEncoder().encode(
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:pic><p:blipFill><a:blip r:embed="rId1"/><a:srcRect l="25000" r="25000"/></p:blipFill><p:spPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="3000000" cy="2000000"/></a:xfrm><a:prstGeom prst="rect"/></p:spPr></p:pic></p:spTree></p:cSld></p:sld>',
    ),
    'ppt/slides/_rels/slide1.xml.rels': new TextEncoder().encode(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>',
    ),
    'ppt/media/image1.png': await sharp({
      create: {
        width: 100,
        height: 50,
        channels: 4,
        background: { r: 20, g: 90, b: 60, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer(),
  });

describe('native template component extraction', () => {
  it('recovers original crop and transforms for an existing cached template profile', async () => {
    const legacy = {
      ...layout,
      assetSlots: [{ ...layout.assetSlots[0]!, sourceCrop: undefined, sourceTransform: undefined }],
    };
    const result = await extractNativeComponent(await archive(), legacy, box);
    expect(await sharp(result!).metadata()).toMatchObject({
      width: 50,
      height: 50,
      hasAlpha: true,
    });
  });
  it('retains source transparency and OOXML crop instead of baking in the slide background', async () => {
    const result = await extractNativeComponent(await archive(), layout, box);
    const { data, info } = await sharp(result!).raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 50, height: 50, channels: 4 });
    expect([...data.subarray(0, 4)]).toEqual([20, 90, 60, 128]);
  });
  it('falls back for composite regions and arbitrary references', async () => {
    const source = await archive();
    expect(
      await extractNativeComponent(
        source,
        { ...layout, assetSlots: [...layout.assetSlots, ...layout.assetSlots] },
        box,
      ),
    ).toBeNull();
    expect(
      await extractNativeComponent(
        source,
        {
          ...layout,
          assetSlots: [{ ...layout.assetSlots[0]!, reference: 'https://example.com/image.png' }],
        },
        box,
      ),
    ).toBeNull();
    expect(await extractNativeComponent(source, layout, { ...box, width: 0.8 })).toBeNull();
  });
  it.each([
    { approximate: true, flipH: false, flipV: false, rotation: 0 },
    { flipH: true, flipV: false, rotation: 0 },
    { flipH: false, flipV: false, rotation: 45 },
  ])('does not flatten unsupported shape transforms: %j', async (sourceTransform) => {
    expect(
      await extractNativeComponent(
        await archive(),
        { ...layout, assetSlots: [{ ...layout.assetSlots[0]!, sourceTransform }] },
        box,
      ),
    ).toBeNull();
  });
  it('falls back for corrupt bytes and source crops outside the image', async () => {
    expect(await extractNativeComponent(new Uint8Array([1, 2]), layout, box)).toBeNull();
    expect(
      await extractNativeComponent(
        await archive(),
        {
          ...layout,
          assetSlots: [
            { ...layout.assetSlots[0]!, sourceCrop: { left: -0.5, right: 0, top: 0, bottom: 0 } },
          ],
        },
        box,
      ),
    ).toBeNull();
  });
});
