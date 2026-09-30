import { hashSurface, validateSurface, type Diagnostic, type Slot, type Surface } from '@graft/core';
import { components } from './components.ts';
import { functions } from './functions.ts';
import { normalizeWordPressSchema } from './normalize-schema.ts';
import { lastJsonLine, runPhp } from './playground.ts';
import type { HostDump, WordPressModel } from './surface-types.ts';

export type { HostDump, WordPressModel };


/**
 * Merges the plugin's host dump with the adapter's components into a
 * surface: schemas normalized to draft 2020-12, maps sorted for stable
 * diffs, content hash filled in.
 */
export async function assembleSurface(dump: HostDump): Promise<Surface> {
	const slots = mapSorted(dump.slots, (slot) => {
		const out: Slot = { ...slot };
		if (slot.options !== undefined) {
			out.options = normalizeWordPressSchema(slot.options);
		}
		if (slot.provides !== undefined) {
			out.provides = normalizeWordPressSchema(slot.provides);
		}
		return out;
	});
	const capabilities = mapSorted(dump.capabilities, (capability) => ({
		...capability,
		input: normalizeWordPressSchema(capability.input),
		output: normalizeWordPressSchema(capability.output),
	}));

	const contract = {
		slots,
		components: mapSorted(components, (c) => c),
		capabilities,
		scopes: mapSorted(dump.scopes, (s) => s),
		audiences: [...dump.audiences],
		functions,
		...(dump.model ? { model: normalizeModel(dump.model) } : {}),
	};
	const header = { graft: 1, host: dump.host, hostVersion: dump.hostVersion } as const;
	const hash = await hashSurface({ ...header, ...contract });
	// Key order is for readable diffs: header, hash, then the contract.
	return { ...header, hash, fingerprint: dump.fingerprint, ...contract, migrations: [] };
}

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

/** PHP prints empty maps as []; the model's maps are objects. */
function normalizeModel(model: WordPressModel): Record<string, unknown> {
	return {
		postTypes: mapSorted(model.postTypes, (type) => ({ ...type, fields: mapSorted(type.fields, (schema) => normalizeWordPressSchema(schema)) })),
		taxonomies: mapSorted(model.taxonomies, (taxonomy) => taxonomy),
	};
}

function mapSorted<T, U>(map: Record<string, T> | [], fn: (value: T) => U): Record<string, U> {
	return Object.fromEntries(
		Object.entries(Array.isArray(map) ? {} : map)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, value]) => [key, fn(value as T)]),
	);
}
