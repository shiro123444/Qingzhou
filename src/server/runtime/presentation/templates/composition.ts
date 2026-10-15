import { createHash } from 'node:crypto';

import { isReusableTemplateComponent } from '../artwork-pipeline';
import { compileTemplateDesignProgram } from './design-program';
import { selectRoleDiverse } from './role-diversity';
import type { TemplateApplication } from './types';

export interface TemplateComponentSource {
  componentId: string;
  templateId: string;
  versionId: string;
}

const scopedId = (source: TemplateApplication, kind: string, id: string) =>
  `${kind}-${createHash('sha256')
    .update(JSON.stringify([source.templateId, source.versionId, id]))
    .digest('hex')
    .slice(0, 24)}`;

/** Sources have already been resolved in the authenticated account. Never fabricate a library ID. */
export function composeTemplateApplications(
  sources: TemplateApplication[],
  selectedFamilies: Record<string, string> = {},
) {
  const primary = sources[0];
  if (!primary) throw new Error('A primary template is required');
  if (sources.length > 4) throw new Error('Compose at most four template sources');
  const componentSources: Record<string, TemplateComponentSource> = {};
  if (sources.length === 1 && !selectedFamilies[primary.templateId])
    return { application: primary, componentSources };
  if (!primary.visual) throw new Error('A learned primary template is required');
  const familyFor = (source: TemplateApplication) =>
    source.visual?.families.find((family) => family.id === selectedFamilies[source.templateId]) ??
    source.visual?.families[0];
  const anchorFamily = familyFor(primary)!;
  const accent =
    anchorFamily.palette.find(
      (color) => !['#FFFFFF', '#000000', '#1A1A1A'].includes(color.toUpperCase()),
    ) ?? '#245C4B';
  const families = sources.flatMap((source) =>
    [familyFor(source)].flatMap((family) =>
      family
        ? [
            {
              ...family,
              palette: anchorFamily.palette,
              typography: anchorFamily.typography,
              ...(source !== primary ? { artwork: anchorFamily.artwork } : {}),
              id: scopedId(source, 'family', family.id),
            },
          ]
        : [],
    ),
  );
  const components = sources.flatMap((source) => {
    const family = familyFor(source);
    return (source.visual?.components ?? [])
      .filter(
        (component) => component.familyId === family?.id && isReusableTemplateComponent(component),
      )
      .slice(0, 6)
      .map((component) => {
        const id = scopedId(source, 'component', component.id);
        componentSources[id] = {
          templateId: source.templateId,
          versionId: source.versionId,
          componentId: component.id,
        };
        return { ...component, id, familyId: scopedId(source, 'family', component.familyId) };
      });
  });
  const archetypes = sources.flatMap((source) =>
    selectRoleDiverse(source.visual?.designProgram.archetypes ?? [], 7).map((archetype) => ({
      ...archetype,
      id: scopedId(source, 'archetype', archetype.id),
      familyId: scopedId(source, 'family', familyFor(source)!.id),
      sourcePageRefs: source
        .visual!.pages.filter((page) => archetype.evidencePages.includes(page.page))
        .map(({ ref }) => ref),
      ...(source !== primary && archetype.header
        ? { header: { ...archetype.header, fill: accent, textColor: '#FFFFFF' } }
        : {}),
      regions: archetype.regions.map((region) => ({
        ...region,
        ...(source !== primary && region.behavior === 'locked'
          ? { behavior: 'elastic' as const }
          : {}),
        ...(region.componentId
          ? { componentId: scopedId(source, 'component', region.componentId) }
          : {}),
      })),
    })),
  );
  const activeDesign = compileTemplateDesignProgram({
    summary: primary.visual.summary,
    families: [anchorFamily],
    components: primary.visual.components.filter(
      (component) => component.familyId === anchorFamily.id,
    ),
    guidance: '按当前任务组合能力；借用几何关系，其他来源不改变主风格。',
  });
  const styleVisual = {
    ...primary.visual,
    families: [anchorFamily],
    designProgram: {
      ...activeDesign,
      tokens: {
        ...primary.visual.designProgram.tokens,
        palette: anchorFamily.palette,
        typography: [anchorFamily.typography].filter(Boolean),
        artwork: [anchorFamily.artwork].filter(Boolean),
      },
    },
  };
  const visual = {
    ...primary.visual,
    families,
    components,
    pages: sources
      .flatMap((source) =>
        source.visual!.pages.filter(
          (page) =>
            archetypes.some((a) => a.sourcePageRefs?.includes(page.ref)) ||
            familyFor(source)!.pages.includes(page.page),
        ),
      )
      .slice(0, 48),
    styleAtlas: primary.visual.styleAtlas?.map((sample) => ({
      ...sample,
      familyId: scopedId(primary, 'family', sample.familyId),
      componentId: scopedId(primary, 'component', sample.componentId),
    })),
    designProgram: {
      ...activeDesign,
      tokens: styleVisual.designProgram.tokens,
      archetypes: selectRoleDiverse(archetypes, 12),
      cadence: {
        ...primary.visual.designProgram.cadence,
        bodyFamilyIds: families.map(({ id }) => id),
        openingFamilyId: families[0]?.id,
        closingFamilyId: families[0]?.id,
      },
    },
  };
  const application: TemplateApplication = {
    ...primary,
    compositionPolicy: {
      mode: 'capabilities',
      primaryTemplateId: primary.templateId,
      palette: anchorFamily.palette,
      typography: anchorFamily.typography,
    },
    componentSources,
    sources: sources.map(({ name, templateId, versionId }) => ({ name, templateId, versionId })),
    visual,
    layouts: sources.flatMap((source) =>
      selectRoleDiverse(
        source.layouts.map((layout, index) => ({
          ...layout,
          roles: [
            layout.kind,
            index === source.layouts.length - 1 ? 'closing' : 'content',
            (layout.evidence?.textCharacters ?? layout.textCapacity) > 240 ? 'dense' : 'light',
            ...(layout.evidence?.tables.length ? ['table'] : []),
            ...(layout.evidence?.chartCount ? ['chart'] : []),
          ],
        })),
        8,
      ).map(({ roles: _roles, ...layout }) => ({
        ...layout,
        elements: layout.elements.map((element) => ({
          ...element,
          ...(element.color ? { color: element.kind === 'text' ? '#1A1A1A' : accent } : {}),
        })),
        layoutId: scopedId(source, 'layout', layout.layoutId),
      })),
    ),
  };
  return { application, componentSources, styleVisual };
}
