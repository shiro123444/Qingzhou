import nodePath from 'node:path';

import { strFromU8, unzipSync } from 'fflate';

import {
  PRESENTATION_PPTX_MAX_UPLOAD_BYTES,
  PRESENTATION_PPTX_MAX_UPLOAD_MIB,
} from '../../../../../packages/runtime-contracts/src';
import { constraintsFromLayouts, layoutKind } from './extract';
import type {
  TemplateAssetSlot,
  TemplateBox,
  TemplateConstraints,
  TemplateElement,
  TemplateLayout,
  TemplateMediaReference,
} from './types';
import { PresentationTemplateError } from './types';
import {
  array,
  attribute,
  descendants,
  escapeXml,
  number,
  object,
  textContent,
  type Xml,
  xml,
} from './xml';

const MAX_XML = 64 * 1024 * 1024;
const MAX_ARCHIVE_UNCOMPRESSED = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY = 256 * 1024 * 1024;
const round = (value: number): number => Math.round(value * 10_000) / 10_000;
const embeddedMedia = (path: string): { kind: 'audio' | 'video'; mimeType?: string } | null => {
  const extension = nodePath.posix.extname(path).toLowerCase();
  const videos: Record<string, string> = {
    '.avi': 'video/x-msvideo',
    '.m4v': 'video/x-m4v',
    '.mov': 'video/quicktime',
    '.mp4': 'video/mp4',
    '.mpeg': 'video/mpeg',
    '.mpg': 'video/mpeg',
    '.webm': 'video/webm',
    '.wmv': 'video/x-ms-wmv',
  };
  const audio: Record<string, string> = {
    '.aac': 'audio/aac',
    '.m4a': 'audio/mp4',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.wma': 'audio/x-ms-wma',
  };
  if (videos[extension]) return { kind: 'video', mimeType: videos[extension] };
  if (audio[extension]) return { kind: 'audio', mimeType: audio[extension] };
  return null;
};

interface Relationship {
  id: string;
  path: string;
  type: string;
}
interface Theme {
  colors: Record<string, string>;
  fonts: Record<string, string>;
}
interface Transform {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
}

/** Read OOXML as data only. Embedded programs, external relations and macros are never executed. */
export const extractPptxTemplate = (
  bytes: Uint8Array,
): {
  constraints: TemplateConstraints;
  layouts: TemplateLayout[];
  media: TemplateMediaReference[];
  warnings: string[];
} => {
  if (!bytes.byteLength || bytes.byteLength > PRESENTATION_PPTX_MAX_UPLOAD_BYTES)
    throw new PresentationTemplateError(
      `PPTX upload must be between 1 byte and ${PRESENTATION_PPTX_MAX_UPLOAD_MIB} MiB`,
    );
  let archiveTotal = 0;
  let xmlTotal = 0;
  let count = 0;
  const mediaEntries = new Map<
    string,
    { kind: 'audio' | 'video'; mimeType?: string; sizeBytes: number }
  >();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (entry) => {
        if (++count > 5000) throw new PresentationTemplateError('PPTX has too many entries');
        if (entry.name.split('/').includes('..') || entry.name.startsWith('/'))
          throw new PresentationTemplateError('PPTX contains an invalid entry path');
        archiveTotal += entry.originalSize;
        if (entry.originalSize > MAX_ARCHIVE_ENTRY || archiveTotal > MAX_ARCHIVE_UNCOMPRESSED)
          throw new PresentationTemplateError('PPTX expanded content exceeds the import budget');
        const media = /^ppt\/media\/[^/]+$/u.test(entry.name) ? embeddedMedia(entry.name) : null;
        if (media)
          mediaEntries.set(entry.name, {
            ...media,
            sizeBytes: entry.originalSize,
          });
        if (
          !/^(?:ppt\/|\[Content_Types\]\.xml$)/u.test(entry.name) ||
          !/\.(?:xml|rels)$/u.test(entry.name)
        )
          return false;
        xmlTotal += entry.originalSize;
        if (entry.originalSize > 8 * 1024 * 1024 || xmlTotal > MAX_XML)
          throw new PresentationTemplateError('PPTX XML exceeds the import budget');
        return true;
      },
    });
  } catch (error) {
    if (error instanceof PresentationTemplateError) throw error;
    throw new PresentationTemplateError('Upload is not a readable PPTX archive');
  }
  const read = (path: string): Xml => (files[path] ? xml(strFromU8(files[path])) : {});
  const presentation = object(read('ppt/presentation.xml').presentation);
  if (!Object.keys(presentation).length)
    throw new PresentationTemplateError('PPTX presentation.xml is missing');
  const warnings = new Set<string>([
    'Imported reference SVGs approximate native PPTX shapes; the original PPTX is retained for native template filling.',
  ]);
  const relationships = (path: string): Relationship[] => {
    const relPath = nodePath.posix.join(
      nodePath.posix.dirname(path),
      '_rels',
      `${nodePath.posix.basename(path)}.rels`,
    );
    return array(object(read(relPath).Relationships).Relationship).flatMap((relation) => {
      if (attribute(relation, 'TargetMode') === 'External') {
        warnings.add('External PPTX relationships were ignored.');
        return [];
      }
      const target = attribute(relation, 'Target') ?? '';
      const resolved = target.startsWith('/')
        ? target.slice(1)
        : nodePath.posix.normalize(nodePath.posix.join(nodePath.posix.dirname(path), target));
      if (!resolved.startsWith('ppt/')) return [];
      return [
        {
          id: attribute(relation, 'Id') ?? '',
          path: resolved,
          type: attribute(relation, 'Type')?.split('/').at(-1) ?? '',
        },
      ];
    });
  };
  const presentationRelations = relationships('ppt/presentation.xml');
  const slidePaths = array(object(presentation.sldIdLst).sldId)
    .map((slide) => {
      const id = attribute(slide, 'relationshipId');
      return presentationRelations.find(
        (relation) => relation.id === id && relation.type === 'slide',
      )?.path;
    })
    .filter((path): path is string => Boolean(path));
  if (!slidePaths.length || slidePaths.length > 100)
    throw new PresentationTemplateError('PPTX must contain between 1 and 100 slides');
  const size = object(presentation.sldSz);
  const width = number(attribute(size, 'cx'), 9_144_000);
  const height = number(attribute(size, 'cy'), 5_143_500);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 2_147_483_647 ||
    height > 2_147_483_647
  )
    throw new PresentationTemplateError('PPTX slide dimensions are invalid');
  const svgHeight = (960 * height) / width;
  const ratio =
    Math.abs(width / height - 16 / 9) < 0.01
      ? '16:9'
      : Math.abs(width / height - 4 / 3) < 0.01
        ? '4:3'
        : `${width}:${height}`;
  const allColors: string[] = [];
  const allFonts: string[] = [];
  const media: TemplateMediaReference[] = [];
  const themes = new Map<string, Theme>();
  const themeFor = (path?: string): Theme => {
    if (!path) return { colors: {}, fonts: {} };
    const cached = themes.get(path);
    if (cached) return cached;
    const elements = object(object(read(path).theme).themeElements);
    const colors: Record<string, string> = {};
    for (const [name, value] of Object.entries(object(elements.clrScheme))) {
      const child = object(value);
      const color =
        attribute(object(child.srgbClr), 'val') ?? attribute(object(child.sysClr), 'lastClr');
      if (color && /^[\da-f]{6}$/iu.test(color)) colors[name] = `#${color.toUpperCase()}`;
    }
    const scheme = object(elements.fontScheme);
    const fonts: Record<string, string> = {};
    for (const [prefix, fontType] of [
      ['mj', 'majorFont'],
      ['mn', 'minorFont'],
    ]) {
      for (const [suffix, script] of [
        ['lt', 'latin'],
        ['ea', 'ea'],
        ['cs', 'cs'],
      ]) {
        const face = attribute(object(object(scheme[fontType])[script]), 'typeface');
        if (face) fonts[`+${prefix}-${suffix}`] = face;
      }
    }
    allColors.push(...Object.values(colors));
    allFonts.push(...Object.values(fonts));
    const theme = { colors, fonts };
    themes.set(path, theme);
    return theme;
  };
  const colorFrom = (node: unknown, theme: Theme, colorMap: Xml): string | undefined => {
    const rgb = descendants(node, 'srgbClr')[0];
    const value = rgb ? attribute(rgb, 'val') : undefined;
    if (value && /^[\da-f]{6}$/iu.test(value)) return `#${value.toUpperCase()}`;
    const scheme = descendants(node, 'schemeClr')[0];
    const key = scheme ? attribute(scheme, 'val') : undefined;
    return key ? theme.colors[attribute(colorMap, key) ?? key] : undefined;
  };
  const placeholder = (shape: Xml): Xml => descendants(shape, 'ph')[0] ?? {};
  const shapeTree = (document: Xml): Xml => object(object(document.cSld).spTree);
  const layouts = slidePaths.map((path, index): TemplateLayout => {
    const relations = relationships(path);
    const slide = object(read(path).sld);
    const layoutPath = relations.find((relation) => relation.type === 'slideLayout')?.path;
    const layout = layoutPath ? object(read(layoutPath).sldLayout) : {};
    const masterPath = layoutPath
      ? relationships(layoutPath).find((relation) => relation.type === 'slideMaster')?.path
      : undefined;
    const master = masterPath ? object(read(masterPath).sldMaster) : {};
    const themePath = masterPath
      ? relationships(masterPath).find((relation) => relation.type === 'theme')?.path
      : presentationRelations.find((relation) => relation.type === 'theme')?.path;
    const theme = themeFor(themePath);
    const colorMap = object(master.clrMap);
    const elements: TemplateElement[] = [];
    const assetSlots: TemplateAssetSlot[] = [];
    const sourceSlideId = `slide-${index + 1}`;
    const content: string[] = [];
    const background =
      colorFrom(
        object(slide.cSld).bg ?? object(layout.cSld).bg ?? object(master.cSld).bg,
        theme,
        colorMap,
      ) ?? '#FFFFFF';
    allColors.push(background);
    content.push(`<rect width="960" height="${round(svgHeight)}" fill="${background}"/>`);
    const candidates = [...array(shapeTree(layout).sp), ...array(shapeTree(master).sp)];
    const inheritedShape = (shape: Xml): Xml => {
      const ph = placeholder(shape);
      if (!Object.keys(ph).length) return {};
      return (
        candidates.find((candidate) => {
          const other = placeholder(candidate);
          return attribute(ph, 'idx') !== undefined
            ? attribute(ph, 'idx') === attribute(other, 'idx')
            : (attribute(ph, 'type') ?? 'body') === (attribute(other, 'type') ?? 'body');
        }) ?? {}
      );
    };
    const visit = (tree: Xml, transform: Transform): void => {
      for (const [kind, raw] of Object.entries(tree)) {
        if (!['sp', 'pic', 'graphicFrame', 'grpSp', 'cxnSp'].includes(kind)) continue;
        for (const shape of array(raw)) {
          if (kind === 'grpSp') {
            const xfrm = object(object(shape.grpSpPr).xfrm);
            const off = object(xfrm.off),
              ext = object(xfrm.ext),
              childOff = object(xfrm.chOff),
              childExt = object(xfrm.chExt);
            const sx =
              number(attribute(ext, 'cx'), 1) / (number(attribute(childExt, 'cx'), 1) || 1);
            const sy =
              number(attribute(ext, 'cy'), 1) / (number(attribute(childExt, 'cy'), 1) || 1);
            visit(shape, {
              sx: transform.sx * sx,
              sy: transform.sy * sy,
              tx:
                transform.tx +
                (number(attribute(off, 'x')) - number(attribute(childOff, 'x')) * sx) *
                  transform.sx,
              ty:
                transform.ty +
                (number(attribute(off, 'y')) - number(attribute(childOff, 'y')) * sy) *
                  transform.sy,
            });
            continue;
          }
          const inherited = inheritedShape(shape);
          const ownXfrm = object(shape.spPr).xfrm ?? shape.xfrm;
          const xfrm = object(ownXfrm ?? object(inherited.spPr).xfrm);
          const off = object(xfrm.off),
            ext = object(xfrm.ext);
          if (!Object.keys(ext).length) {
            warnings.add(
              'Objects without explicit or inherited geometry were omitted from the learned layout.',
            );
            continue;
          }
          if (attribute(xfrm, 'rot'))
            warnings.add('Rotated PPTX shapes have approximate learned bounding boxes.');
          const box: TemplateBox = {
            height: round((number(attribute(ext, 'cy')) * transform.sy) / height),
            width: round((number(attribute(ext, 'cx')) * transform.sx) / width),
            x: round((number(attribute(off, 'x')) * transform.sx + transform.tx) / width),
            y: round((number(attribute(off, 'y')) * transform.sy + transform.ty) / height),
          };
          const relationIds = new Set(
            ['videoFile', 'audioFile', 'media'].flatMap((tag) =>
              descendants(shape, tag).flatMap((node) =>
                [attribute(node, 'link'), attribute(node, 'embed')].filter((id): id is string =>
                  Boolean(id),
                ),
              ),
            ),
          );
          const shapeMedia = relations.filter(
            (relation) => relationIds.has(relation.id) && mediaEntries.has(relation.path),
          );
          const text = textContent(shape.txBody).trim();
          const runProperties =
            descendants(shape.txBody, 'rPr')[0] ??
            descendants(shape.txBody, 'defRPr')[0] ??
            descendants(inherited.txBody, 'defRPr')[0] ??
            descendants(master.txStyles, 'defRPr')[0] ??
            {};
          const fontSize = round(
            (number(attribute(runProperties, 'sz'), 2400) * 127 * 960) / width,
          );
          const latin =
            descendants(runProperties, 'latin')[0] ?? descendants(shape.txBody, 'latin')[0];
          const requestedFont = latin ? attribute(latin, 'typeface') : undefined;
          const fontFamily = requestedFont
            ? (theme.fonts[requestedFont] ?? requestedFont)
            : (theme.fonts['+mn-lt'] ?? 'Arial');
          const fill =
            colorFrom(text ? runProperties : shape.spPr, theme, colorMap) ??
            (text ? '#222222' : '#E8EBEF');
          const phType = attribute(placeholder(shape), 'type');
          const role =
            kind === 'pic'
              ? 'image'
              : text
                ? ['title', 'ctrTitle'].includes(phType ?? '')
                  ? 'title'
                  : 'body'
                : 'decoration';
          elements.push({
            box,
            color: fill,
            ...(text ? { fontFamily, fontSize, textCapacity: [...text].length } : {}),
            kind: kind === 'pic' ? 'image' : text ? 'text' : 'shape',
            role,
          });
          const blip = descendants(shape, 'blip')[0] ?? {};
          const poster = relations.find((relation) => relation.id === attribute(blip, 'embed'));
          if (kind === 'pic') {
            assetSlots.push({
              aspectRatio: round((box.width * width) / Math.max(1, box.height * height)),
              box,
              fit: descendants(shape, 'srcRect').length ? 'cover' : 'contain',
              reference: poster ? `pptx:${poster.path}` : undefined,
              slotId: `${sourceSlideId}:image:${assetSlots.length + 1}`,
            });
          }
          for (const relation of shapeMedia) {
            const entry = mediaEntries.get(relation.path)!;
            media.push({
              box,
              kind: entry.kind,
              mediaId: `${sourceSlideId}:${entry.kind}:${media.length + 1}`,
              mimeType: entry.mimeType,
              page: index + 1,
              path: relation.path,
              posterReference: poster ? `pptx:${poster.path}` : undefined,
              relationshipId: relation.id,
              sizeBytes: entry.sizeBytes,
            });
          }
          const x = round(box.x * 960),
            y = round(box.y * svgHeight),
            w = round(box.width * 960),
            h = round(box.height * svgHeight);
          if (text) {
            const lines = text.split(/\r?\n/u);
            content.push(
              `<text x="${x}" y="${round(y + fontSize)}" fill="${fill}" font-family="${escapeXml(fontFamily)}" font-size="${fontSize}">${lines.map((line, lineIndex) => `<tspan x="${x}" dy="${lineIndex ? round(fontSize * 1.2) : 0}">${escapeXml(line)}</tspan>`).join('')}</text>`,
            );
          } else
            content.push(
              `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${kind === 'pic' ? '#DDE4ED' : fill}"/>`,
            );
          if (kind === 'graphicFrame')
            warnings.add(
              'Charts and tables keep their bounds; their native content remains in the original PPTX.',
            );
        }
      }
    };
    visit(shapeTree(slide), { sx: 1, sy: 1, tx: 0, ty: 0 });
    if (!elements.some((element) => element.role === 'title')) {
      const largestFont = Math.max(...elements.map((element) => element.fontSize ?? 0));
      for (const element of elements) {
        if (element.kind === 'text' && element.fontSize === largestFont && element.box.y < 0.55)
          element.role = 'title';
      }
    }
    const notesPath = relations.find((relation) => relation.type === 'notesSlide')?.path;
    const notes = notesPath
      ? textContent(object(object(read(notesPath).notes).cSld)).trim()
      : undefined;
    return {
      assetSlots,
      elements,
      kind: layoutKind(elements),
      layoutId: `layout:${sourceSlideId}`,
      notes,
      referenceSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 ${round(svgHeight)}">${content.join('')}</svg>`,
      sourceSlideId,
      textCapacity: elements.reduce((sum, element) => sum + (element.textCapacity ?? 0), 0),
    };
  });
  if (media.some((item) => item.kind === 'video'))
    warnings.add(
      'Embedded videos are preserved and sampled as visual evidence; audio content is not inferred.',
    );
  if (media.some((item) => item.kind === 'audio'))
    warnings.add(
      'Embedded audio is preserved, but its semantic content requires user confirmation.',
    );
  return {
    constraints: constraintsFromLayouts(ratio, layouts, allColors, allFonts),
    layouts,
    media,
    warnings: [...warnings],
  };
};
