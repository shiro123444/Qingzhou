import { z } from 'zod';

import type { AtomicOperation } from '../atomic-runtime';
import {
  minimumScientificDiagramSize,
  renderScientificDiagram,
  semanticBlockSchema,
} from './semantic-blocks';

/** Shared by the presentation studio and channel capability tools. */
export const presentationVectorOperations = (): AtomicOperation[] => [
  {
    name: 'presentation.formula.measure',
    description:
      'Measure LaTeX before layout using the same vector engine as final rendering. Reserve the returned minimum rectangle without shrinking.',
    input: z
      .object({
        latex: z.string().trim().min(1).max(2000),
        display: z.boolean().default(true),
        fontSize: z.number().finite().min(24).max(64).default(28),
      })
      .strict(),
    execute: async (input) => (await import('./formula-renderer')).measureFormula(input),
  },
  {
    name: 'presentation.formula.render',
    description:
      'Render validated LaTeX into self-contained vector paths while retaining editable source.',
    input: semanticBlockSchema.options[0],
    execute: async (input) => ({
      svg: await (await import('./formula-renderer')).renderFormula(input),
      source: input,
    }),
  },
  {
    name: 'presentation.diagram.measure',
    description:
      'Measure the minimum width and height for a scientific diagram, including plot legends, before assigning its page rectangle.',
    input: z
      .object({
        block: semanticBlockSchema.options[1],
        width: z.number().finite().min(280).max(960),
      })
      .strict(),
    execute: ({ block, width }) => minimumScientificDiagramSize(block, width),
  },
  {
    name: 'presentation.diagram.render',
    description:
      'Render scientific plot or graph data deterministically with explicit illustrative or sourced provenance.',
    input: semanticBlockSchema.options[1],
    execute: (input) => ({ svg: renderScientificDiagram(input), source: input }),
  },
];
