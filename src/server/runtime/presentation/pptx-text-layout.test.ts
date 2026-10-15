import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { preserveSvgTextLayout } from './pptx-text-layout';

describe('SVG text layout in native PPTX', () => {
  it('prevents one-line dates from reflowing without changing size, content, notes or media', () => {
    const slide =
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:bodyPr wrap="none" lIns="0"><a:spAutoFit/></a:bodyPr><a:r><a:rPr sz="1500"/><a:t>2026年10月</a:t></a:r><a:bodyPr wrap="square"><a:spAutoFit/></a:bodyPr></p:sld>';
    const files = {
      'ppt/slides/slide1.xml': strToU8(slide),
      'ppt/notesSlides/notesSlide1.xml': strToU8('<a:spAutoFit/>完整资料'),
      'ppt/media/image1.png': new Uint8Array([1, 2, 3]),
    };
    const result = unzipSync(preserveSvgTextLayout(zipSync(files)));
    const xml = strFromU8(result['ppt/slides/slide1.xml']);
    expect(xml).toContain('<a:noAutofit/>');
    expect(xml).toContain('wrap="square"><a:spAutoFit/>');
    expect(xml).toContain('sz="1500"');
    expect(xml).toContain('2026年10月');
    expect(result['ppt/notesSlides/notesSlide1.xml']).toEqual(
      files['ppt/notesSlides/notesSlide1.xml'],
    );
    expect(result['ppt/media/image1.png']).toEqual(files['ppt/media/image1.png']);
  });
  it('leaves an already fixed package unchanged', () => {
    const bytes = zipSync({
      'ppt/slides/slide1.xml': strToU8(
        '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
      ),
    });
    expect(preserveSvgTextLayout(bytes)).toBe(bytes);
  });
});
