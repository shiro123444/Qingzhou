import { readFileSync } from 'node:fs';

/** @type {import('node:module').ResolveHookSync} */
export const resolve = (specifier, context, nextResolve) => {
  try {
    return nextResolve(specifier, context);
  } catch (error) {
    // Workspace TS may call require() on ESM-only packages; modern Node can load
    // those modules synchronously, but the package must expose its import entry.
    if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED' || !context.conditions.includes('require'))
      throw error;
    return nextResolve(specifier, {
      ...context,
      conditions: [...context.conditions.filter((item) => item !== 'require'), 'import'],
    });
  }
};

/** Match the application's raw Markdown imports for trusted, bundled skill modules. */
/** @type {import('node:module').LoadHookSync} */
export const load = (url, context, nextLoad) => {
  // ts-md5 advertises its require build as .cjs.js inside a type:module package.
  // Bundlers handle this; standalone Node needs its actual CommonJS format.
  if (url.startsWith('file:') && new URL(url).pathname.endsWith('/ts-md5/dist/index.cjs.js'))
    return { format: 'commonjs', shortCircuit: true, source: readFileSync(new URL(url), 'utf8') };
  if (url.startsWith('file:') && new URL(url).pathname.endsWith('.md')) {
    const content = readFileSync(new URL(url), 'utf8');
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${JSON.stringify(content)};`,
    };
  }
  return nextLoad(url, context);
};
