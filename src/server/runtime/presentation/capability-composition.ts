import type { PresentationPlan } from '../../../../packages/runtime-contracts/src';
import type { CapabilityCapsule } from './capability-memory';

/** A deck has one visual anchor; layout and rendering techniques may come from other sources. */
export function composeCapabilityPolicy(capsules: CapabilityCapsule[]) {
  return {
    styleCapsuleId: capsules.find((capsule) => capsule.kind === 'style')?.id,
    layoutCapsuleIds: capsules.filter((capsule) => capsule.kind === 'layout').map(({ id }) => id),
    recipeCapsuleIds: capsules
      .filter((capsule) => capsule.kind === 'render-recipe')
      .map(({ id }) => id),
    rules: [
      '按本页内容和阅读任务选择布局与渲染能力，可以组合不同模板来源；不要求整稿模仿一个模板。',
      '用户指定的模板、风格和内容优先；否则以 styleCapsuleId 统一色板、字体与笔触。借用其他模板的布局时适配主风格，不混入冲突色板。',
      '没有合适的主风格时，按当前主题制定统一的视觉风格；历史能力只是可选工具，不必强行套用。',
      '学习记录是设计参考，不是原始素材授权或图片引用；实际素材必须另行从所属模板提取、核验或生成。',
      '只在实际使用的页面 metadata.capabilityUses 记录 {capsuleId, reason}，说明用在何处；没有使用就不记录。',
    ],
  };
}

/** Keep page-level attribution bounded and restricted to capabilities offered to this job. */
export function normalizeCapabilityUses(value: unknown, capsules: CapabilityCapsule[]) {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(capsules.map(({ id }) => id));
  const seen = new Set<string>();
  return value.slice(0, 6).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const { capsuleId, reason } = item;
    if (
      typeof capsuleId !== 'string' ||
      !allowed.has(capsuleId) ||
      seen.has(capsuleId) ||
      typeof reason !== 'string' ||
      reason.trim().length < 10
    )
      return [];
    seen.add(capsuleId);
    return [{ capsuleId, reason: reason.trim().slice(0, 600) }];
  });
}

/** Retrieval alone is not usage evidence. Recovered generic layouts cannot prove layout reuse. */
export function appliedLearnedCapabilityIds(capsules: CapabilityCapsule[], plan: PresentationPlan) {
  const used = new Set<string>();
  for (const slide of plan.slides) {
    for (const { capsuleId } of normalizeCapabilityUses(slide.metadata?.capabilityUses, capsules)) {
      const capsule = capsules.find(({ id }) => id === capsuleId)!;
      if (slide.metadata?.layoutRecovered && capsule.kind !== 'render-recipe') continue;
      if (capsule.kind === 'render-recipe') {
        if (!capsule.recipe) continue;
        const blocks = slide.metadata?.contentBlocks;
        const assets = slide.metadata?.visualAssets;
        const formula = Array.isArray(blocks) && blocks.some((block) => block?.kind === 'formula');
        const illustration =
          Array.isArray(assets) &&
          assets.some(
            (asset) => asset?.kind === 'scientific-illustration' && asset.origin === 'generated',
          );
        const matched =
          capsule.recipe === 'formula-with-explanation'
            ? formula
            : capsule.recipe === 'scientific-illustration'
              ? illustration
              : capsule.recipe === 'mixed-scientific'
                ? illustration && Array.isArray(blocks) && blocks.length > 0
                : capsule.recipe === 'decoration-sticker'
                  ? Array.isArray(assets) &&
                    assets.some(
                      (asset) =>
                        asset?.kind === 'sticker' &&
                        asset.origin === 'generated' &&
                        asset.transparency !== 'opaque',
                    )
                  : Array.isArray(blocks) &&
                    blocks.some(
                      (block) =>
                        block?.kind === 'scientific-diagram' &&
                        block.spec?.type ===
                          (capsule.recipe === 'scientific-plot' ? 'plot' : 'graph'),
                    );
        if (!matched) continue;
      }
      used.add(capsuleId);
    }
  }
  return [...used];
}
