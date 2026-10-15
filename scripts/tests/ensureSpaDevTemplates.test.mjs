import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ensureSpaDevTemplates } from '../_shared/ensureSpaDevTemplates.ts';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'qingzhou-spa-template-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'src/app/spa/[variants]/[[...path]]');
  mkdirSync(directory, { recursive: true });
  return { root, target: path.join(directory, 'spaHtmlTemplates.ts') };
}

test('clean development checkout gets resolvable desktop and mobile exports', async (t) => {
  const { root, target } = fixture(t);
  const desktop = '<html>desktop "quoted"\n中文</html>';
  const mobile = '<html>mobile</html>';
  writeFileSync(path.join(root, 'index.html'), desktop);
  writeFileSync(path.join(root, 'index.mobile.html'), mobile);
  ensureSpaDevTemplates(root);
  const generated = readFileSync(target, 'utf8');
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(generated).toString('base64')}`
  );
  assert.equal(module.desktopHtmlTemplate, desktop);
  assert.equal(module.mobileHtmlTemplate, mobile);
});

test('startup preserves an existing production template and is repeatable', (t) => {
  const { root, target } = fixture(t);
  const production = 'export const desktopHtmlTemplate = "production asset hashes";';
  writeFileSync(target, production);
  ensureSpaDevTemplates(root);
  ensureSpaDevTemplates(root);
  assert.equal(readFileSync(target, 'utf8'), production);
});
