import { z } from 'zod';

/** Host-owned vocabulary: no arbitrary instructions, code, models or tool configuration. */
export const trialPolicySchema = z
  .object({
    layoutStrategy: z.enum(['grouped', 'columns']).optional(),
    textSpacing: z.enum(['comfortable', 'compact']).optional(),
    compositionRecipe: z.enum(['title-body', 'comparison']).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).filter((item) => item !== undefined).length === 1);
export type TrialPolicy = z.infer<typeof trialPolicySchema>;
export const TRIAL_POLICY_VERSION = 'single-dimension-v1';
export const TRIAL_POLICY_INSTRUCTIONS = {
  layoutStrategy: {
    grouped: '按原有语义分组，用间距和对齐区分组内与组间；不改写、合并或删除文字。',
    columns: '在原内容确实适合时使用分栏；保持原阅读顺序，不制造原文没有的对应关系。',
  },
  textSpacing: {
    comfortable: '保留原字号，增大可用文本区域与段间留白；空间不足时保持原布局。',
    compact: '仅收紧过大的组间留白，保留原字号、清晰行距和全部文字；不得压缩字形或遮挡。',
  },
  compositionRecipe: {
    'title-body': '采用标题与正文区的清晰层级，保留原有内容顺序、主视觉及全部事实。',
    'comparison': '仅当原文已有对照关系时将相应内容对齐展示；否则沿用原稿，不新增比较或结论。',
  },
};
export function trialPolicyInstructions(policy?: TrialPolicy): string | undefined {
  if (!policy) return undefined;
  const validated = trialPolicySchema.parse(policy);
  if (validated.layoutStrategy)
    return TRIAL_POLICY_INSTRUCTIONS.layoutStrategy[validated.layoutStrategy];
  if (validated.textSpacing) return TRIAL_POLICY_INSTRUCTIONS.textSpacing[validated.textSpacing];
  return TRIAL_POLICY_INSTRUCTIONS.compositionRecipe[validated.compositionRecipe!];
}
