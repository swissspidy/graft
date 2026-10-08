import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';

/**
 * Bundles the client into the plugin: build/runtime.js renders
 * customizations, build/admin.js is the Tools → Customizations screen.
 * React and @wordpress/* come from the globals WordPress already loads;
 * everything else (renderer, core runtime) is bundled.
 */

const pluginDir = fileURLToPath(new URL('../../plugin', import.meta.url));
const outDir = `${pluginDir}/build`;
const watch = process.argv.includes('--watch');

/** Import → [global expression, WordPress script handle]. */
const globals: Record<string, [string, string]> = {
	react: ['window.React', 'react'],
	'react-dom': ['window.ReactDOM', 'react-dom'],
	'react-dom/client': ['window.ReactDOM', 'react-dom'],
	'react/jsx-runtime': ['window.ReactJSXRuntime', 'react-jsx-runtime'],
	'@wordpress/components': ['window.wp.components', 'wp-components'],
	'@wordpress/api-fetch': ['window.wp.apiFetch', 'wp-api-fetch'],
};


const wordpressGlobals: Plugin = {
	name: 'wordpress-globals',
	setup(b) {
		const filter = new RegExp(`^(${Object.keys(globals).map((k) => k.replace(/[/.]/g, '\\$&')).join('|')})$`);
		b.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'wp-global' }));
		b.onLoad({ filter: /.*/, namespace: 'wp-global' }, (args) => {
			const [expression] = globals[args.path]!;
			return { contents: `module.exports = ${expression};`, loader: 'js' };
		});
	},
};

const options = {
	entryPoints: {
		runtime: fileURLToPath(new URL('../src/client/mount.tsx', import.meta.url)),
		admin: fileURLToPath(new URL('../src/client/admin.tsx', import.meta.url)),
		// Drawing A2UI builds: loaded before the runtime, only on screens that serve one.
		a2ui: fileURLToPath(new URL('../src/client/a2ui.tsx', import.meta.url)),
	},
	metafile: true,
	outdir: outDir,
	bundle: true,
	format: 'iife' as const,
	target: 'es2020',
	jsx: 'automatic' as const,
	minify: !watch,
	sourcemap: watch ? ('inline' as const) : false,
	legalComments: 'none' as const,
	plugins: [wordpressGlobals],
	// a2ui-wp draws A2UI builds; bundled from its copy in the repository until it is published.
	alias: { 'a2ui-wp': fileURLToPath(new URL('../../../../packages/a2ui-wp/src/index.ts', import.meta.url)) },
	// The sandbox endpoint is embedded as text for the in-browser sandbox.
	loader: { '.php': 'text' as const },
	logLevel: 'info' as const,
};

/**
 * The functions worker: QuickJS and the code runner, loaded only on screens
 * with a build that has code. Self-contained (no WordPress globals), with
 * QuickJS's .wasm copied next to it.
 */
const workerOptions = {
	entryPoints: { 'functions-worker': fileURLToPath(new URL('../../../../packages/sandbox/src/worker.ts', import.meta.url)) },
	outdir: outDir,
	bundle: true,
	format: 'iife' as const,
	target: 'es2020',
	minify: !watch,
	legalComments: 'none' as const,
	// Node built-ins the Emscripten loader only touches under Node.
	external: ['fs', 'path', 'url', 'module', 'crypto', 'worker_threads'],
	logLevel: 'info' as const,
};
const sandboxDir = fileURLToPath(new URL('../../../../packages/sandbox/', import.meta.url));
const variantDir = dirname(createRequire(sandboxDir).resolve('@jitl/quickjs-wasmfile-release-sync'));

await mkdir(outDir, { recursive: true });
await copyFile(`${variantDir}/emscripten-module.wasm`, `${outDir}/quickjs.wasm`);
// Built once in watch mode too: it changes with @graft/sandbox, not with the client.
await build(workerOptions);
// The plugin reads the shared lifecycle table at runtime.
await copyFile(fileURLToPath(new URL('../../../../schemas/spec-lifecycle.json', import.meta.url)), `${outDir}/spec-lifecycle.json`);
if (watch) {
	const { context } = await import('esbuild');
	await (await context(options)).watch();
} else {
	const result = await build(options);
	// One asset file per entry, with the WordPress scripts that entry uses.
	for (const [output, meta] of Object.entries(result.metafile!.outputs)) {
		const name = output.replace(/^.*\//, '').replace(/\.js$/, '');
		const handles = [
			...new Set(
				Object.keys(meta.inputs)
					.filter((input) => input.startsWith('wp-global:'))
					.map((input) => globals[input.slice('wp-global:'.length)]![1]),
			),
		].sort();
		const js = await readFile(`${outDir}/${name}.js`);
		const version = createHash('sha256').update(js).digest('hex').slice(0, 20);
		await writeFile(
			`${outDir}/${name}.asset.php`,
			`<?php return array( 'dependencies' => array( ${handles.map((h) => `'${h}'`).join(', ')} ), 'version' => '${version}' );\n`,
		);
		console.log(`${name}.asset.php: ${handles.join(', ')}`);
	}
}
