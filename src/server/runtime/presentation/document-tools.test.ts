import { PDFDocument } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { AtomicRuntime } from '../atomic-runtime';
import { createPresentationContextRuntime } from './context-tools';
import {
  presentationDocumentOperations,
  type PresentationDocumentServices,
} from './document-tools';
import { createMaterialDocument } from './material-document';

const scope = { userId: 'alice', sessionId: 'account' };

describe('composable document tools', () => {
  it('lets agents find and read later sections, rejects foreign/stale IDs, and exports whole text without dropping its tail', async () => {
    const content = '前文\n'.repeat(14000) + '末尾预算37万元';
    const document = createMaterialDocument({ sourceId: 'a', name: 'research.txt', content });
    const saved: Uint8Array[] = [];
    const services: PresentationDocumentServices = {
      load: async () => document,
      loadPdf: vi.fn(),
      save: async ({ name, bytes }) => {
        saved.push(bytes);
        return {
          id: 'attachment-a',
          name,
          url: '/api/runtime/presentation/artifacts/attachment-a?raw=true',
        };
      },
    };
    const runtime = createPresentationContextRuntime({
      documents: services,
      readFile: vi.fn(),
      readSkill: vi.fn(),
      listSkills: async () => [],
      search: vi.fn(),
    });
    try {
      const catalog = await runtime.invoke<any>(
        'context.document.inspect',
        { id: 'a', limit: 1 },
        { scope },
      );
      expect(catalog.nextOffset).toBe(1);
      const tail = await runtime.invoke<any>(
        'context.document.read',
        { id: 'a', segmentIds: [document.segments.at(-1)!.id] },
        { scope },
      );
      expect(tail.segments[0].text).toContain('末尾预算37万元');
      await expect(
        runtime.invoke('context.document.read', { id: 'a', segmentIds: ['foreign'] }, { scope }),
      ).rejects.toThrow('不属于');
      await runtime.invoke('context.document.convert', { id: 'a', format: 'markdown' }, { scope });
      expect(new TextDecoder().decode(saved[0])).toContain('末尾预算37万元');
      expect(new TextDecoder().decode(saved[0])).toContain(
        '版本：' + document.manifest.fingerprint,
      );
    } finally {
      await runtime.dispose();
    }
  });

  it('splits real PDF pages into owned artifacts and keeps source pages unchanged', async () => {
    const source = await PDFDocument.create();
    source.addPage([300, 400]);
    source.addPage([320, 420]);
    source.addPage([340, 440]);
    const original = await source.save();
    const saved: { name: string; bytes: Uint8Array; metadata: Record<string, unknown> }[] = [];
    const runtime = new AtomicRuntime([
      {
        id: 'context',
        version: '1',
        operations: presentationDocumentOperations({
          load: vi.fn(),
          loadPdf: async () => ({ name: 'report.pdf', bytes: original }),
          save: async (input) => {
            saved.push(input);
            return {
              id: 'attachment-a',
              url: '/api/runtime/presentation/artifacts/attachment-a?raw=true',
              name: input.name,
            };
          },
        }),
      },
    ]);
    try {
      const result = await runtime.invoke<any>(
        'context.document.splitPdf',
        {
          id: 'a',
          ranges: [
            { from: 2, to: 3 },
            { from: 1, to: 1 },
          ],
        },
        { scope },
      );
      expect(result.artifacts.map((artifact: any) => artifact.pageCount)).toEqual([2, 1]);
      const split = await PDFDocument.load(saved[0].bytes);
      expect(split.getPages().map((page) => page.getSize())).toEqual([
        { width: 320, height: 420 },
        { width: 340, height: 440 },
      ]);
      expect(saved[0].metadata).toMatchObject({ sourceId: 'a', pages: { from: 2, to: 3 } });
      expect((await PDFDocument.load(original)).getPageCount()).toBe(3);
      await expect(
        runtime.invoke(
          'context.document.splitPdf',
          { id: 'a', ranges: [{ from: 4, to: 4 }] },
          { scope },
        ),
      ).rejects.toThrow('页码范围');
      expect(saved).toHaveLength(2);
    } finally {
      await runtime.dispose();
    }
  });
});
