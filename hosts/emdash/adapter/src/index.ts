import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginDescriptor } from 'emdash';
import { adminPages, adminWidgets, allowedHosts, capabilities, editorPanels, PLUGIN_ID, PLUGIN_VERSION, routePermissions, settingsSchema } from './plugin/manifest.ts';

/**
 * The Graft plugin descriptor for astro.config:
 *
 *   emdash({ plugins: [graft()] })
 *
 * Runs at config time only; the plugin itself is ./plugin/index.ts.
 */
export function graft(options: { sandbox?: boolean; allowedHosts?: string[] } = {}): PluginDescriptor {
	return {
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		entrypoint: '@graft/emdash/plugin',
		options: { emdashVersion: emdashVersion(), sandbox: options.sandbox === true, allowedHosts: options.allowedHosts ?? [] },
	};
}

/**
 * The same plugin in EmDash's standard format, run in the plugin sandbox:
 *
 *   emdash({ sandboxed: [graftSandboxed()], sandboxRunner: '@emdash-cms/sandbox-workerd' })
 *
 * Needs the bundle built first (pnpm build:emdash). The verification
 * sandbox route is not offered here.
 */
export function graftSandboxed(options: { allowedHosts?: string[] } = {}): PluginDescriptor {
	const { sandbox: _sandbox, ...routes } = routePermissions;
	return {
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		format: 'standard',
		entrypoint: fileURLToPath(new URL('../dist/sandbox-entry.mjs', import.meta.url)),
		capabilities: [...capabilities],
		allowedHosts: [...allowedHosts, ...(options.allowedHosts ?? [])],
		storage: {},
		hooks: [],
		routes: Object.entries(routes).map(([name, permission]) => ({ name, permission })) as NonNullable<PluginDescriptor['routes']>,
		adminPages,
		adminWidgets,
		editorPanels,
		settingsSchema,
	};
}

/** The installed EmDash version, from its package.json. */
export function emdashVersion(from = process.cwd()): string {
	const require = createRequire(join(from, 'package.json'));
	let dir = dirname(require.resolve('emdash'));
	for (let i = 0; i < 6; i++) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
			if (pkg.name === 'emdash' && pkg.version) {
				return pkg.version;
			}
		} catch {
			// keep walking up
		}
		dir = dirname(dir);
	}
	return 'unknown';
}
