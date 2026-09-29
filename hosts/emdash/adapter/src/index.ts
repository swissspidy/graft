import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { PluginDescriptor } from 'emdash';

/**
 * The Graft plugin descriptor for astro.config:
 *
 *   emdash({ plugins: [graft()] })
 *
 * Runs at config time only; the plugin itself is ./plugin/index.ts.
 */
export function graft(options: { sandbox?: boolean } = {}): PluginDescriptor {
	return {
		id: 'graft',
		version: '0.1.0',
		entrypoint: '@graft/emdash/plugin',
		options: { emdashVersion: emdashVersion(), sandbox: options.sandbox === true },
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
