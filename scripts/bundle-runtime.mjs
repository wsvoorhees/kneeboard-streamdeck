import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Koffi loads a native binary at runtime; Rollup must leave it external. Copy the
// Windows dependency beside the bundle so an installed plugin needs no npm tree.
const plugin = resolve('com.willvoorhees.kneeboard-streamdeck.sdPlugin');
const source = resolve('node_modules');
const destination = join(plugin, 'node_modules');
const packages = ['koffi', '@koromix/koffi-win32-x64'];
for (const name of packages) {
  try { await stat(join(source, name)); }
  catch { throw new Error(`Missing ${name}. Run npm ci on Windows before bundling.`); }
}
await rm(destination, { recursive: true, force: true });
await mkdir(join(destination, '@koromix'), { recursive: true });
for (const name of packages) {
  await cp(join(source, name), join(destination, name), { recursive: true });
}
console.log('Bundled koffi and its Windows x64 binary into the plugin.');
