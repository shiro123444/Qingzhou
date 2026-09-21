import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, expect, it } from 'vitest';

import { InMemoryPresentationArtifactStore } from '../artifact-store';
import { FilePresentationTemplateLibrary } from './library';
import { nativeTemplateOperations } from './native-operations';

const scope = { sessionId: 'account', userId: 'owner' };
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const videoTemplate = () =>
  zipSync({
    '[Content_Types].xml': strToU8(
      '<Types><Default Extension="mp4" ContentType="video/mp4"/><Default Extension="png" ContentType="image/png"/></Types>',
    ),
    'ppt/presentation.xml': strToU8(
      '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="1" r:id="slide"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500"/></p:presentation>',
    ),
    'ppt/_rels/presentation.xml.rels': strToU8(
      '<Relationships><Relationship Id="slide" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>',
    ),
    'ppt/slides/slide1.xml': strToU8(
      '<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"><p:cSld><p:spTree><p:pic><p:nvPicPr><p:cNvPr id="7" name="Video"/><p:nvPr><a:videoFile r:link="video"/></p:nvPr></p:nvPicPr><p:blipFill><a:blip r:embed="poster"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="9144000" cy="5143500"/></a:xfrm></p:spPr></p:pic></p:spTree></p:cSld><p:timing>KEEP</p:timing></p:sld>',
    ),
    'ppt/slides/_rels/slide1.xml.rels': strToU8(
      '<Relationships><Relationship Id="video" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="../media/source.mp4"/><Relationship Id="poster" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/poster.png"/></Relationships>',
    ),
    'ppt/media/source.mp4': new Uint8Array([1, 2, 3]),
    'ppt/media/poster.png': new Uint8Array([137, 80, 78, 71]),
  });

it('extracts owned media and replaces its native relationship without changing slide timing', async () => {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'qingzhou-native-media-'));
  directories.push(root);
  const library = new FilePresentationTemplateLibrary({ root });
  const profile = await library.importPptx(scope, { bytes: videoTemplate(), name: 'Video' });
  const store = new InMemoryPresentationArtifactStore();
  const operations = nativeTemplateOperations(library, store);
  const extract = operations.find(
    (operation) => operation.name === 'presentation.template.extractMedia',
  )!;
  const extracted = (await extract.execute({ templateId: profile.templateId }, { scope })) as {
    media: { ref: string }[];
  };
  expect(extracted.media).toHaveLength(1);
  expect(await store.get(scope, extracted.media[0].ref)).toMatchObject({
    bytes: new Uint8Array([1, 2, 3]),
    mimeType: 'video/mp4',
    type: 'video',
  });

  await store.put(scope, {
    artifactId: 'replacement-video',
    bytes: new Uint8Array([9, 9, 9]),
    mimeType: 'video/mp4',
    name: 'replacement.mp4',
    type: 'video',
  });
  const fill = operations.find(
    (operation) => operation.name === 'presentation.template.fillNative',
  )!;
  const output = (await fill.execute(
    {
      patches: [{ mediaRef: 'replacement-video', page: 1, shapeId: '7' }],
      templateId: profile.templateId,
      versionId: profile.versionId,
    },
    { scope },
  )) as { artifactId: string };
  const artifact = await store.get(scope, output.artifactId);
  const files = unzipSync(artifact!.bytes!);
  expect(strFromU8(files['ppt/slides/slide1.xml'])).toContain('<p:timing>KEEP</p:timing>');
  expect(strFromU8(files['ppt/slides/_rels/slide1.xml.rels'])).toMatch(
    /Id="video"[^>]*Target="\.\.\/media\/cordis-[a-f\d]+\.mp4"/u,
  );
  const replacement = Object.entries(files).find(([path]) => /cordis-.*\.mp4$/u.test(path));
  expect(replacement?.[1]).toEqual(new Uint8Array([9, 9, 9]));
});
