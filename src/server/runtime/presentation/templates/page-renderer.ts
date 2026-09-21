import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const directory = await mkdtemp(join(tmpdir(), 'jumi-template-vision-'));
  const options = { signal, timeout: 120_000, maxBuffer: 1024 * 1024 };
  try {
    const file = join(directory, 'source.pptx');
    await writeFile(file, bytes, { mode: 0o600 });
    await run(
      'libreoffice',
      [
        `-env:UserInstallation=${pathToFileURL(join(directory, 'profile')).href}`,
        '--headless',
        '--convert-to',
        'pdf',
        '--outdir',
        directory,
        file,
      ],
      options,
    );
    const rendered = [];
    for (const page of pages) {
      const target = join(directory, `page-${page}`);
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
          join(directory, 'source.pdf'),
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
