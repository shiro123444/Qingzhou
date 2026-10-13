import type { SkillsPluginOptions } from '../skills-plugin';

/** The presentation profile supplies domain guidance; the composition host stays generic. */
export const presentationSkillsOptions: SkillsPluginOptions = {
  agent: {
    instructions:
      'Inspect native PPTX object IDs before filling; preserve untouched complex objects. Choose native filling for faithful template reuse. When creating presentation artwork from a learned style, assets.generate with referenceAssetRefs to inherit palette and brushwork, then assets.removeBackground, then assets.compose or place the cutout. Reuse only safe decorative components or previously generated owned assets; do not paste original template photographs as the new slide hero. assets.keyColor only for solid backgrounds, assets.transform for alpha/geometry. Stop after accomplishing the request; do not restore the original after filling.',
    prepareInput: (input, context) =>
      context.operation === 'assets.generate'
        ? { ...input, requestId: `${context.requestId}:image:${context.call}` }
        : input,
  },
  recipes: [
    {
      id: 'teaching-lesson',
      description:
        'Retrieve teacher-confirmed patterns, propose a lesson under the current teacher brief, validate its public stages and compile them for a renderer. Proposals never grant teacher approval.',
      steps: [
        'teaching.memory.search',
        'teaching.memory.compose',
        'teaching.lesson.plan',
        'teaching.lesson.validate',
        'teaching.lesson.compile',
      ],
    },
    {
      id: 'mixed-scientific-presentation',
      description:
        'Compile per-block visual requirements; measure formulas and scientific figures before layout; generate qualitative illustrations independently while rendering precise plots deterministically. Compose owned assets inside measured regions, retain provenance in metadata, and verify every required asset is embedded. Works with or without a template.',
      steps: [
        'presentation.content.compile',
        'presentation.formula.measure',
        'presentation.diagram.measure',
        'assets.generate',
        'presentation.formula.render',
        'presentation.diagram.render',
      ],
    },
    {
      id: 'learned-presentation',
      description:
        'Retrieve verified style, layout and rendering recipes from earlier work; compose relevant atoms under the current task and content budget.',
      steps: [
        'presentation.memory.search',
        'presentation.memory.load',
        'presentation.memory.compose',
      ],
    },
    {
      id: 'transparent-artwork',
      steps: ['assets.generate', 'assets.removeBackground', 'assets.inspect', 'assets.compose'],
    },
    {
      id: 'style-artwork',
      description:
        'Reference-guided artwork: pass owned text-free style-atlas crops to generate, never whole template pages; remove the background only for a subject/decoration with a transparent policy. Scenes, backgrounds and textures preserve their pixels and skip cutout.',
      steps: ['assets.generate', 'assets.removeBackground', 'assets.transform', 'assets.compose'],
    },
    {
      id: 'native-template',
      steps: ['presentation.template.inspectNative', 'presentation.template.fillNative'],
    },
    {
      id: 'native-media',
      steps: [
        'presentation.template.inspectNative',
        'presentation.template.extractMedia',
        'presentation.template.fillNative',
      ],
    },
    { id: 'recover-work', steps: ['presentation.job.list', 'presentation.page.read'] },
  ],
};
