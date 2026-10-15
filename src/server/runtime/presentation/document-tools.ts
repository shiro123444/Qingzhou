import { z } from 'zod';

import { assertAtomicInvocationActive, type AtomicOperation } from '../atomic-runtime';
import type { MaterialDocument } from './material-document';
import { createMaterialDocument } from './material-document';

export interface PresentationDocumentServices {
  load: (id: string) => Promise<MaterialDocument>;
  loadPdf: (id: string) => Promise<{ name: string; bytes: Uint8Array }>;
  save: (input: {
    name: string;
    bytes: Uint8Array;
    mimeType: string;
    metadata: Record<string, unknown>;
  }) => Promise<{ id: string; url: string; name: string }>;
}

const selection = z.array(z.string().min(1).max(240)).min(1).max(8);
function selectSegments(document: MaterialDocument, ids: readonly string[]) {
  const selected = document.segments.filter((segment) => ids.includes(segment.id));
  if (new Set(ids).size !== ids.length || selected.length !== ids.length)
    throw new Error('所选段落不属于当前资料版本，请重新查看目录');
  return selected;
}

export function presentationDocumentOperations(
  services: PresentationDocumentServices,
): AtomicOperation[] {
  return [
    {
      name: 'context.document.fromText',
      agent: { contexts: ['presentation.intake'], maxCalls: 4 },
      description:
        'Save user-pasted text or a clearly identified working draft as an owned text material for inspection, conversion and storyboard composition. Do not fabricate external evidence. Returns a downloadable attachment and the first eight read segments; use inspect/read for the rest.',
      input: z
        .object({
          name: z
            .string()
            .trim()
            .min(1)
            .max(160)
            .regex(/^[^/\\]+$/u),
          text: z.string().trim().min(1).max(240000),
        })
        .strict(),
      execute: async ({ name, text }) => {
        const artifact = await services.save({
          name: `${name.replace(/\.txt$/iu, '')}.txt`,
          bytes: new TextEncoder().encode(text),
          mimeType: 'text/plain',
          metadata: { operation: 'document.fromText', sourceType: 'user-text-or-draft' },
        });
        const document = createMaterialDocument({
          sourceId: artifact.id,
          name: artifact.name,
          content: text,
        });
        return {
          artifact,
          document: { ...document.manifest, segments: document.manifest.segments.slice(0, 40) },
          segments: document.segments.slice(0, 8),
          truncated: document.segments.length > 8,
        };
      },
    },
    {
      name: 'context.document.inspect',
      agent: { contexts: ['presentation.intake'] },
      description:
        'Inspect an owned PDF/Word/text/spreadsheet document by pages or logical sections. Returns a paginated catalog, content fingerprint and empty/scanned pages; catalog entries are not read evidence. Use read to get exact text, including later pages.',
      input: z
        .object({
          id: z.string().min(1),
          offset: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(80).default(40),
        })
        .strict(),
      execute: async ({ id, offset, limit }) => {
        const { manifest } = await services.load(id);
        return {
          document: { ...manifest, segments: manifest.segments.slice(offset, offset + limit) },
          nextOffset: offset + limit < manifest.totalSegments ? offset + limit : null,
        };
      },
    },
    {
      name: 'context.document.read',
      agent: { contexts: ['presentation.intake'] },
      description:
        'Read 1–8 exact catalog segments from an owned source. Returns page/section locators and stable source IDs for storyboards. Keep facts and provenance, and combine segments from multiple materials. Empty/scanned pages require a readable/OCR source; never infer their content.',
      input: z.object({ id: z.string().min(1), segmentIds: selection }).strict(),
      execute: async ({ id, segmentIds }) => {
        const document = await services.load(id);
        const segments = selectSegments(document, segmentIds);
        return {
          document: {
            ...document.manifest,
            segments: document.manifest.segments.filter((segment) =>
              segmentIds.includes(segment.id),
            ),
          },
          segments,
        };
      },
    },
    {
      name: 'context.document.convert',
      agent: { contexts: ['presentation.intake'], maxCalls: 4 },
      description:
        'Convert parsed PDF/Word/text/table content to a real downloadable Markdown or plain-text attachment. Preserves original page/section labels and lineage. This is text conversion, not a lossless visual conversion or OCR. Omit segmentIds to convert the whole source.',
      input: z
        .object({
          id: z.string().min(1),
          format: z.enum(['markdown', 'text']),
          segmentIds: selection.optional(),
        })
        .strict(),
      execute: async ({ id, format, segmentIds }) => {
        const document = await services.load(id);
        if (
          !segmentIds &&
          document.manifest.emptyPages.length &&
          document.manifest.format === 'pdf'
        )
          throw new Error(
            'PDF 含无正文页面，文字转换不能保留这些页面的内容；请先提供 OCR 正文或选择可读取的段落',
          );
        const segments = segmentIds ? selectSegments(document, segmentIds) : document.segments;
        if (!segments.length) throw new Error('资料没有可转换的正文');
        const text = [
          `${format === 'markdown' ? '# ' : ''}${document.manifest.name}`,
          `来源：${id}；版本：${document.manifest.fingerprint}`,
          ...segments.map(
            (segment) =>
              `${format === 'markdown' ? '## ' : ''}${segment.locator.page ? `第 ${segment.locator.page} 页` : `第 ${segment.locator.section} 节`} / 段 ${segment.locator.chunk}\n${segment.text}`,
          ),
        ].join('\n\n');
        const artifact = await services.save({
          name: `${document.manifest.name.replace(/\.[^.]+$/u, '')}.${format === 'markdown' ? 'md' : 'txt'}`,
          bytes: new TextEncoder().encode(text),
          mimeType: format === 'markdown' ? 'text/markdown' : 'text/plain',
          metadata: {
            sourceId: id,
            sourceFingerprint: document.manifest.fingerprint,
            segmentIds: segments.map((segment) => segment.id),
            operation: 'document.convert',
          },
        });
        return { artifact, sourceId: id, segmentCount: segments.length };
      },
    },
    {
      name: 'context.document.splitPdf',
      agent: { contexts: ['presentation.intake'], maxCalls: 4 },
      description:
        'Split an owned PDF into real downloadable PDF files using 1-based inclusive page ranges. Preserves page artwork and the original; use inspect/read to select relevant chapters before splitting. Returned artifacts can be read and converted as subsequent materials.',
      input: z
        .object({
          id: z.string().min(1),
          ranges: z
            .array(
              z
                .object({ from: z.number().int().positive(), to: z.number().int().positive() })
                .strict(),
            )
            .min(1)
            .max(8),
        })
        .strict(),
      execute: async (
        { id, ranges }: { id: string; ranges: { from: number; to: number }[] },
        invocation,
      ) => {
        const { PDFDocument } = await import('pdf-lib');
        const source = await services.loadPdf(id);
        assertAtomicInvocationActive(invocation);
        const pdf = await PDFDocument.load(source.bytes);
        const pageCount = pdf.getPageCount();
        if (
          ranges.some((range) => range.from > range.to || range.to > pageCount) ||
          ranges.reduce((sum, range) => sum + range.to - range.from + 1, 0) > 500
        )
          throw new Error('PDF 页码范围无效或一次拆分超过 500 页');
        const artifacts = [];
        for (const range of ranges) {
          assertAtomicInvocationActive(invocation);
          const output = await PDFDocument.create();
          const pages = await output.copyPages(
            pdf,
            Array.from({ length: range.to - range.from + 1 }, (_, index) => range.from - 1 + index),
          );
          for (const page of pages) output.addPage(page);
          assertAtomicInvocationActive(invocation);
          const artifact = await services.save({
            name: `${source.name.replace(/\.pdf$/iu, '')}-${range.from}-${range.to}.pdf`,
            bytes: await output.save(),
            mimeType: 'application/pdf',
            metadata: { sourceId: id, pages: range, operation: 'document.splitPdf' },
          });
          artifacts.push({ ...artifact, sourceId: id, pages: range, pageCount: pages.length });
        }
        return { sourceId: id, pageCount, artifacts };
      },
    },
  ];
}
