import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import type { CustomizationBundle, Surface } from '@swissspidy/graft-core';
import { extensionManifest } from '../src/extension/manifest.ts';

/**
 * Builds the unpacked extension into dist/extension: the service worker,
 * content script and options page bundled (no code is fetched at run
 * time), the manifest derived from the app surfaces, and the surfaces and
 * customization bundles it ships with under graft/.
 *
 *   tsx scripts/build-extension.ts [--surface <file>]... [--bundle <file>]... [--out <dir>]
 *
 * Defaults: the Tasklet surface and the example bundle.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const stub = fileURLToPath(new URL('./ajv-stub.ts', import.meta.url));

const { values } = parseArgs({
	options: {
		surface: { type: 'string', multiple: true },
		bundle: { type: 'string', multiple: true },
		out: { type: 'string' },
	},
});
const out = values.out ?? `${root}dist/extension`;
const surfaces = values.surface ?? [`${root}surfaces/tasklet.json`];
const bundles = values.bundle ?? [`${repo}examples/chrome-extension/bundles/my-tasks.json`];

await rm(out, { recursive: true, force: true });
await mkdir(`${out}/graft`, { recursive: true });

const common = {
	bundle: true,
	platform: 'browser' as const,
	target: 'chrome120',
	mainFields: ['module', 'main'],
	conditions: ['worker', 'browser', 'import'],
	// Manifest V3 forbids generated code: Ajv is left out, the service worker validates with the cfworker engine.
	alias: { ajv: stub, 'ajv/dist/2020.js': stub, 'ajv-formats': stub },
	legalComments: 'none' as const,
	minify: true,
	keepNames: true,
	metafile: true,
	logLevel: 'warning' as const,
};
const results = await Promise.all([
	build({ ...common, entryPoints: [`${root}src/extension/background.ts`], outfile: `${out}/background.js`, format: 'esm' }),
	build({ ...common, entryPoints: [`${root}src/extension/content.ts`], outfile: `${out}/content.js`, format: 'iife' }),
	build({ ...common, entryPoints: [`${root}src/extension/options.ts`], outfile: `${out}/options.js`, format: 'iife' }),
]);
await copyFile(`${root}src/extension/options.html`, `${out}/options.html`);
await copyFile(`${root}src/extension/options.css`, `${out}/options.css`);

const loaded = await Promise.all(surfaces.map(async (file) => JSON.parse(await readFile(file, 'utf8')) as Surface));
const loadedBundles = await Promise.all(bundles.map(async (file) => JSON.parse(await readFile(file, 'utf8')) as CustomizationBundle));
await writeFile(`${out}/graft/surfaces.json`, JSON.stringify(loaded));
await writeFile(`${out}/graft/customizations.json`, JSON.stringify(loadedBundles));
const { version } = JSON.parse(await readFile(`${root}package.json`, 'utf8')) as { version: string };
await writeFile(`${out}/manifest.json`, `${JSON.stringify(extensionManifest(loaded, version === '0.0.0' ? '0.0.1' : version), null, 2)}\n`);
await mkdir(`${root}dist`, { recursive: true });
await writeFile(`${root}dist/.gitignore`, '*\n');

// Manifest V3 refuses generated code: make sure none slipped into a bundle through a dependency.
for (const file of ['background.js', 'content.js', 'options.js']) {
	const code = await readFile(`${out}/${file}`, 'utf8');
	if (/\bnew Function\s*\(|\beval\s*\(/.test(code)) {
		throw new Error(`${file} contains generated code (eval or new Function), which Manifest V3 refuses.`);
	}
}

for (const result of results) {
	for (const [file, output] of Object.entries(result.metafile?.outputs ?? {})) {
		console.log(`${file.replace(repo, '')} ${Math.round(output.bytes / 1024)} KB`);
	}
}
console.log(`Wrote the unpacked extension to ${out.replace(repo, '')}: ${loaded.length} app surface(s), ${loadedBundles.length} customization(s).`);
