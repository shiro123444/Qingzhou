/** Replay a saved model response through current validation without a provider call. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { createMultimodalPresentationPlanner } from '../src/server/runtime/presentation/multimodal-planner-glm';
const [root, responseNumber, page] = process.argv.slice(2);
const snapshot = JSON.parse(await readFile(path.join(root, 'result.json'), 'utf8'));
const response = JSON.parse(
  await readFile(path.join(root, `response-${responseNumber}.json`), 'utf8'),
);
const input = snapshot.preparedAssets?.initial?.input ?? snapshot.input;
let calls = 0;
const planner = createMultimodalPresentationPlanner({
  chatPort: {
    providerId: 'offline-validation',
    manifest: {
      providerId: 'offline-validation',
      model: 'saved-response',
      displayName: 'Offline validation',
      supportsVision: false,
      supportsIdempotency: true,
    },
    chat: async (request) => {
      if (++calls > 1)
        console.log(JSON.stringify({ validationFeedback: request.messages.at(-1)?.content }));
      return response;
    },
  },
});
try {
  const result = await planner.plan(
    {
      ...input,
      slideCount: 1,
      options: {
        ...input.options,
        generatedImageSlots: input.options?.generatedImageSlots?.filter(
          (s: any) => s.slideId === `slide-${page}`,
        ),
      },
    },
    {
      scope: { userId: 'local-presentation-validation', sessionId: path.basename(root) },
      pagePass: true,
      pageIndex: Number(page) - 1,
      pageSlideId: `slide-${page}`,
    },
  );
  console.log(JSON.stringify({ passed: true, slide: result.slides[0].slideId }));
  if (!result.slides[0].svg.includes('artifact://')) {
    const preview = path.join(root, `response-${responseNumber}-validated.png`);
    await sharp(Buffer.from(result.slides[0].svg)).resize(1280).png().toFile(preview);
    await writeFile(
      path.join(root, `response-${responseNumber}-validated.svg`),
      result.slides[0].svg,
    );
    console.log(JSON.stringify({ preview }));
  }
} catch (error) {
  console.log(JSON.stringify({ passed: false, error: String(error) }));
  process.exitCode = 1;
}
