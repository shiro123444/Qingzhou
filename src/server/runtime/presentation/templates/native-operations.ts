import { createHash } from 'node:crypto';

import sharp from 'sharp';
import { z } from 'zod';

import { assetIdFromRef } from '../../assets/plugin';
import type { AtomicInvocation, AtomicOperation } from '../../atomic-runtime';
import type { PresentationArtifactStore } from '../artifact-store';
import type { FilePresentationTemplateLibrary } from './library';
import {
  fillNativePptx,
  inspectNativePptx,
  type NativeTemplatePatch,
  openNativePptx,
} from './native';

export function nativeTemplateOperations(
  library: FilePresentationTemplateLibrary,
  store: PresentationArtifactStore,
): AtomicOperation[] {
  const reference = { templateId: z.string().min(1), versionId: z.string().min(1).optional() };
  const source = async (
    input: { templateId: string; versionId?: string },
    ctx: AtomicInvocation,
  ) => {
    const profile = await library.get(ctx.scope, input.templateId, input.versionId);
    if (!profile) throw new Error('Owned template not found');
    const bytes = await library.getSourcePptx(ctx.scope, {
      templateId: input.templateId,
      versionId: profile.versionId,
    });
    if (!bytes) throw new Error('This template has no native PPTX source');
    return { bytes, profile };
  };
  const save = async (
    bytes: Uint8Array,
    templateId: string,
    versionId: string,
    changedParts: string[],
    ctx: AtomicInvocation,
  ) => {
    const artifactId = `native-${createHash('sha256').update(bytes).digest('hex').slice(0, 40)}`;
    const artifact = await store.put(ctx.scope, {
      artifactId,
      bytes,
      type: 'pptx',
      name: 'native-template.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      metadata: {
        templateId,
        templateVersionId: versionId,
        changedParts,
        fidelity: 'native',
        jobId: ctx.jobId,
      },
    });
    return { artifactId, uri: artifact.uri, fidelity: 'native', changedParts };
  };
  return [
    {
      name: 'presentation.template.listNativeOutputs',
      description:
        'Recover native PPTX outputs from previous sessions for an owned template. Returns saved file references, newest first.',
      input: z.object(reference).strict(),
      execute: async (input, ctx) => {
        const profile = await library.get(ctx.scope, input.templateId, input.versionId);
        if (!profile) throw new Error('Owned template not found');
        const artifacts = (await store.list?.(ctx.scope)) ?? [];
        return {
          outputs: artifacts
            .filter(
              (artifact) =>
                artifact.type === 'pptx' &&
                artifact.metadata?.fidelity === 'native' &&
                artifact.metadata?.templateId === profile.templateId &&
                artifact.metadata?.templateVersionId === profile.versionId,
            )
            .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
            .slice(0, 20)
            .map(({ artifactId, uri, updatedAt }) => ({ artifactId, uri, updatedAt })),
        };
      },
    },
    {
      name: 'presentation.template.extractMedia',
      description:
        'Extract embedded audio and video from an owned native PPTX as reusable account-scoped artifacts. The original package is not modified.',
      input: z.object(reference).strict(),
      execute: async (input, ctx) => {
        const { bytes, profile } = await source(input, ctx);
        const files = openNativePptx(bytes);
        const mimeTypes: Record<string, { kind: 'audio' | 'video'; mimeType: string }> = {
          aac: { kind: 'audio', mimeType: 'audio/aac' },
          avi: { kind: 'video', mimeType: 'video/x-msvideo' },
          m4a: { kind: 'audio', mimeType: 'audio/mp4' },
          m4v: { kind: 'video', mimeType: 'video/x-m4v' },
          mov: { kind: 'video', mimeType: 'video/quicktime' },
          mp3: { kind: 'audio', mimeType: 'audio/mpeg' },
          mp4: { kind: 'video', mimeType: 'video/mp4' },
          mpeg: { kind: 'video', mimeType: 'video/mpeg' },
          mpg: { kind: 'video', mimeType: 'video/mpeg' },
          ogg: { kind: 'audio', mimeType: 'audio/ogg' },
          wav: { kind: 'audio', mimeType: 'audio/wav' },
          webm: { kind: 'video', mimeType: 'video/webm' },
          wmv: { kind: 'video', mimeType: 'video/x-ms-wmv' },
        };
        const media = Object.entries(files).flatMap(([path, data]) => {
          const extension = /^ppt\/media\/[^/]+\.(\w+)$/iu.exec(path)?.[1].toLowerCase();
          const type = extension ? mimeTypes[extension] : undefined;
          return type ? [{ data, path, ...type }] : [];
        });
        if (media.length > 32) throw new Error('Template has too many embedded media files');
        const outputs = [];
        for (const item of media) {
          const artifactId = `template-media-${createHash('sha256').update(item.data).digest('hex').slice(0, 32)}`;
          const existing = await store.get(ctx.scope, artifactId);
          const artifact =
            existing ??
            (await store.put(ctx.scope, {
              artifactId,
              bytes: item.data,
              type: item.kind,
              mimeType: item.mimeType,
              name: item.path.split('/').at(-1)!,
              metadata: {
                templateId: profile.templateId,
                templateVersionId: profile.versionId,
                sourcePart: item.path,
              },
            }));
          outputs.push({
            ref: artifactId,
            kind: item.kind,
            mimeType: item.mimeType,
            name: artifact.name,
            uri: artifact.uri,
          });
        }
        return { media: outputs };
      },
    },
    {
      name: 'presentation.template.extractAssets',
      description:
        'Extract native template raster images as reusable owned PNG assets, preserving their alpha and source lineage.',
      input: z.object(reference).strict(),
      execute: async (input, ctx) => {
        const { bytes, profile } = await source(input, ctx);
        const files = openNativePptx(bytes);
        const assets = [];
        const media = Object.entries(files).filter(([path]) =>
          /^ppt\/media\/.*\.(?:png|jpe?g|webp)$/i.test(path),
        );
        if (media.length > 100) throw new Error('Template has too many raster assets');
        for (const [path, data] of media) {
          const png = await sharp(data, { limitInputPixels: 16_777_216 }).png().toBuffer();
          const artifactId = `template-image-${createHash('sha256').update(png).digest('hex').slice(0, 32)}`;
          const existing = await store.get(ctx.scope, artifactId);
          const artifact =
            existing ??
            (await store.put(ctx.scope, {
              artifactId,
              bytes: new Uint8Array(png),
              type: 'image',
              mimeType: 'image/png',
              name: path.split('/').at(-1)!,
              metadata: {
                templateId: profile.templateId,
                templateVersionId: profile.versionId,
                sourcePart: path,
              },
            }));
          assets.push({ ref: artifactId, name: artifact.name, uri: artifact.uri });
        }
        return { assets };
      },
    },
    {
      name: 'presentation.template.inspectNative',
      description:
        'Inspect original PPTX objects and rich-text runs, picture relationships, charts and masters. Use shape IDs for faithful native filling; no visual reconstruction is required.',
      input: z.object(reference).strict(),
      execute: async (input, ctx) => {
        const { bytes, profile } = await source(input, ctx);
        return {
          templateId: profile.templateId,
          versionId: profile.versionId,
          ...inspectNativePptx(bytes),
        };
      },
    },
    {
      name: 'presentation.template.restoreNative',
      description:
        'Return the original native PPTX as an owned downloadable artifact with byte-identical fidelity.',
      input: z.object(reference).strict(),
      execute: async (input, ctx) => {
        const { bytes, profile } = await source(input, ctx);
        return save(bytes, profile.templateId, profile.versionId, [], ctx);
      },
    },
    {
      name: 'presentation.template.fillNative',
      description:
        'Fill selected text runs, picture objects, or embedded media in the original PPTX package. Preserve all untouched XML, masters, notes, diagrams, charts, grouped objects, media posters, timing and playback structure. Inspect shape IDs first. text replaces the first run and empties the others; runs preserves each rich-text run; mediaRef replaces the owned audio/video bytes while retaining native relationships.',
      input: z
        .object({
          ...reference,
          patches: z
            .array(
              z
                .object({
                  page: z.number().int().positive(),
                  shapeId: z.string().min(1),
                  text: z.string().max(10000).optional(),
                  runs: z.array(z.string().max(10000)).max(100).optional(),
                  imageRef: z.string().min(1).optional(),
                  mediaRef: z.string().min(1).optional(),
                })
                .strict()
                .refine((patch) => !(patch.imageRef && patch.mediaRef), {
                  message: 'Use imageRef or mediaRef, not both',
                }),
            )
            .min(1)
            .max(100),
        })
        .strict(),
      execute: async (input, ctx) => {
        const { bytes, profile } = await source(input, ctx);
        const patches: NativeTemplatePatch[] = [];
        for (const { imageRef, mediaRef, ...patch } of input.patches) {
          if (!imageRef && !mediaRef) {
            patches.push(patch);
            continue;
          }
          const assetRef = imageRef ?? mediaRef!;
          const asset = await store.get(ctx.scope, assetIdFromRef(assetRef));
          if (mediaRef) {
            const kind = asset?.mimeType?.startsWith('video/')
              ? 'video'
              : asset?.mimeType?.startsWith('audio/')
                ? 'audio'
                : undefined;
            if (!asset?.bytes || !asset.mimeType || !kind)
              throw new Error('Owned replacement audio or video not found');
            patches.push({
              ...patch,
              media: { bytes: asset.bytes, kind, mimeType: asset.mimeType },
            });
            continue;
          }
          if (
            !asset?.bytes ||
            !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType ?? '')
          )
            throw new Error('Owned replacement image not found');
          // PNG works consistently in native PowerPoint, including transparent cutouts.
          const png = await sharp(asset.bytes, { limitInputPixels: 16_777_216 }).png().toBuffer();
          patches.push({ ...patch, image: { bytes: new Uint8Array(png), mimeType: 'image/png' } });
        }
        const filled = fillNativePptx(bytes, patches);
        return save(filled.bytes, profile.templateId, profile.versionId, filled.changedParts, ctx);
      },
    },
  ];
}
