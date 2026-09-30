import { createHash } from 'node:crypto';
import nodePath from 'node:path';

import { XMLValidator } from 'fast-xml-parser';
import { strFromU8, strToU8, unzipSync, type Zippable, zipSync } from 'fflate';

import { PRESENTATION_PPTX_MAX_UPLOAD_BYTES } from '../../../../../packages/runtime-contracts/src';

const MAX_NATIVE_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const MAX_NATIVE_ENTRY_BYTES = 256 * 1024 * 1024;

const fail = (message: string) =>
  Object.assign(new Error(message), { code: 'PRESENTATION_INVALID' });
const escape = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const decode = (text: string) =>
  text
    .replaceAll(/&#(?:x([\da-f]+)|(\d+));/gi, (_, hex, dec) =>
      String.fromCodePoint(parseInt(hex ?? dec, hex ? 16 : 10)),
    )
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
const attribute = (xml: string, name: string) =>
  new RegExp(`\\b${name}=["']([^"']*)["']`).exec(xml)?.[1];
export function openNativePptx(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > PRESENTATION_PPTX_MAX_UPLOAD_BYTES)
    throw fail('Native PPTX exceeds upload budget');
  let size = 0;
  let count = 0;
  const files = unzipSync(bytes, {
    filter: (entry) => {
      size += entry.originalSize;
      if (
        ++count > 5000 ||
        size > MAX_NATIVE_UNCOMPRESSED_BYTES ||
        entry.originalSize > MAX_NATIVE_ENTRY_BYTES ||
        entry.name.split('/').includes('..') ||
        entry.name.startsWith('/')
      )
        throw fail('Invalid native PPTX archive');
      return true;
    },
  });
  if (!files['ppt/presentation.xml'] || !files['[Content_Types].xml'])
    throw fail('Invalid native PPTX');
  return files;
}
function relationships(files: Record<string, Uint8Array>, path: string) {
  const relPath = nodePath.posix.join(
    nodePath.posix.dirname(path),
    '_rels',
    nodePath.posix.basename(path) + '.rels',
  );
  return {
    path: relPath,
    xml: files[relPath]
      ? strFromU8(files[relPath])
      : '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
  };
}
function slidePaths(files: Record<string, Uint8Array>) {
  const rel = relationships(files, 'ppt/presentation.xml').xml;
  const mapping = new Map(
    [...rel.matchAll(/<Relationship\b[^>]*>/g)]
      .filter((m) => !m[0].includes('TargetMode="External"'))
      .map((m) => [
        attribute(m[0], 'Id'),
        (attribute(m[0], 'Target') ?? '').startsWith('/')
          ? (attribute(m[0], 'Target') ?? '').slice(1)
          : nodePath.posix.normalize(nodePath.posix.join('ppt', attribute(m[0], 'Target') ?? '')),
      ]),
  );
  return [...strFromU8(files['ppt/presentation.xml']).matchAll(/<(?:p:)?sldId\b[^>]*>/g)]
    .map((m) => mapping.get(attribute(m[0], 'r:id')))
    .filter((path): path is string => !!path && !!files[path]);
}
function shapes(xml: string) {
  return [...xml.matchAll(/<p:(sp|pic|graphicFrame)\b[\s\S]*?<\/p:\1>/g)].map((match) => {
    const nonVisual = /<p:cNvPr\b[^>]*>/.exec(match[0])?.[0] ?? '';
    const mediaRelationships = [
      ...match[0].matchAll(/<(a:videoFile|a:audioFile|p14:media)\b[^>]*>/g),
    ].flatMap((entry) => {
      const relationshipId = attribute(entry[0], 'r:embed') ?? attribute(entry[0], 'r:link');
      if (!relationshipId) return [];
      return [
        {
          kind:
            entry[1] === 'a:videoFile' ? 'video' : entry[1] === 'a:audioFile' ? 'audio' : 'media',
          relationshipId,
        } as const,
      ];
    });
    return {
      id: attribute(nonVisual, 'id') ?? '',
      name: decode(attribute(nonVisual, 'name') ?? ''),
      kind: match[1],
      source: match[0],
      start: match.index!,
      runs: [...match[0].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((run) =>
        decode(run[1]),
      ),
      relationshipId: attribute(/<a:blip\b[^>]*>/.exec(match[0])?.[0] ?? '', 'r:embed'),
      mediaRelationships,
    };
  });
}
export function inspectNativePptx(bytes: Uint8Array) {
  const files = openNativePptx(bytes);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    pages: slidePaths(files).map((path, index) => ({
      page: index + 1,
      path,
      contentKinds: [
        ...(/<(?:m:oMath|a14:m|p:oleObj)\b/u.test(strFromU8(files[path]))
          ? ['formula-or-embedded-object']
          : []),
        ...(/<c:chart\b/u.test(strFromU8(files[path])) ? ['chart'] : []),
        ...(/<a:tbl\b/u.test(strFromU8(files[path])) ? ['table'] : []),
        ...(/<(?:p:cxnSp|dgm:relIds)\b/u.test(strFromU8(files[path])) ? ['diagram'] : []),
        ...(shapes(strFromU8(files[path])).filter((shape) => shape.kind === 'pic').length
          ? ['image']
          : []),
        ...(shapes(strFromU8(files[path]))
          .flatMap((shape) => shape.runs)
          .join('').length > 400
          ? ['dense-text']
          : ['sparse-text']),
      ],
      shapes: shapes(strFromU8(files[path])).map(
        ({ source: _source, start: _start, ...shape }) => ({
          ...shape,
          editable: shape.kind === 'sp' || shape.kind === 'pic',
        }),
      ),
    })),
    preservedParts: {
      masters: Object.keys(files).filter((p) => /^ppt\/slideMasters\/[^/]+\.xml$/.test(p)).length,
      charts: Object.keys(files).filter((p) => /^ppt\/charts\/[^/]+\.xml$/.test(p)).length,
      media: Object.keys(files).filter((p) => p.startsWith('ppt/media/')).length,
    },
    strategy: 'native-object-patching',
  };
}
export interface NativeTemplatePatch {
  image?: { bytes: Uint8Array; mimeType: string };
  media?: { bytes: Uint8Array; kind: 'audio' | 'video'; mimeType: string };
  page: number;
  runs?: string[];
  shapeId: string;
  text?: string;
}
export function fillNativePptx(bytes: Uint8Array, patches: NativeTemplatePatch[]) {
  if (!patches.length || patches.length > 100) throw fail('Provide 1 to 100 native object patches');
  const files = openNativePptx(bytes);
  const paths = slidePaths(files);
  const touched = new Set<string>();
  const changedParts = new Set<string>();
  for (const patch of patches) {
    const path = paths[patch.page - 1];
    if (!path) throw fail('Native page not found');
    const xml = strFromU8(files[path]);
    const matches = shapes(xml).filter((shape) => shape.id === patch.shapeId);
    if (matches.length !== 1) throw fail('Native shape id is missing or ambiguous');
    const key = `${patch.page}:${patch.shapeId}`;
    if (touched.has(key)) throw fail('Native object patched twice');
    touched.add(key);
    const shape = matches[0];
    let replacement = shape.source;
    let slideChanged = false;
    if (patch.image) {
      if (
        patch.media ||
        patch.text !== undefined ||
        patch.runs ||
        shape.kind !== 'pic' ||
        !shape.relationshipId
      )
        throw fail('Image patch requires a native picture');
      const extension = (
        { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as Record<string, string>
      )[patch.image.mimeType];
      if (!extension) throw fail('Unsupported native image type');
      const digest = createHash('sha256').update(patch.image.bytes).digest('hex').slice(0, 32);
      const media = `ppt/media/cordis-${digest}.${extension}`;
      files[media] = new Uint8Array(patch.image.bytes);
      changedParts.add(media);
      const rel = relationships(files, path);
      const relId = `rIdCordis${digest}${patch.shapeId}`;
      if (rel.xml.includes(`Id="${relId}"`)) throw fail('Native relationship collision');
      const relEntry = `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${nodePath.posix.relative(nodePath.posix.dirname(path), media)}"/>`;
      files[rel.path] = strToU8(
        rel.xml.replace(/<\/Relationships\s*>/, relEntry + '</Relationships>'),
      );
      changedParts.add(rel.path);
      replacement = replacement.replace(
        new RegExp(`r:embed=["']${shape.relationshipId}["']`),
        `r:embed="${relId}"`,
      );
      slideChanged = true;
      const types = strFromU8(files['[Content_Types].xml']);
      if (!types.includes(`Extension="${extension}"`)) {
        files['[Content_Types].xml'] = strToU8(
          types.replace(
            '</Types>',
            `<Default Extension="${extension}" ContentType="${patch.image.mimeType}"/></Types>`,
          ),
        );
        changedParts.add('[Content_Types].xml');
      }
    } else if (patch.media) {
      if (patch.text !== undefined || patch.runs || shape.kind !== 'pic')
        throw fail('Media patch requires a native media picture');
      const extensions: Record<string, { extension: string; kind: 'audio' | 'video' }> = {
        'audio/aac': { extension: 'aac', kind: 'audio' },
        'audio/mp4': { extension: 'm4a', kind: 'audio' },
        'audio/mpeg': { extension: 'mp3', kind: 'audio' },
        'audio/ogg': { extension: 'ogg', kind: 'audio' },
        'audio/wav': { extension: 'wav', kind: 'audio' },
        'video/mp4': { extension: 'mp4', kind: 'video' },
        'video/mpeg': { extension: 'mpeg', kind: 'video' },
        'video/quicktime': { extension: 'mov', kind: 'video' },
        'video/webm': { extension: 'webm', kind: 'video' },
        'video/x-m4v': { extension: 'm4v', kind: 'video' },
        'video/x-ms-wmv': { extension: 'wmv', kind: 'video' },
        'video/x-msvideo': { extension: 'avi', kind: 'video' },
      };
      const mediaType = extensions[patch.media.mimeType];
      if (!mediaType || mediaType.kind !== patch.media.kind)
        throw fail('Unsupported native media type');
      if (!patch.media.bytes.length || patch.media.bytes.length > MAX_NATIVE_ENTRY_BYTES)
        throw fail('Native replacement media exceeds the entry budget');
      const relationshipIds = new Set(
        shape.mediaRelationships
          .filter((entry) => entry.kind === patch.media!.kind || entry.kind === 'media')
          .map((entry) => entry.relationshipId),
      );
      if (!relationshipIds.size) throw fail('Native media relationship is missing');
      const digest = createHash('sha256').update(patch.media.bytes).digest('hex').slice(0, 32);
      const media = `ppt/media/cordis-${digest}.${mediaType.extension}`;
      files[media] = new Uint8Array(patch.media.bytes);
      changedParts.add(media);
      const rel = relationships(files, path);
      let replacements = 0;
      const target = nodePath.posix.relative(nodePath.posix.dirname(path), media);
      const updatedRelationships = rel.xml.replaceAll(/<Relationship\b[^>]*\/>/g, (entry) => {
        const id = attribute(entry, 'Id');
        if (!id || !relationshipIds.has(id)) return entry;
        if (attribute(entry, 'TargetMode') === 'External')
          throw fail('External media relationships cannot be replaced');
        const type = attribute(entry, 'Type')?.split('/').at(-1);
        if (!['audio', 'media', 'video'].includes(type ?? ''))
          throw fail('Native media relationship type is invalid');
        replacements++;
        return /\bTarget=["'][^"']*["']/u.test(entry)
          ? entry.replace(/\bTarget=["'][^"']*["']/u, `Target="${target}"`)
          : entry.replace('/>', ` Target="${target}"/>`);
      });
      if (replacements !== relationshipIds.size)
        throw fail('Native media relationship is missing or ambiguous');
      files[rel.path] = strToU8(updatedRelationships);
      changedParts.add(rel.path);
      const types = strFromU8(files['[Content_Types].xml']);
      if (!types.includes(`Extension="${mediaType.extension}"`)) {
        files['[Content_Types].xml'] = strToU8(
          types.replace(
            '</Types>',
            `<Default Extension="${mediaType.extension}" ContentType="${patch.media.mimeType}"/></Types>`,
          ),
        );
        changedParts.add('[Content_Types].xml');
      }
    } else {
      if (
        shape.kind !== 'sp' ||
        !shape.runs.length ||
        (patch.text === undefined && !patch.runs) ||
        (patch.text !== undefined && patch.runs)
      )
        throw fail('Text patch requires one text or runs field');
      if (patch.runs && patch.runs.length !== shape.runs.length)
        throw fail('Native rich-text run count must be preserved');
      let index = 0;
      replacement = replacement.replaceAll(
        /(<a:t(?:\s[^>]*)?>)[\s\S]*?(<\/a:t>)/g,
        (_, start, end) =>
          `${start}${escape(patch.runs ? patch.runs[index++] : index++ === 0 ? patch.text! : '')}${end}`,
      );
      slideChanged = true;
    }
    if (slideChanged) {
      const updated =
        xml.slice(0, shape.start) + replacement + xml.slice(shape.start + shape.source.length);
      if (XMLValidator.validate(updated) !== true) throw fail('Native patch produced invalid XML');
      files[path] = strToU8(updated);
      changedParts.add(path);
    }
  }
  const archive: Zippable = {};
  for (const [path, data] of Object.entries(files))
    archive[path] = path.startsWith('ppt/media/') ? [data, { level: 0 }] : data;
  const output = zipSync(archive, { level: 6, mtime: new Date('1980-01-01T00:00:00Z') });
  return { bytes: output, changedParts: [...changedParts], inspection: inspectNativePptx(output) };
}
