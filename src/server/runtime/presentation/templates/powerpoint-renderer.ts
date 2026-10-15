import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { TemplatePageRenderer } from './page-renderer';

const run = promisify(execFile);
// All paths are supplied as child environment values, never interpolated into shell code.
const script = `
$ErrorActionPreference = 'Stop'
$existing = @(Get-Process POWERPNT -ErrorAction SilentlyContinue)
$app = $null
$document = $null
$security = $null
try {
  $app = New-Object -ComObject PowerPoint.Application
  $security = $app.AutomationSecurity
  $app.AutomationSecurity = 3
  $document = $app.Presentations.Open($env:CORDIS_RENDER_INPUT, -1, 0, 0)
  $height = [int][Math]::Round(1400 * $document.PageSetup.SlideHeight / $document.PageSetup.SlideWidth)
  foreach ($number in $env:CORDIS_RENDER_PAGES.Split(',')) {
    $slide = $document.Slides.Item([int]$number)
    try { $slide.Export((Join-Path $env:CORDIS_RENDER_OUTPUT ('page-' + $number + '.jpg')), 'JPG', 1400, $height) }
    finally { [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($slide) }
  }
} finally {
  if ($document) { $document.Close(); [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) }
  if ($app) {
    if ($null -ne $security) { $app.AutomationSecurity = $security }
    if ($existing.Count -eq 0 -and $app.Presentations.Count -eq 0) { $app.Quit() }
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($app)
  }
}
`;
let queue = Promise.resolve();
async function removeRenderWorkspace(directory: string) {
  const target = path.resolve(directory);
  const child = path.relative(path.resolve(tmpdir()), target);
  if (!child || child.startsWith('..') || path.isAbsolute(child))
    throw new Error('Unexpected render workspace');
  await rm(target, { recursive: true, force: true });
}

/** Native Windows rendering on a read-only hidden document; never closes a user's existing deck. */
export const renderPowerPointTemplatePages: TemplatePageRenderer = async (bytes, pages, signal) => {
  if (
    process.platform !== 'win32' ||
    pages.length === 0 ||
    pages.length > 24 ||
    pages.some((page) => !Number.isInteger(page) || page < 1)
  )
    throw new Error('Windows PowerPoint renderer requires one to twenty-four valid pages');
  const previous = queue;
  let release!: () => void;
  queue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  let directory: string | undefined;
  try {
    signal?.throwIfAborted();
    directory = await mkdtemp(path.join(tmpdir(), 'qingzhou-ppt-render-'));
    const file = path.join(directory, 'source.pptx');
    await writeFile(file, bytes);
    await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        signal,
        timeout: 120000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          CORDIS_RENDER_INPUT: file,
          CORDIS_RENDER_OUTPUT: directory,
          CORDIS_RENDER_PAGES: pages.join(','),
        },
      },
    );
    return await Promise.all(
      pages.map(async (page) => ({
        page,
        bytes: new Uint8Array(await readFile(path.join(directory!, `page-${page}.jpg`))),
      })),
    );
  } finally {
    try {
      if (directory) {
        // Verify the resolved absolute target is a strict child of the OS temp root.
        await removeRenderWorkspace(directory);
      }
    } finally {
      release();
    }
  }
};
