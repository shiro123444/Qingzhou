import { afterEach, describe, expect, it, vi } from 'vitest';

import { presentationTemplateClient } from './templateClient';

afterEach(() => vi.restoreAllMocks());

describe('presentationTemplateClient', () => {
  it('uploads multipart bytes with same-origin credentials and leaves boundary generation to fetch', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          layouts: [{ layoutId: 'cover' }],
          name: 'Reference',
          templateId: 'template-1',
          versionId: 'v1',
        }),
      ),
    );
    const file = new File(['source bytes'], 'reference.pptx');
    const result = await presentationTemplateClient.importPptx(file, 'Reference');
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('/api/runtime/presentation/templates/import');
    expect(options?.credentials).toBe('same-origin');
    expect(options?.headers).toBeUndefined();
    expect(options?.body).toBeInstanceOf(FormData);
    expect((options?.body as FormData).get('file')).toBe(file);
    expect(result.layoutCount).toBe(1);
  });

  it('preserves server error messages so failed template applications are visible', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Template version was not found' } }), {
        status: 404,
      }),
    );
    await expect(
      presentationTemplateClient.apply('job-1', {
        requestId: 'request-1',
        templateId: 'template-1',
        versionId: 'missing-version',
      }),
    ).rejects.toThrow('Template version was not found');
  });

  it('resumes visual learning with the exact answered question', async () => {
    const response = {
      learning: { guidanceHistory: ['answer'], iteration: 2, questions: [], status: 'ready' },
      templateId: 'template-1',
      versionId: 'v1',
    } as const;
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(response)));
    await expect(
      presentationTemplateClient.analyze(
        { name: 'Reference', templateId: 'template-1', versionId: 'v1' },
        'Keep the video',
        'video-role',
        'preserve',
      ),
    ).resolves.toEqual(response);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('/api/runtime/presentation/tools/presentation.template.analyzeVisual');
    expect(JSON.parse(String(options?.body))).toEqual({
      guidance: 'Keep the video',
      questionId: 'video-role',
      choiceId: 'preserve',
      templateId: 'template-1',
      versionId: 'v1',
    });
  });

  it('deletes an owned template through the scoped template endpoint', async () => {
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ deleted: true }), { status: 200 }));

    await presentationTemplateClient.remove('template / 1');

    expect(fetcher).toHaveBeenCalledWith(
      '/api/runtime/presentation/templates/template%20%2F%201',
      expect.objectContaining({ credentials: 'same-origin', method: 'DELETE' }),
    );
  });
});
