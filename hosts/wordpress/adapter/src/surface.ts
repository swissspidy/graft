import { validateSurface, type Diagnostic, type Surface } from '@swissspidy/graft-core';
import { assembleSurface } from './assemble.ts';
import { lastJsonLine, runPhp } from './playground.ts';
import type { HostDump, WordPressModel } from './surface-types.ts';

export { assembleSurface };
export type { HostDump, WordPressModel };

export interface GeneratedSurface {
	surface: Surface;
	diagnostics: Diagnostic[];
}

/**
 * Boots WordPress `wp` in Playground and generates its surface. `site` is a
 * site's must-use plugin (post types, fields, the graft_content_model
 * filter), for a surface of that site rather than of WordPress as it ships.
 */
export async function generateSurface(wp: string, { site }: { site?: string } = {}): Promise<GeneratedSurface> {
	const mounts = site ? { [site]: '/wordpress/wp-content/mu-plugins/graft-site.php' } : {};
	const output = await runPhp({ wp, script: '/graft-playground/dump-surface.php', mounts });
	const surface = await assembleSurface(lastJsonLine(output) as HostDump);
	const { diagnostics } = await validateSurface(surface);
	return { surface, diagnostics };
}
