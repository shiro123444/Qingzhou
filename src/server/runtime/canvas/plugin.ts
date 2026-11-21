import { z } from 'zod';

import { moveCanvasObject } from '../../../../packages/runtime-contracts/src/canvas';
import type { AtomicPlugin } from '../atomic-runtime';

const coordinate = z.number().finite();
const rect = z.object({
  x: coordinate,
  y: coordinate,
  width: coordinate.positive(),
  height: coordinate.positive(),
});
const id = z.string().min(1).max(128);

export function createCanvasPlugin(): AtomicPlugin {
  return {
    id: 'canvas',
    version: '1.0.0',
    operations: [
      {
        name: 'canvas.object.move',
        description:
          'Move one document object within its canvas, checking occupied regions in document units.',
        input: z
          .object({
            bounds: rect.strict(),
            objects: z.array(rect.extend({ id }).strict()),
            id,
            x: coordinate,
            y: coordinate,
          })
          .strict(),
        output: rect.strict(),
        execute: moveCanvasObject,
      },
    ],
  };
}
