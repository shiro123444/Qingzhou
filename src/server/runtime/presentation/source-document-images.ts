import { createHash } from 'node:crypto';
import path from 'node:path';

import { strFromU8, unzipSync } from 'fflate';
import sharp from 'sharp';

import { parseString } from '../../../../packages/file-loaders/src/utils/parser-utils';
import type {
  PresentationJobInput,
  RuntimeScope,
} from '../../../../packages/runtime-contracts/src';
import type { PresentationArtifactStore } from './artifact-store';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/** Preserve original Word figures as owned reusable assets alongside parsed text. */
export async function attachSourceDocumentImages(
  input: PresentationJobInput,
  context: { store: PresentationArtifactStore; scope: RuntimeScope; signal?: AbortSignal },
): Promise<PresentationJobInput> {
  const references = input.options?.references;
  if (!Array.isArray(references)) return input;
  const visuals: { ref: string; sourceId: string; caption: string }[] = [];
  let totalBytes = 0;
  for (const reference of references.slice(0, 8)) {
    if (
      !reference ||
      typeof reference !== 'object' ||
      typeof reference.name !== 'string' ||
      !reference.name.toLowerCase().endsWith('.docx')
    )
      continue;
    const sourceId = reference.url ?? reference.id;
    if (typeof sourceId !== 'string' || !sourceId.startsWith('attachment-')) continue;
    context.signal?.throwIfAborted();
    const source = await context.store.get(context.scope, sourceId);
    if (!source?.bytes || source.bytes.length > MAX_TOTAL_BYTES) continue;
    const files = unzipSync(source.bytes, {
      filter: (entry) => {
        if (/^word\/media\/[^/]+\.(?:png|jpe?g|webp)$/iu.test(entry.name))
          return entry.originalSize <= MAX_IMAGE_BYTES;
        return (
          ['word/document.xml', 'word/_rels/document.xml.rels'].includes(entry.name) &&
          entry.originalSize <= 2 * 1024 * 1024
        );
      },
    });
    if (!files['word/document.xml'] || !files['word/_rels/document.xml.rels']) continue;
    const document = parseString(strFromU8(files['word/document.xml']));
    const relationships = parseString(strFromU8(files['word/_rels/document.xml.rels']));
    const targets = new Map(
      Array.from(relationships.getElementsByTagName('Relationship'))
        .filter((node) => node.getAttribute('TargetMode') !== 'External')
        .map((node) => [
          node.getAttribute('Id'),
          path.posix.normalize(path.posix.join('word', node.getAttribute('Target') || '')),
        ]),
    );
    const paragraphs = Array.from(document.getElementsByTagName('w:p'));
    for (let index = 0; index < paragraphs.length && visuals.length < 12; index++) {
      const paragraph = paragraphs[index];
      const nearby = paragraphs
        .slice(Math.max(0, index - 1), index + 2)
        .map((node) =>
          Array.from(node.getElementsByTagName('w:t'))
            .map((text) => text.textContent || '')
            .join(''),
        )
        .filter(Boolean)
        .join(' ')
        .slice(0, 180);
      for (const blip of Array.from(paragraph.getElementsByTagName('a:blip'))) {
        const target = targets.get(blip.getAttribute('r:embed'));
        if (
          !target ||
          !/^word\/media\/[^/]+$/u.test(target) ||
          !files[target] ||
          visuals.length >= 12
        )
          continue;
        const bytes = files[target];
        if (totalBytes + bytes.length > MAX_TOTAL_BYTES) continue;
        const mimeType = MIME[path.posix.extname(target).toLowerCase()];
        if (!mimeType) continue;
        context.signal?.throwIfAborted();
        const metadata = await sharp(bytes, { limitInputPixels: 32_000_000 }).metadata();
        const ref = `document-image-${createHash('sha256').update(sourceId).update(target).update(bytes).digest('hex').slice(0, 40)}`;
        if (visuals.some((visual) => visual.ref === ref)) continue;
        const caption = nearby || `原文图表 ${visuals.length + 1}`;
        if (!(await context.store.get(context.scope, ref)))
          await context.store.put(context.scope, {
            artifactId: ref,
            bytes,
            type: 'image',
            mimeType,
            name: `原文图表${visuals.length + 1}：${caption.slice(0, 100)}`,
            metadata: {
              sourceId,
              sourceName: reference.name,
              sourcePart: target,
              caption,
              width: metadata.width,
              height: metadata.height,
              origin: 'document',
            },
          });
        visuals.push({ ref, sourceId, caption });
        totalBytes += bytes.length;
      }
    }
  }
  if (!visuals.length) return input;
  const existing = Array.isArray(input.options?.availableAssetRefs)
    ? input.options.availableAssetRefs.filter((ref): ref is string => typeof ref === 'string')
    : [];
  return {
    ...input,
    options: {
      ...input.options,
      availableAssetRefs: [...new Set([...existing, ...visuals.map((visual) => visual.ref)])],
      sourceDocumentVisuals: visuals,
    },
  };
}
