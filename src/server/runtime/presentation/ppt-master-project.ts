import type { PresentationPlan } from '../../../../packages/runtime-contracts/src';

/** Native theme metadata derived from the authored SVG; slide content stays unchanged. */
export const pptMasterProjectLock = (plan: PresentationPlan): string => {
  const svg = plan.slides.map((slide) => slide.svg).join('\n');
  const sizes = [...svg.matchAll(/\bfont-size=["']([\d.]+)(?:px)?["']/gu)]
    .map((match) => Number(match[1]))
    .filter((size) => Number.isFinite(size) && size > 0);
  const counts = new Map<number, number>();
  for (const size of sizes) counts.set(size, (counts.get(size) ?? 0) + 1);
  const title = sizes.length ? sizes.reduce((max, size) => Math.max(max, size), 0) : 32;
  const body =
    [...counts]
      .filter(([size]) => size >= 24 && size < title)
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 24;
  const caption = [...counts].filter(([size]) => size < body).sort((a, b) => b[1] - a[1])[0]?.[0];
  const family = svg.match(/\bfont-family=(["'])([^\r\n<>]*?)\1/u)?.[2] || 'Arial';
  const viewBox = plan.slides[0]?.svg.match(/<svg\b[^>]+\bviewBox=["']([\d.\s-]+)["']/u)?.[1];
  const colors = [
    ...new Set(
      [...svg.matchAll(/\b(?:fill|stroke)=["'](#[\da-fA-F]{6})["']/gu)].map((match) =>
        match[1].toUpperCase(),
      ),
    ),
  ];
  const background =
    svg.match(/<rect\b[^>]+\bfill=["'](#[\da-fA-F]{6})["']/u)?.[1]?.toUpperCase() ?? '#FFFFFF';
  const text =
    svg.match(/<text\b[^>]+\bfill=["'](#[\da-fA-F]{6})["']/u)?.[1]?.toUpperCase() ?? '#000000';
  const accents = colors.filter((color) => color !== background && color !== text);
  return [
    '# Presentation export lock',
    '',
    '## canvas',
    `- viewBox: ${viewBox ?? (plan.aspectRatio === '4:3' ? '0 0 960 720' : '0 0 960 540')}`,
    '',
    '## colors',
    `- bg: ${background}`,
    `- text: ${text}`,
    `- primary: ${accents[0] ?? text}`,
    `- accent: ${accents[1] ?? accents[0] ?? text}`,
    '',
    '## typography',
    `- font_family: ${family}`,
    `- title: ${title}`,
    `- body: ${body}`,
    ...(caption ? [`- caption: ${caption}`] : []),
    '',
    '## pptx_structure',
    '- mode: flat',
    '',
  ].join('\n');
};
