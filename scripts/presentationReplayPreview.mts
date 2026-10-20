/** Render owned replay SVG artifacts locally; never fetch external image URLs. */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(process.argv[2] ?? '');
if (!root.includes('/.data/presentation-replays/')) throw new Error('Expected a replay directory');
const storage = path.join(root, 'storage');
const [owner] = await readdir(storage);
const directory = path.join(storage, owner, 'artifacts');
const artifacts = await Promise.all(
  (await readdir(directory))
    .filter((f) => f.endsWith('.json'))
    .map(async (f) => JSON.parse(await readFile(path.join(directory, f), 'utf8'))),
);
const refs = new Map(artifacts.map((a) => [a.artifactId, a]));
for (const artifact of artifacts.filter(
  (a) => a.artifactId.startsWith('image-') && a.base64 && a.mimeType.startsWith('image/'),
)) {
  const target = path.join(root, `${artifact.artifactId.replace(/[^\w-]/g, '_')}.png`);
  await sharp(Buffer.from(artifact.base64, 'base64')).png().toFile(target);
  console.log(JSON.stringify({ generatedAsset: artifact.artifactId, target }));
}
for (const artifact of artifacts.filter((a) => a.mimeType === 'image/svg+xml' && a.base64)) {
  let svg = Buffer.from(artifact.base64, 'base64').toString('utf8');
  svg = svg.replace(/(?:xlink:)?href="([^"]+)"/g, (match, ref) => {
    const id = decodeURIComponent(ref.split('/').at(-1)!.split('?')[0]);
    const owned = refs.get(id);
    return owned?.base64 ? `href="data:${owned.mimeType};base64,${owned.base64}"` : match;
  });
  const name = artifact.artifactId.replace(/[^\w-]/g, '_');
  const target = path.join(root, `${name}.png`);
  await sharp(Buffer.from(svg)).resize(1280).png().toFile(target);
  console.log(JSON.stringify({ artifactId: artifact.artifactId, target }));
}
