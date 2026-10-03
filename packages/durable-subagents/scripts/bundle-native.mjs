import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFile, readdir, writeFile } from 'node:fs/promises';
const root = fileURLToPath(new URL('..', import.meta.url));
const result = await build({ entryPoints: [`${root}/src/pi/extension.ts`], outfile: `${root}/dist/pi/extension.bundle.cjs`, bundle: true, platform: 'node', target: 'node22.19', format: 'cjs', minify: true, legalComments: 'linked', metafile: true, logLevel: 'warning' });
// Keep upstream notices beside the shipped bundle, including packages whose
// emitted JavaScript has no license comment for esbuild to retain.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes('node_modules/')) continue;
  let directory = dirname(resolve(input));
  while (directory.includes('node_modules')) {
    try {
      const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
      if (manifest.name && manifest.version) { packages.set(directory, manifest); break; }
    } catch {}
    directory = dirname(directory);
  }
}
const notices = [];
const included = new Set();
for (const [directory, manifest] of [...packages].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
  const identity = `${manifest.name}@${manifest.version}`;
  if (included.has(identity)) continue;
  included.add(identity);
  const licenses = (await readdir(directory)).filter(name => /^(license|licence|copying|notice)(\.|$)/i.test(name)).sort();
  const text = licenses.length
    ? (await Promise.all(licenses.map(name => readFile(resolve(directory, name), 'utf8')))).join('\n')
    : manifest.name.startsWith('@earendil-works/')
      ? await readFile(`${root}/scripts/licenses/earendil-pi-LICENSE.txt`, 'utf8')
      : '';
  if (!text) throw new Error(`Missing bundled dependency license notice: ${identity}`);
  notices.push(`${identity} (${manifest.license ?? 'see upstream notice'})\n${text}`);
}
await writeFile(`${root}/dist/pi/THIRD-PARTY-LICENSES.txt`, notices.join('\n\n--------------------\n\n') + '\n');
