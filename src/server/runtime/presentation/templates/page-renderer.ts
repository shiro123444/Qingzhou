import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
export type TemplatePageRenderer = (
  bytes: Uint8Array,
  pages: number[],
  signal?: AbortSignal,
) => Promise<{ page: number; bytes: Uint8Array }[]>;

/** Render the native document; an XML approximation cannot reveal raster-only template design. */
export const renderNativeTemplatePages: TemplatePageRenderer = async (bytes, pages, signal) => {
  if (pages.length > 24 || pages.some((page) => !Number.isInteger(page) || page < 1))
    throw new Error('Select one to twenty-four template pages');
  const directory = await mkdtemp(path.join(tmpdir(), 'jumi-template-vision-'));
  const options = { signal, timeout: 120_000, maxBuffer: 1024 * 1024 };
  try {
    if (process.platform === 'win32') {
      try {
        const { renderPowerPointTemplatePages } = await import('./powerpoint-renderer');
        return await renderPowerPointTemplatePages(bytes, pages, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    const file = path.join(directory, 'source.pptx');
    await writeFile(file, bytes, { mode: 0o600 });
    await run(
      process.platform === 'win32'
        ? 'C:/Program Files/LibreOffice/program/soffice.com'
        : 'libreoffice',
      [
        `-env:UserInstallation=${pathToFileURL(path.join(directory, 'profile')).href}`,
        '--headless',
        '--convert-to',
        'pdf:impress_pdf_Export:{"ExportHiddenSlides":{"type":"boolean","value":"true"}}',
        '--outdir',
        directory,
        file,
      ],
      options,
    );
    const rendered = [];
    for (const page of pages) {
      const target = path.join(directory, `page-${page}`);
      await run(
        'pdftoppm',
        [
          '-f',
          String(page),
          '-l',
          String(page),
          '-scale-to',
          '1400',
          '-singlefile',
          '-jpeg',
          '-jpegopt',
          'quality=86',
          path.join(directory, 'source.pdf'),
          target,
        ],
        options,
      );
      rendered.push({ page, bytes: new Uint8Array(await readFile(`${target}.jpg`)) });
    }
    return rendered;
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('模板页面渲染失败，请检查 LibreOffice 与 PDF 渲染服务', { cause: error });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
