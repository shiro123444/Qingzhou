import { createHash } from 'node:crypto';

import sharp from 'sharp';
import { z } from 'zod';

import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import type { PresentationArtifactStore } from './artifact-store';
import {
  createTrustedChatImages,
  type GLMChatContentPart,
  type GLMMultimodalChatPort,
} from './multimodal-chat-provider-glm';
import { completeStructuredJson } from './structured-json-chat';
import { templateBoxSchema } from './templates/visual-types';
import { boundVisionImages } from './vision-payload';

const verdict = z.object({
  ref: z.string(),
  containsText: z.boolean(),
  containsIdentityMark: z.boolean(),
  contextBoundPhoto: z.boolean(),
  reason: z.string().min(1).max(600),
  safeRegion: templateBoxSchema.nullable().optional(),
});

/** Inspect actual cropped pixels before using them as image-model references. Never trust a region label alone. */
export function createPresentationReferenceValidator(options: {
  store: PresentationArtifactStore;
  chat: GLMMultimodalChatPort;
}) {
  const pending = new Map<string, Promise<void>>();
  const validate = async (
    refs: readonly string[],
    context: { scope: RuntimeScope; signal?: AbortSignal },
  ): Promise<string[]> => {
    const owned = await Promise.all(
      [...new Set(refs)].slice(0, 4).map(async (ref) => {
        const asset = await options.store.get(context.scope, ref);
        if (
          !asset?.bytes ||
          !['image/png', 'image/jpeg', 'image/webp'].includes(asset.mimeType ?? '')
        )
          throw new Error('Artwork references must be owned raster pixels');
        const fingerprint = createHash('sha256').update(asset.bytes).digest('hex');
        const auditId = `reference-check-${createHash('sha256')
          .update(
            JSON.stringify([context.scope.userId, context.scope.sessionId, ref, fingerprint, options.chat.manifest.model, 3]),
          )
          .digest('hex')
          .slice(0, 40)}`;
        const audit = await options.store.get(context.scope, auditId);
        const saved = audit?.metadata?.referenceSafety as
          { fingerprint?: string; safe?: boolean; cropRef?: string } | undefined;
        return {
          ref,
          asset,
          auditId,
          fingerprint,
          saved: saved?.fingerprint === fingerprint ? saved : undefined,
        };
      }),
    );
    const unknown = owned.filter(({ saved }) => saved === undefined);
    const waiting = unknown.flatMap(({ auditId }) =>
      pending.has(auditId) ? [pending.get(auditId)!] : [],
    );
    if (waiting.length) {
      await Promise.all(waiting);
      return validate(refs, context);
    }
    if (unknown.length) {
      const task = (async () => {
        const images = await boundVisionImages(unknown.map(({ asset }) => asset.bytes!));
        const trustedImages = createTrustedChatImages(images, context.scope);
        const content: GLMChatContentPart[] = unknown.flatMap(({ ref }, index) => [
          { type: 'text', text: `待核验实际裁切素材 ref=${ref}` },
          { type: 'image_url', image_url: { url: trustedImages.urls[index], detail: 'high' } },
        ]);
        const checked = await completeStructuredJson({
          chat: options.chat,
          context: { ...context, trustedImages, timeoutMs: 180000 },
          emptyError: 'Reference pixel validation returned no JSON',
          parse: (value) => {
            const result = z.object({ verdicts: z.array(verdict).min(1).max(4) }).parse(value);
            if (
              result.verdicts.length !== unknown.length ||
              new Set(result.verdicts.map(({ ref }) => ref)).size !== unknown.length ||
              result.verdicts.some(({ ref }) => !unknown.some((image) => image.ref === ref))
            )
              throw new Error('Validate every offered reference exactly once');
            return result.verdicts;
          },
          request: {
            model: options.chat.manifest.model,
            max_tokens: 2000,
            response_format: { type: 'json_object' },
            temperature: 0,
            messages: [
              {
                role: 'system',
                content:
                  '检查实际裁切像素能否作为新主题生图的纯风格/材质参考，裁切描述不是证据。任何旧文字（包括小字、年份、页码）、校徽、机构标识、品牌横条或旧活动人物合照均不能进入风格参考。纸张、山水、纹理、抽象装饰和无标识通用插画可作为参考。照片中的纯自然材质可用，但旧活动照片或有上下文人物证据不可用。不能因图很小而忽略标识。只按可见像素给出JSON {verdicts:[{ref,containsText,containsIdentityMark,contextBoundPhoto,reason}]}；每个真实ref恰好一次。',
              },
              { role: 'system', content: '若整张裁切因旧文字/标识不可用，但仍有足够大的纯纹理、笔触、山水、植物或纸张区域，可额外返回safeRegion:{x,y,width,height}。坐标相对本张裁切图，不是原始幻灯片；面积应为10%-80%，不含任何旧文字、标识或旧活动人物。没有可靠干净区域时返回null。服务器会实际再裁切并独立复核新像素，不能把区域假设当成已通过。' },
              { role: 'user', content },
            ],
          },
        });
        for (const result of checked.value) {
          const item = unknown.find(({ ref }) => ref === result.ref)!;
          const safe =
            !result.containsText && !result.containsIdentityMark && !result.contextBoundPhoto;
          item.saved = { fingerprint: item.fingerprint, safe };
          const region = result.safeRegion;
          if (!safe && region && !item.asset.metadata?.referenceCrop &&
              region.width * region.height >= 0.1 && region.width * region.height <= 0.8) {
            const raster = sharp(item.asset.bytes!, { limitInputPixels: 16_777_216 });
            const dimensions = await raster.metadata();
            if (dimensions.width && dimensions.height) {
              const left = Math.floor(region.x * dimensions.width), top = Math.floor(region.y * dimensions.height);
              const width = Math.min(dimensions.width - left, Math.round(region.width * dimensions.width));
              const height = Math.min(dimensions.height - top, Math.round(region.height * dimensions.height));
              if (width >= 16 && height >= 16) {
                const cropRef = `reference-crop-${createHash('sha256').update(JSON.stringify([item.ref,item.fingerprint,region])).digest('hex').slice(0,40)}`;
                if (!(await options.store.get(context.scope, cropRef)))
                  await options.store.put(context.scope, { artifactId: cropRef, type: 'image', name: 'verified-template-region.png', mimeType: 'image/png',
                    bytes: await raster.extract({left,top,width,height}).png().toBuffer(),
                    metadata: {...item.asset.metadata, referenceCrop: { sourceRef: item.ref, region }, sourceRef: item.ref },
                  });
                if ((await validate([cropRef], context)).includes(cropRef)) item.saved.cropRef = cropRef;
              }
            }
          }
          await options.store.put(context.scope, {
            artifactId: item.auditId,
            type: 'json',
            name: 'reference-safety.json',
            mimeType: 'application/json',
            bytes: Buffer.from(JSON.stringify(result)),
            metadata: {
              referenceSafety: {
                ...result,
                safe,
                fingerprint: item.fingerprint,
                cropRef: item.saved.cropRef,
                model: checked.result.model,
              },
            },
          });
        }
      })();
      for (const { auditId } of unknown) pending.set(auditId, task);
      try {
        await task;
      } finally {
        for (const { auditId } of unknown) pending.delete(auditId);
      }
    }
    return owned.flatMap(({ saved, ref }) => saved?.safe === true ? [ref] : saved?.cropRef ? [saved.cropRef] : []);
  };
  return validate;
}
