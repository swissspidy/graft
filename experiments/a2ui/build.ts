import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'esbuild';

// esbuild is the WordPress adapter's dependency.
const { build } = createRequire(new URL('../../hosts/wordpress/adapter/', import.meta.url))('esbuild') as typeof import('esbuild');

/**
 * Bundles the proof of concept's client like the plugin's: React and
 * @wordpress/* come from WordPress's globals. a2ui-wp also uses
 * @wordpress/element and @wordpress/i18n; its icons are stubbed (this
 * build draws no icons).
 */

const globals: Record<string, string> = {
	react: 'window.React',
	'react-dom': 'window.ReactDOM',
	'react-dom/client': 'window.ReactDOM',
	'react/jsx-runtime': 'window.ReactJSXRuntime',
	'@wordpress/components': 'window.wp.components',
	'@wordpress/api-fetch': 'window.wp.apiFetch',
	'@wordpress/element': 'window.wp.element',
	'@wordpress/i18n': 'window.wp.i18n',
	'@wordpress/icons': 'new Proxy({}, { get: () => null })',
};

const wordpressGlobals: Plugin = {
	name: 'wordpress-globals',
	setup(b) {
		const filter = new RegExp(`^(${Object.keys(globals).map((k) => k.replace(/[/.]/g, '\\$&')).join('|')})$`);
		b.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'wp-global' }));
		b.onLoad({ filter: /.*/, namespace: 'wp-global' }, (args) => ({ contents: `module.exports = ${globals[args.path]};`, loader: 'js' }));
	},
};

await build({
	entryPoints: { client: fileURLToPath(new URL('./client.tsx', import.meta.url)) },
	outdir: fileURLToPath(new URL('./build', import.meta.url)),
	bundle: true,
	format: 'iife',
	target: 'es2020',
	jsx: 'automatic',
	legalComments: 'none',
	plugins: [wordpressGlobals],
	logLevel: 'info',
});
