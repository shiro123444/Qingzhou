import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { fillNativePptx, inspectNativePptx } from './native';

const archive = () =>
  zipSync(
    Object.fromEntries(
      Object.entries({
        '[Content_Types].xml':
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="mp4" ContentType="video/mp4"/></Types>',
        'ppt/presentation.xml':
          '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>',
        'ppt/_rels/presentation.xml.rels':
          '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>',
        'ppt/slides/slide1.xml':
          '<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r" xmlns:p14="p14"><p:spTree><p:grpSp><p:sp><p:nvSpPr><p:cNvPr id="7" name="Hero title"/></p:nvSpPr><p:txBody><a:p><a:r><a:rPr b="1"/><a:t>Old</a:t></a:r><a:r><a:rPr i="1"/><a:t> style</a:t></a:r></a:p></p:txBody></p:sp></p:grpSp><p:pic><p:nvPicPr><p:cNvPr id="8" name="Photo"/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdPicture"/></p:blipFill></p:pic><p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="9" name="Chart"/></p:nvGraphicFramePr><a:graphic>KEEP CHART</a:graphic></p:graphicFrame><p:pic><p:nvPicPr><p:cNvPr id="10" name="Lesson video"/><p:nvPr><a:videoFile r:link="rIdVideo"/><p14:media r:embed="rIdMedia"/></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="rIdPoster"/></p:blipFill></p:pic></p:spTree><p:timing>KEEP PLAYBACK TIMING</p:timing></p:sld>',
        'ppt/slides/_rels/slide1.xml.rels':
          '<Relationships><Relationship Id="rIdPicture" Target="../media/original.png" Type="image"/><Relationship Id="rIdPoster" Target="../media/poster.png" Type="image"/><Relationship Id="rIdVideo" Target="../media/original.mp4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video"/><Relationship Id="rIdMedia" Target="../media/original.mp4" Type="http://schemas.microsoft.com/office/2007/relationships/media"/></Relationships>',
        'ppt/media/original.png': 'original binary',
        'ppt/media/poster.png': 'poster binary',
        'ppt/media/original.mp4': 'original video binary',
        'ppt/slideMasters/slideMaster1.xml': '<master>complex master untouched</master>',
        'ppt/charts/chart1.xml': '<chart>data untouched</chart>',
        'ppt/notesSlides/notesSlide1.xml': '<notes>untouched</notes>',
      }).map(([path, text]) => [path, strToU8(text)]),
    ),
  );
describe('native template filling', () => {
  it('finds grouped text and native chart objects and preserves every unedited part', () => {
    const source = archive();
    const inspected = inspectNativePptx(source);
    expect(inspected.pages[0].shapes.map((s) => s.id)).toEqual(['7', '8', '9', '10']);
    expect(inspected.preservedParts.charts).toBe(1);
    const output = fillNativePptx(source, [
      { page: 1, shapeId: '7', runs: ['New & clear', ' style'] },
    ]);
    const before = unzipSync(source);
    const after = unzipSync(output.bytes);
    expect(output.changedParts).toEqual(['ppt/slides/slide1.xml']);
    for (const path of Object.keys(before).filter((p) => p !== 'ppt/slides/slide1.xml'))
      expect(after[path]).toEqual(before[path]);
    expect(strFromU8(after['ppt/slides/slide1.xml'])).toContain('New &amp; clear');
    expect(strFromU8(after['ppt/slides/slide1.xml'])).toContain('<a:rPr i="1"/>');
  });
  it('adds a private picture relationship without replacing shared media', () => {
    const output = fillNativePptx(archive(), [
      { page: 1, shapeId: '8', image: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' } },
    ]);
    const after = unzipSync(output.bytes);
    expect(strFromU8(after['ppt/media/original.png'])).toBe('original binary');
    expect(strFromU8(after['ppt/slides/_rels/slide1.xml.rels'])).toContain('rIdCordis');
    expect(strFromU8(after['ppt/slides/slide1.xml'])).toContain('KEEP CHART');
  });
  it('replaces native video bytes while preserving poster, shape and playback timing', () => {
    const source = archive();
    const before = unzipSync(source);
    const replacement = new Uint8Array([9, 8, 7, 6]);
    const inspected = inspectNativePptx(source);
    expect(inspected.pages[0].shapes.find((shape) => shape.id === '10')).toMatchObject({
      mediaRelationships: [
        { kind: 'video', relationshipId: 'rIdVideo' },
        { kind: 'media', relationshipId: 'rIdMedia' },
      ],
    });
    const output = fillNativePptx(source, [
      {
        media: { bytes: replacement, kind: 'video', mimeType: 'video/mp4' },
        page: 1,
        shapeId: '10',
      },
    ]);
    const after = unzipSync(output.bytes);
    expect(after['ppt/slides/slide1.xml']).toEqual(before['ppt/slides/slide1.xml']);
    expect(strFromU8(after['ppt/slides/slide1.xml'])).toContain('KEEP PLAYBACK TIMING');
    expect(after['ppt/media/original.mp4']).toEqual(before['ppt/media/original.mp4']);
    expect(after['ppt/media/poster.png']).toEqual(before['ppt/media/poster.png']);
    const replacementPath = Object.keys(after).find((path) =>
      /ppt\/media\/cordis-.*\.mp4$/u.test(path),
    );
    expect(replacementPath).toBeTruthy();
    expect(after[replacementPath!]).toEqual(replacement);
    const relationships = strFromU8(after['ppt/slides/_rels/slide1.xml.rels']);
    expect(relationships).toContain(
      `Id="rIdVideo" Target="../media/${replacementPath!.split('/').at(-1)}"`,
    );
    expect(relationships).toContain(
      `Id="rIdMedia" Target="../media/${replacementPath!.split('/').at(-1)}"`,
    );
    expect(relationships).toContain('Id="rIdPoster" Target="../media/poster.png"');
    expect(output.changedParts).not.toContain('ppt/slides/slide1.xml');
  });
  it('rejects missing shape IDs, chart text rewrites and inconsistent rich text', () => {
    for (const patch of [
      { page: 1, shapeId: 'missing', text: 'x' },
      { page: 1, shapeId: '9', text: 'x' },
      { page: 1, shapeId: '7', runs: ['wrong count'] },
    ])
      expect(() => fillNativePptx(archive(), [patch])).toThrow();
  });
});
