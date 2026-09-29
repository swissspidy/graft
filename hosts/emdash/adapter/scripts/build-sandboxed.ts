import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { emdashVersion } from '../src/index.ts';

/**
 * Bundles the standard-format plugin (src/plugin/standard.ts) into one
 * module for the EmDash plugin sandbox: dist/sandbox-entry.mjs. Sandboxed
 * plugins cannot import packages at runtime, and Ajv is left out (the
 * sandbox forbids generated code; the plugin uses the cfworker engine).
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const site = fileURLToPath(new URL('../../site/', import.meta.url));
const stub = fileURLToPath(new URL('./ajv-stub.ts', import.meta.url));

await mkdir(`${root}dist`, { recursive: true });
const result = await build({
	entryPoints: [`${root}src/plugin/standard.ts`],
	outfile: `${root}dist/sandbox-entry.mjs`,
	bundle: true,
	format: 'esm',
	platform: 'browser',
	target: 'es2022',
	mainFields: ['module', 'main'],
	conditions: ['workerd', 'worker', 'browser', 'import'],
	alias: { ajv: stub, 'ajv/dist/2020.js': stub, 'ajv-formats': stub },
	// workerd runs plugins with nodejs_compat; the SDK imports Node built-ins for tools this plugin does not use.
	external: ['emdash', 'node:*'],
	define: { __GRAFT_EMDASH_VERSION__: JSON.stringify(emdashVersion(site)) },
	legalComments: 'none',
	metafile: true,
	logLevel: 'warning',
});
const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
await writeFile(`${root}dist/.gitignore`, '*\n');
console.log(`Wrote dist/sandbox-entry.mjs (${Math.round(bytes / 1024)} KB)`);
