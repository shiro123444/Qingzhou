import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { parseExportFontMap, preserveSvgTextLayout } from './pptx-text-layout';

describe('SVG text layout in native PPTX', () => {
  it('accepts explicit aliases and rejects malformed deployment configuration', () => {
    expect(parseExportFontMap(undefined)).toEqual({});
    expect(parseExportFontMap('{"Microsoft YaHei":"Hiragino Sans GB"}')).toEqual({
      'Microsoft YaHei': 'Hiragino Sans GB',
    });
    for (const raw of ['[]', 'null', '{"Font":42}', '{"Font":""}']) {
      expect(() => parseExportFontMap(raw)).toThrow();
    }
  });
  it('restores configured target font aliases in slides and theme without repainting other faces', () => {
    const xml =
      '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:latin typeface="Arial"/><a:ea typeface="Microsoft YaHei"/><a:font script="Hans" typeface="Microsoft YaHei"/><a:ea typeface="SimSun"/></a:theme>';
    const notes = strToU8('Microsoft YaHei is a quoted source name');
    const result = unzipSync(
      preserveSvgTextLayout(
        zipSync({
          'ppt/slides/slide1.xml': strToU8(xml),
          'ppt/theme/theme1.xml': strToU8(xml),
          'ppt/notesSlides/notesSlide1.xml': notes,
        }),
        { 'Microsoft YaHei': 'Hiragino Sans GB' },
      ),
    );
    for (const path of ['ppt/slides/slide1.xml', 'ppt/theme/theme1.xml']) {
      const changed = strFromU8(result[path]);
      expect(changed).toContain('typeface="Hiragino Sans GB"');
      expect(changed).toContain('typeface="Arial"');
      expect(changed).toContain('typeface="SimSun"');
      expect(changed).not.toContain('typeface="Microsoft YaHei"');
    }
    expect(result['ppt/notesSlides/notesSlide1.xml']).toEqual(notes);
  });
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
