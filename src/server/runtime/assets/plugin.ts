import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import sharp from 'sharp';
import { z } from 'zod';

import type { AtomicInvocation, AtomicOperation, AtomicPlugin } from '../atomic-runtime';
import type { PresentationArtifactStore } from '../presentation/artifact-store';
import type { ImageGenerationCapability } from '../presentation/image-generation-capability';

const MAX_PIXELS = 16_777_216;
const MAX_BYTES = 24 * 1024 * 1024;
const id = z.string().min(1).max(256);
const dimension = z.number().int().min(1).max(4096);
const fail = (message: string) =>
  Object.assign(new Error(message), { code: 'PRESENTATION_INVALID' });
export const assetIdFromRef = (ref: string) =>
  ref.startsWith('/api/runtime/presentation/artifacts/')
    ? decodeURIComponent(ref.slice('/api/runtime/presentation/artifacts/'.length).split('?')[0])
    : ref;

export function createAssetPlugin(
  store: PresentationArtifactStore,
  imageGeneration?: ImageGenerationCapability,
  python = process.env.CORDIS_ASSET_PYTHON ?? 'python3',
): AtomicPlugin {
  async function read(ref: string, context: AtomicInvocation) {
    const artifact = await store.get(context.scope, assetIdFromRef(ref));
    if (
      !artifact?.bytes ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(artifact.mimeType ?? '') ||
      artifact.bytes.length > MAX_BYTES
    )
      throw fail('A readable owned raster asset is required');
    const image = sharp(artifact.bytes, {
      limitInputPixels: MAX_PIXELS,
      animated: false,
    }).toColourspace('srgb');
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || (metadata.pages ?? 1) > 1)
      throw fail('A single raster image is required');
    return { artifact, image, metadata };
  }
  async function save(
    bytes: Buffer,
    operation: string,
    sources: string[],
    parameters: unknown,
    context: AtomicInvocation,
  ) {
    if (context.signal?.aborted) throw fail('Asset operation cancelled');
    if (bytes.length > MAX_BYTES) throw fail('Asset output exceeds its size budget');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([operation, sources, parameters]))
      .update(bytes)
      .digest('hex');
    const artifactId = `asset-${fingerprint.slice(0, 40)}`;
    const metadata = await sharp(bytes, { limitInputPixels: MAX_PIXELS }).metadata();
    const existing = await store.get(context.scope, artifactId);
    const artifact =
      existing ??
      (await store.put(context.scope, {
        artifactId,
        bytes: new Uint8Array(bytes),
        mimeType: 'image/png',
        name: `${operation}.png`,
        type: 'image',
        metadata: {
          jobId: context.jobId,
          operation,
          sources: sources.map(assetIdFromRef),
          parameters,
          width: metadata.width,
          height: metadata.height,
          hasAlpha: metadata.hasAlpha,
        },
      }));
    return {
      artifactId,
      ref: artifactId,
      uri: artifact.uri,
      width: metadata.width,
      height: metadata.height,
      hasAlpha: metadata.hasAlpha,
    };
  }
  const operations: AtomicOperation[] = [
    {
      name: 'assets.list',
      description:
        'Find reusable image assets owned by this account across presentations. Returns metadata and refs, never image bytes.',
      input: z
        .object({ query: z.string().max(100).optional(), jobId: z.string().optional() })
        .strict(),
      execute: async (input, ctx) => ({
        assets: ((await store.list?.(ctx.scope)) ?? [])
          .filter(
            (asset) =>
              asset.type === 'image' &&
              (!input.jobId || asset.metadata?.jobId === input.jobId) &&
              (!input.query ||
                `${asset.name} ${asset.metadata?.operation ?? ''}`
                  .toLowerCase()
                  .includes(input.query.toLowerCase())),
          )
          .slice(0, 100)
          .map((asset) => ({
            ref: asset.artifactId,
            name: asset.name,
            uri: asset.uri,
            metadata: asset.metadata,
          })),
      }),
    },
    {
      name: 'assets.applyMask',
      description:
        'Apply an owned grayscale mask to an image, multiplying its existing alpha. White keeps pixels, black removes them. Produces a new PNG for further composition.',
      input: z.object({ ref: id, maskRef: id, invert: z.boolean().default(false) }).strict(),
      execute: async (input, ctx) => {
        const source = await read(input.ref, ctx);
        const mask = await read(input.maskRef, ctx);
        const { data, info } = await source.image
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const alpha = await mask.image
          .resize(info.width, info.height, { fit: 'fill' })
          .removeAlpha()
          .greyscale()
          .raw()
          .toBuffer();
        for (let p = 0; p < alpha.length; p++)
          data[p * 4 + 3] = Math.round(
            (data[p * 4 + 3] * (input.invert ? 255 - alpha[p] : alpha[p])) / 255,
          );
        return save(
          await sharp(data, { raw: info }).png().toBuffer(),
          'mask',
          [input.ref, input.maskRef],
          input,
          ctx,
        );
      },
    },
    {
      name: 'assets.inspect',
      description:
        'Inspect an owned raster asset: dimensions, alpha channel and immutable source lineage.',
      input: z.object({ ref: id }).strict(),
      execute: async ({ ref }, ctx) => {
        const { artifact, metadata } = await read(ref, ctx);
        return {
          artifactId: artifact.artifactId,
          uri: artifact.uri,
          width: metadata.width,
          height: metadata.height,
          hasAlpha: metadata.hasAlpha,
          lineage: artifact.metadata,
        };
      },
    },
    {
      name: 'assets.transform',
      description:
        'Create a new PNG by cropping, resizing, rotating or changing opacity; preserve the source and alpha.',
      input: z
        .object({
          ref: id,
          crop: z
            .object({
              left: z.number().int().nonnegative(),
              top: z.number().int().nonnegative(),
              width: dimension,
              height: dimension,
            })
            .strict()
            .optional(),
          width: dimension.optional(),
          height: dimension.optional(),
          fit: z.enum(['contain', 'cover', 'fill']).default('contain'),
          opacity: z.number().min(0).max(1).default(1),
          rotate: z.number().min(-180).max(180).default(0),
        })
        .strict(),
      execute: async (input, ctx) => {
        const { image, metadata } = await read(input.ref, ctx);
        if (input.crop) {
          if (
            input.crop.left + input.crop.width > metadata.width! ||
            input.crop.top + input.crop.height > metadata.height!
          )
            throw fail('Crop is outside the image');
          image.extract(input.crop);
        }
        if (input.width || input.height)
          image.resize(input.width, input.height, { fit: input.fit, background: '#00000000' });
        if (input.rotate) image.rotate(input.rotate, { background: '#00000000' });
        const { data, info } = await image
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        for (let i = 3; i < data.length; i += 4) data[i] = Math.round(data[i] * input.opacity);
        return save(
          await sharp(data, { raw: info }).png().toBuffer(),
          'transform',
          [input.ref],
          input,
          ctx,
        );
      },
    },
    {
      name: 'assets.removeBackground',
      description:
        'Use the local segmentation model to cut out the subject into an RGBA PNG. Preserves source pixels and returns a new asset; inspect edges before reuse.',
      input: z
        .object({ ref: id, model: z.enum(['u2net', 'u2net_human_seg']).default('u2net') })
        .strict(),
      execute: async (input, ctx) => {
        const { image } = await read(input.ref, ctx);
        const png = await image
          .rotate()
          .resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
          .png()
          .toBuffer();
        const script =
          'import sys,os\nfrom pathlib import Path\nfrom rembg import remove,new_session\nmodel=sys.argv[1]\nassert (Path(os.environ.get("U2NET_HOME",str(Path.home()/".u2net")))/(model+".onnx")).is_file(), "Segmentation model is not installed"\nsys.stdout.buffer.write(remove(sys.stdin.buffer.read(),session=new_session(model,providers=["CPUExecutionProvider"])))';
        const bytes = await new Promise<Buffer>((resolve, reject) => {
          const child = spawn(python, ['-c', script, input.model], {
            stdio: ['pipe', 'pipe', 'pipe'],
            signal: ctx.signal,
            env: { ...process.env, OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2' },
          });
          const chunks: Buffer[] = [];
          let size = 0;
          let error = '';
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(fail('Background removal timed out'));
          }, 120_000);
          child.stdout.on('data', (data: Buffer) => {
            size += data.length;
            if (size > MAX_BYTES) {
              child.kill('SIGKILL');
              reject(fail('Cutout exceeds output budget'));
            } else chunks.push(data);
          });
          child.stderr.on('data', (data: Buffer) => {
            if (error.length < 1000) error += data.toString();
          });
          child.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
          });
          child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve(Buffer.concat(chunks));
            else reject(fail(`Background removal unavailable: ${error.slice(-350)}`));
          });
          child.stdin.on('error', () => {});
          child.stdin.end(png);
        });
        return save(bytes, 'cutout', [input.ref], { model: input.model }, ctx);
      },
    },
    {
      name: 'assets.keyColor',
      description:
        'Remove a solid background color connected to the image edges, preserving enclosed subject colors. Use segmentation for photographic backgrounds.',
      input: z
        .object({
          ref: id,
          color: z.string().regex(/^#[a-f0-9]{6}$/i),
          tolerance: z.number().min(0).max(150).default(30),
          feather: z.number().min(0).max(80).default(10),
        })
        .strict(),
      execute: async (input, ctx) => {
        const { image } = await read(input.ref, ctx);
        const { data, info } = await image
          .ensureAlpha()
          .raw()
          .toBuffer({ resolveWithObject: true });
        const rgb = [1, 3, 5].map((i) => parseInt(input.color.slice(i, i + 2), 16));
        const seen = new Uint8Array(info.width * info.height);
        const queue = new Int32Array(seen.length);
        let head = 0;
        let tail = 0;
        const visit = (p: number) => {
          if (p < 0 || p >= seen.length || seen[p]) return;
          seen[p] = 1;
          const d = Math.hypot(
            data[p * 4] - rgb[0],
            data[p * 4 + 1] - rgb[1],
            data[p * 4 + 2] - rgb[2],
          );
          if (d <= input.tolerance + input.feather) {
            data[p * 4 + 3] = Math.round(
              data[p * 4 + 3] *
                (input.feather ? Math.max(0, (d - input.tolerance) / input.feather) : 0),
            );
            queue[tail++] = p;
          }
        };
        for (let x = 0; x < info.width; x++) {
          visit(x);
          visit((info.height - 1) * info.width + x);
        }
        for (let y = 0; y < info.height; y++) {
          visit(y * info.width);
          visit(y * info.width + info.width - 1);
        }
        while (head < tail) {
          const p = queue[head++];
          if (p % info.width) visit(p - 1);
          if (p % info.width < info.width - 1) visit(p + 1);
          visit(p - info.width);
          visit(p + info.width);
        }
        return save(
          await sharp(data, { raw: info }).png().toBuffer(),
          'key-color',
          [input.ref],
          input,
          ctx,
        );
      },
    },
    {
      name: 'assets.compose',
      description:
        'Compose up to 12 owned assets in layer order on a transparent or solid canvas. Each layer has its own placement, size, fit and opacity.',
      input: z
        .object({
          width: dimension,
          height: dimension,
          background: z
            .string()
            .regex(/^#[a-f0-9]{6}(?:[a-f0-9]{2})?$/i)
            .default('#00000000'),
          layers: z
            .array(
              z
                .object({
                  ref: id,
                  x: z.number().int().nonnegative(),
                  y: z.number().int().nonnegative(),
                  width: dimension,
                  height: dimension,
                  fit: z.enum(['contain', 'cover', 'fill']).default('contain'),
                  opacity: z.number().min(0).max(1).default(1),
                })
                .strict(),
            )
            .min(1)
            .max(12),
        })
        .strict(),
      execute: async (input, ctx) => {
        const layers: sharp.OverlayOptions[] = [];
        for (const layer of input.layers) {
          if (layer.x + layer.width > input.width || layer.y + layer.height > input.height)
            throw fail('Layer is outside the canvas');
          const { image } = await read(layer.ref, ctx);
          const { data, info } = await image
            .resize(layer.width, layer.height, { fit: layer.fit, background: '#00000000' })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
          for (let i = 3; i < data.length; i += 4) data[i] = Math.round(data[i] * layer.opacity);
          layers.push({
            input: await sharp(data, { raw: info }).png().toBuffer(),
            left: layer.x,
            top: layer.y,
          });
        }
        return save(
          await sharp({
            create: {
              width: input.width,
              height: input.height,
              channels: 4,
              background: input.background,
            },
          })
            .composite(layers)
            .png()
            .toBuffer(),
          'compose',
          input.layers.map((l: { ref: string }) => l.ref),
          input,
          ctx,
        );
      },
    },
  ];
  if (imageGeneration)
    operations.push({
      name: 'assets.generate',
      description:
        'Generate artwork from a subject brief and owned visual reference images. Use referenceAssetRefs to inherit the learned palette, brushwork and rendering language while drawing new content. The returned ref can feed cutout, transform, compose and slide placement.',
      input: z
        .object({
          prompt: z.string().min(1).max(4000),
          requestId: z.string().min(1).max(128),
          referenceAssetRefs: z.array(id).max(4).optional(),
          background: z.enum(['transparent', 'opaque', 'auto']).optional(),
          size: z.enum(['1024x1024', '1024x1536', '1536x1024']).default('1024x1024'),
        })
        .strict(),
      execute: async (input, ctx) => {
        const output = await imageGeneration.generate(
          ctx.scope,
          [
            {
              prompt: input.prompt,
              referenceAssetRefs: input.referenceAssetRefs,
              background: input.background,
              idempotencyKey: input.requestId,
              size: input.size,
              slideId: 'asset',
              slotId: input.requestId,
            },
          ],
          { jobId: ctx.jobId, signal: ctx.signal },
        );
        const ref = output.slots[0]?.assetRefs[0]?.ref;
        if (!ref || output.slots[0].state !== 'ready')
          throw fail('Image generation did not produce an asset');
        return { artifactId: ref, ref };
      },
    });
  return {
    id: 'assets',
    version: '1.0.0',
    operations: operations.map((operation) => ({
      ...operation,
      agent: {
        contexts: ['presentation.intake'],
        maxCalls: operation.name === 'assets.generate' ? 2 : 4,
      },
    })),
  };
}
