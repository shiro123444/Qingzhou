import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';

import type { PresentationPlan } from '../../../../../packages/runtime-contracts/src';
import {
  extractPlanTemplate,
  extractPptxTemplate,
  FilePresentationTemplateLibrary,
  templatePlannerInstructions,
} from './index';

const scope = { sessionId: 'session', userId: 'owner' };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const plan: PresentationPlan = {
  aspectRatio: '16:9',
  designSpec: { density: 'low', theme: 'teal' },
  planId: 'source-plan',
  slides: [
    {
      notes: 'Speak about collaboration.',
      order: 1,
      slideId: 'cover',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 540"><rect width="960" height="540" fill="#fff"/><g transform="translate(48 24)" fill="#123456" font-family="Aptos" font-size="40"><text x="0" y="80">Hello</text><text x="0" y="160" font-size="24">Supporting words</text></g><image href="asset:photo" x="55%" y="20%" width="40%" height="65%" preserveAspectRatio="xMidYMid slice"/></svg>',
    },
  ],
  sourceVersionIds: [],
  title: 'Reference',
};

const rels = (entries: string): string =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`;
const relationship = (id: string, type: string, target: string, external = false): string =>
  `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"${external ? ' TargetMode="External"' : ''}/>`;
const pptxFixture = (): Uint8Array =>
  zipSync(
    Object.fromEntries(
      Object.entries({
        'ppt/presentation.xml':
          '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId r:id="rId9" id="256"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>',
        'ppt/_rels/presentation.xml.rels': rels(relationship('rId9', 'slide', 'slides/slide4.xml')),
        'ppt/slides/slide4.xml':
          '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:rPr sz="3000"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:rPr><a:t>Learn &amp; create</a:t></a:r></a:p></p:txBody></p:sp><p:pic><p:blipFill><a:blip r:embed="image1"/><a:srcRect l="1000"/></p:blipFill><p:spPr><a:xfrm><a:off x="4572000" y="1028700"/><a:ext cx="3657600" cy="3086100"/></a:xfrm></p:spPr></p:pic></p:spTree></p:cSld></p:sld>',
        'ppt/slides/_rels/slide4.xml.rels': rels(
          relationship('layout1', 'slideLayout', '../slideLayouts/slideLayout1.xml') +
            relationship('image1', 'image', '../media/image1.png') +
            relationship('external', 'hyperlink', 'https://example.com/private', true) +
            relationship('notes1', 'notesSlide', '../notesSlides/notesSlide1.xml'),
        ),
        'ppt/slideLayouts/slideLayout1.xml':
          '<p:sldLayout xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="514350"/><a:ext cx="7315200" cy="771525"/></a:xfrm></p:spPr></p:sp></p:spTree></p:cSld></p:sldLayout>',
        'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels(
          relationship('master1', 'slideMaster', '../slideMasters/slideMaster1.xml'),
        ),
        'ppt/slideMasters/slideMaster1.xml':
          '<p:sldMaster xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:clrMap tx1="dk1" bg1="lt1"/></p:sldMaster>',
        'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels(
          relationship('theme1', 'theme', '../theme/theme1.xml'),
        ),
        'ppt/theme/theme1.xml':
          '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="Teal"><a:accent1><a:srgbClr val="009688"/></a:accent1><a:dk1><a:sysClr val="windowText" lastClr="222222"/></a:dk1></a:clrScheme><a:fontScheme name="Modern"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>',
        'ppt/notesSlides/notesSlide1.xml':
          '<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Speaker note</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
      }).map(([name, source]) => [name, strToU8(source)]),
    ),
  );

const videoPptxFixture = (): Uint8Array => {
  const files = unzipSync(pptxFixture());
  const slide = 'ppt/slides/slide4.xml';
  files[slide] = strToU8(
    strFromU8(files[slide]).replace(
      '<p:pic>',
      '<p:pic><p:nvPicPr><p:cNvPr id="9" name="Lesson video"/><p:nvPr><a:videoFile r:link="video1"/></p:nvPr></p:nvPicPr>',
    ),
  );
  const relations = 'ppt/slides/_rels/slide4.xml.rels';
  files[relations] = strToU8(
    strFromU8(files[relations]).replace(
      '</Relationships>',
      `${relationship('video1', 'video', '../media/video1.mp4')}</Relationships>`,
    ),
  );
  files['ppt/media/video1.mp4'] = strToU8('embedded-video-fixture');
  return zipSync(files);
};

describe('Presentation template learning', () => {
  it('extracts actual SVG style, transformed geometry, capacity, image slots and notes', () => {
    const learned = extractPlanTemplate(plan);
    expect(learned.constraints.palette).toContain('#123456');
    expect(learned.constraints.palette).toContain('#FFFFFF');
    expect(learned.constraints.fontFamilies).toEqual(['Aptos']);
    expect(learned.constraints.fontSizes).toEqual([40, 24]);
    const layout = learned.layouts[0];
    expect(layout.kind).toBe('image-right');
    expect(layout.elements.find((element) => element.role === 'title')).toMatchObject({
      box: { x: 0.05 },
      textCapacity: 5,
    });
    expect(layout.assetSlots[0]).toMatchObject({
      box: { height: 0.65, width: 0.4, x: 0.55, y: 0.2 },
      fit: 'cover',
      reference: 'asset:photo',
    });
    expect(layout.notes).toBe('Speak about collaboration.');
    expect(layout.referenceSvg).toBe(plan.slides[0].svg);
  });

  it('imports native PPTX relationships, theme, inherited placeholder geometry and assets', () => {
    const learned = extractPptxTemplate(pptxFixture());
    expect(learned.constraints.aspectRatio).toBe('16:9');
    expect(learned.constraints.palette).toContain('#009688');
    expect(learned.constraints.fontFamilies).toContain('Aptos Display');
    expect(learned.layouts).toHaveLength(1);
    expect(learned.layouts[0].elements[0]).toMatchObject({
      box: { x: 0.05, y: 0.1, width: 0.8, height: 0.15 },
      color: '#009688',
      fontFamily: 'Aptos Display',
      fontSize: 40,
      role: 'title',
      textCapacity: 14,
    });
    expect(learned.layouts[0].referenceSvg).toContain('Learn &amp; create');
    expect(learned.layouts[0].assetSlots[0]).toMatchObject({
      box: { x: 0.5, y: 0.2, width: 0.4, height: 0.6 },
      fit: 'cover',
      reference: 'pptx:ppt/media/image1.png',
    });
    expect(learned.layouts[0].notes).toBe('Speaker note');
    expect(learned.warnings).toContain('External PPTX relationships were ignored.');
  });

  it('records embedded video placement and poster evidence without executing media', () => {
    const learned = extractPptxTemplate(videoPptxFixture());
    expect(learned.media).toEqual([
      expect.objectContaining({
        box: { height: 0.6, width: 0.4, x: 0.5, y: 0.2 },
        kind: 'video',
        mimeType: 'video/mp4',
        page: 1,
        path: 'ppt/media/video1.mp4',
        posterReference: 'pptx:ppt/media/image1.png',
        relationshipId: 'video1',
        sizeBytes: 22,
      }),
    ]);
    expect(learned.warnings.join(' ')).toContain('Embedded videos');
  });

  it('persists immutable learned versions, restores them and isolates scopes', async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), 'ppt-templates-'));
    roots.push(root);
    const library = new FilePresentationTemplateLibrary({ root });
    const first = await library.learnFromPlan(scope, { name: 'Teal', plan });
    const second = await library.learnFromPlan(scope, {
      name: 'Teal refined',
      plan: { ...plan, designSpec: { density: 'medium' } },
      templateId: first.templateId,
    });
    expect(second.versionId).not.toBe(first.versionId);
    const restored = new FilePresentationTemplateLibrary({ root });
    expect(await restored.get(scope, first.templateId, first.versionId)).toEqual(first);
    expect(await restored.get(scope, second.templateId, second.versionId)).toEqual(second);
    expect(await restored.get(scope, first.templateId)).toEqual(second);
    expect(await restored.list(scope)).toHaveLength(1);
    expect(await restored.list({ ...scope, sessionId: 'other' })).toEqual([]);
    expect(await restored.get({ ...scope, userId: 'other' }, first.templateId)).toBeNull();
    await expect(restored.resolve({ ...scope, userId: 'other' }, first)).rejects.toThrow(
      'does not exist',
    );
    await expect(
      restored.learnFromPlan(
        { ...scope, userId: 'other' },
        { name: 'Hijack', plan, templateId: first.templateId },
      ),
    ).rejects.toThrow('does not exist');
    const application = await restored.resolve(scope, first);
    const instructions = templatePlannerInstructions(application);
    expect(instructions).toContain('"x":0.55');
    expect(instructions).toContain('"textCapacity":5');
    expect(instructions).toContain('"referenceSvg"');
    expect(application.versionId).toBe(first.versionId);
  });

  it('preserves original PPTX bytes independently of the extracted profile', async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), 'ppt-templates-source-'));
    roots.push(root);
    const library = new FilePresentationTemplateLibrary({ root });
    const bytes = pptxFixture();
    const profile = await library.importPptx(scope, { bytes, name: 'Native template' });
    expect(profile.source.kind).toBe('pptx');
    expect(await library.getSourcePptx(scope, profile)).toEqual(bytes);
    expect(await library.getSourcePptx({ ...scope, userId: 'other' }, profile)).toBeNull();
  });

  it('removes every immutable version of one owned template', async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), 'ppt-templates-delete-'));
    roots.push(root);
    const library = new FilePresentationTemplateLibrary({ root });
    const first = await library.learnFromPlan(scope, { name: 'Disposable', plan });
    await library.learnFromPlan(scope, {
      name: 'Disposable refined',
      plan,
      templateId: first.templateId,
    });

    await library.remove(scope, first.templateId);

    expect(await library.get(scope, first.templateId)).toBeNull();
    expect(await library.list(scope)).toEqual([]);
    await expect(library.remove(scope, first.templateId)).rejects.toThrow('does not exist');
  });

  it('rejects invalid/active XML and oversized uploads without external execution', () => {
    expect(() => extractPptxTemplate(new Uint8Array([1, 2, 3]))).toThrow('readable PPTX');
    expect(() => extractPptxTemplate(new Uint8Array(101 * 1024 * 1024))).toThrow('100 MiB');
    expect(() =>
      extractPlanTemplate({
        ...plan,
        slides: [{ ...plan.slides[0], svg: '<svg onload="doSomething()"><text>hi</text></svg>' }],
      }),
    ).toThrow(/active content|invalid SVG/u);
    expect(() =>
      extractPptxTemplate(
        zipSync({
          'ppt/presentation.xml': strToU8(
            '<!DOCTYPE p [<!ENTITY x SYSTEM "file:///etc/passwd">]><presentation>&x;</presentation>',
          ),
        }),
      ),
    ).toThrow('unsupported XML');
  });
});
