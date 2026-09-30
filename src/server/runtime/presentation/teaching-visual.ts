import { createHash } from 'node:crypto';

import sharp from 'sharp';

import type {
  TeachingPageObservation,
  TeachingPattern,
  TeachingVisualPage,
} from '@/types/presentationTeaching';

import type { RuntimeScope } from '../../../../packages/runtime-contracts/src';
import { presentationAccountScope } from './account-workspace';
import type { PresentationArtifactStore } from './artifact-store';
import { createTrustedChatImages } from './multimodal-chat-provider-glm';
import { renderNativeTemplatePages, type TemplatePageRenderer } from './templates/page-renderer';

const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const invalid = (message: string) =>
  Object.assign(new Error(message), { code: 'PRESENTATION_INVALID' });

export interface TeachingVisualOptions {
  renderer?: TemplatePageRenderer;
  store: PresentationArtifactStore;
}

/** Native final-state raster snapshots, not reconstructed animation frames. */
export async function captureTeachingPages(
  options: TeachingVisualOptions,
  input: { bytes: Uint8Array; sourceHash: string; pages: TeachingPageObservation[] },
  scope: RuntimeScope,
  signal?: AbortSignal,
) {
  const numbers = input.pages.map((page) => page.page);
  if (numbers.length < 2 || numbers.length > 6 || new Set(numbers).size !== numbers.length)
    throw invalid('Visual teaching evidence requires 2–6 unique pages');
  signal?.throwIfAborted();
  const rendered = await (options.renderer ?? renderNativeTemplatePages)(
    input.bytes,
    numbers,
    signal,
  );
  if (
    rendered.length !== numbers.length ||
    new Set(rendered.map((p) => p.page)).size !== numbers.length ||
    rendered.some((p) => !numbers.includes(p.page))
  )
    throw invalid('Renderer must return each requested teaching page exactly once');
  const snapshots: TeachingVisualPage[] = [];
  const images: { base64: string; mimeType: 'image/jpeg' }[] = [];
  // Artifacts follow the account-scoped lifetime of teaching memory, not the source session.
  const owner = presentationAccountScope(scope.userId);
  for (const page of input.pages) {
    signal?.throwIfAborted();
    const raw = rendered.find((entry) => entry.page === page.page)!;
    if (!raw.bytes.length || raw.bytes.length > 16 * 1024 * 1024)
      throw invalid('Invalid teaching page raster budget');
    const metadata = await sharp(raw.bytes, { limitInputPixels: 16_777_216 }).metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format ?? ''))
      throw invalid('Teaching visual evidence must be a raster, not an XML approximation');
    const image = await sharp(raw.bytes, { limitInputPixels: 16_777_216 })
      .rotate()
      .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 88 })
      .toBuffer({ resolveWithObject: true });
    const sha256 = hash(image.data);
    const ref = `teaching-page-${hash(JSON.stringify([scope.userId, input.sourceHash, page.page, sha256])).slice(0, 40)}`;
    const existing = await options.store.get(owner, ref);
    if (!existing) {
      try {
        await options.store.put(owner, {
          artifactId: ref,
          bytes: image.data,
          type: 'image',
          mimeType: 'image/jpeg',
          name: `Teaching source · ${page.page}.jpg`,
          metadata: {
            role: 'teaching-evidence',
            sourceHash: input.sourceHash,
            sourcePage: page.page,
            sha256,
            snapshotKind: 'native-static-final-state',
          },
        });
      } catch (error) {
        const concurrent = await options.store.get(owner, ref);
        if (!concurrent?.bytes || hash(concurrent.bytes) !== sha256) throw error;
      }
    } else if (!existing.bytes || hash(existing.bytes) !== sha256)
      throw invalid('Teaching evidence artifact mismatch');
    snapshots.push({
      page: page.page,
      ref,
      sha256,
      width: image.info.width,
      height: image.info.height,
      builds: page.builds ?? [],
      buildsTruncated: page.buildsTruncated ?? false,
    });
    images.push({ base64: image.data.toString('base64'), mimeType: 'image/jpeg' });
  }
  return { snapshots, trustedImages: createTrustedChatImages(images, scope) };
}

export function validateTeachingVisualComparisons(
  pattern: TeachingPattern,
  snapshots?: TeachingVisualPage[],
) {
  const comparisons = pattern.visualComparisons;
  if (!snapshots?.length) {
    if (comparisons?.length)
      throw invalid('Visual comparisons require actual server-rendered pages');
    return;
  }
  if (!comparisons?.length)
    throw invalid('Visual analysis must include localized page comparisons');
  const pages = new Set(snapshots.map((page) => page.page));
  for (const comparison of comparisons) {
    if (
      comparison.fromPage >= comparison.toPage ||
      !pages.has(comparison.fromPage) ||
      !pages.has(comparison.toPage)
    )
      throw invalid('Visual comparison references unordered or unseen pages');
    const localized = new Set(comparison.regions.map((region) => region.page));
    if (
      !localized.has(comparison.fromPage) ||
      !localized.has(comparison.toPage) ||
      [...localized].some((page) => page !== comparison.fromPage && page !== comparison.toPage)
    )
      throw invalid('Visual comparison must locate evidence in both referenced pages');
  }
}

export const TEACHING_VISUAL_INSTRUCTIONS = `本次额外提供了原始PPTX经LibreOffice导出的静态终态截图，页码标签与图片一一对应。比较同一图的焦点变化、跨页新增内容、现象与机制的视觉对应、留白与信息密度、外部材料与说明文字的关系。只描述看得见的区域，不把示意图当科研数据，不从颜色变化推断学生已掌握。每个模式必须额外返回visualComparisons:[{fromPage:36,toPage:37,kind:"focus-shift|incremental-content|phenomenon-to-mechanism|contrast|layout-change|uncertain",visibleChange:"图中可见的差异，仍是待教师核对的视觉判断",alternativeExplanation:"其他可能原因（例如主题格式、渲染或不同对象）",uncertainty:"截图无法确定什么",regions:[{page:36,x:0.1,y:0.2,width:0.4,height:0.3,description:"定位证据"},{page:37,x:0.1,y:0.2,width:0.4,height:0.3,description:"定位证据"}]}]。区域坐标是整页0到1的比例，每个比较必须定位两页。只允许引用本次真正提供的截图；不相邻页比较仅代表跨段对照，不能称为紧接着展开。原文evidence仍必须逐字引用。模型视觉判断不是服务器核实的事实；实际截图才是证据。截图可能将所有动画内容叠在终态；OOXML builds 只提供结构线索，不等于已播放或验证触发顺序、时长。若看不清或相互遮挡请标uncertain，不能声称恢复了原生动画或逐次点击状态。`;
