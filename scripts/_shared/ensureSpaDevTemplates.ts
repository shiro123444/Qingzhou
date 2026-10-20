import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Make the production-only import resolvable in a clean development checkout. */
export function ensureSpaDevTemplates(root: string) {
  const target = path.resolve(root, 'src/app/spa/[variants]/[[...path]]/spaHtmlTemplates.ts');
  if (existsSync(target)) return;

  // Development serves transformed HTML from Vite. These source templates only
  // satisfy the bundler; generateSpaTemplates.mts replaces them for production.
  const desktop = readFileSync(path.resolve(root, 'index.html'), 'utf8');
  const mobile = readFileSync(path.resolve(root, 'index.mobile.html'), 'utf8');
  writeFileSync(
    target,
    `// Auto-generated for development; production builds replace this file.\nexport const desktopHtmlTemplate = ${JSON.stringify(desktop)};\nexport const mobileHtmlTemplate = ${JSON.stringify(mobile)};\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
}
