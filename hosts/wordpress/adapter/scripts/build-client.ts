import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';

/**
 * Bundles the client runtime into the plugin (plugin/build/runtime.js).
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

const used = new Set<string>();

const wordpressGlobals: Plugin = {
	name: 'wordpress-globals',
	setup(b) {
		const filter = new RegExp(`^(${Object.keys(globals).map((k) => k.replace(/[/.]/g, '\\$&')).join('|')})$`);
		b.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'wp-global' }));
		b.onLoad({ filter: /.*/, namespace: 'wp-global' }, (args) => {
			const [expression, handle] = globals[args.path]!;
			used.add(handle);
			return { contents: `module.exports = ${expression};`, loader: 'js' };
		});
	},
};

const options = {
	entryPoints: { runtime: fileURLToPath(new URL('../src/client/mount.tsx', import.meta.url)) },
	outdir: outDir,
	bundle: true,
	format: 'iife' as const,
	target: 'es2020',
	jsx: 'automatic' as const,
	minify: !watch,
	sourcemap: watch ? ('inline' as const) : false,
	legalComments: 'none' as const,
	plugins: [wordpressGlobals],
	logLevel: 'info' as const,
};

await mkdir(outDir, { recursive: true });
// The plugin reads the shared lifecycle table at runtime.
await copyFile(fileURLToPath(new URL('../../../../schemas/spec-lifecycle.json', import.meta.url)), `${outDir}/spec-lifecycle.json`);
if (watch) {
	const { context } = await import('esbuild');
	await (await context(options)).watch();
} else {
	await build(options);
	const js = await readFile(`${outDir}/runtime.js`);
	const version = createHash('sha256').update(js).digest('hex').slice(0, 20);
	const dependencies = [...used].sort().map((h) => `'${h}'`).join(', ');
	await writeFile(
		`${outDir}/runtime.asset.php`,
		`<?php return array( 'dependencies' => array( ${dependencies} ), 'version' => '${version}' );\n`,
	);
	console.log(`runtime.asset.php: ${[...used].sort().join(', ')}`);
}
