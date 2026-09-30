/** Read-only visual inspection of a saved plan through the current native renderers. */
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { FilePresentationStorage } from '../src/server/runtime/presentation/file-storage';
import {
  renderSemanticBlocks,
  semanticAuthoringSvg,
} from '../src/server/runtime/presentation/semantic-blocks';
import { presentationImageRefs } from '../src/server/runtime/presentation/revision-assets';

const root = path.resolve(process.argv[2]);
const saved = JSON.parse(await readFile(path.join(root, 'result.json'), 'utf8'));
const store = new FilePresentationStorage(path.join(root, 'storage'));
const scope = { userId: 'local-presentation-validation', sessionId: path.basename(root) };
const directory = path.join(root, 'current-renderer-preview');
await mkdir(directory, { recursive: true });
for (const slide of saved.plan.slides) {
  try {
    let svg = (
      await renderSemanticBlocks(
        semanticAuthoringSvg(slide.svg, slide.metadata?.contentBlocks),
        slide.metadata?.contentBlocks,
      )
    ).svg;
    for (const ref of presentationImageRefs(svg)) {
      if (ref.startsWith('data:')) continue;
      const match = /^\/api\/runtime\/presentation\/artifacts\/([^?]+)(?:\?raw=true)?$/u.exec(ref);
      if (!match) throw new Error('Unowned image');
      const asset = await store.get(scope, decodeURIComponent(match[1]));
      if (!asset?.bytes) throw new Error('Missing owned asset');
      svg = svg.replaceAll(
        ref,
        `data:${asset.mimeType};base64,${Buffer.from(asset.bytes).toString('base64')}`,
      );
    }
    const file = path.join(directory, `${slide.slideId}.png`);
    await sharp(Buffer.from(svg)).resize(1280).png().toFile(file);
    console.log(JSON.stringify({ slide: slide.slideId, file }));
  } catch (error) {
    console.log(JSON.stringify({ slide: slide.slideId, error: String(error) }));
    process.exitCode = 1;
  }
}
