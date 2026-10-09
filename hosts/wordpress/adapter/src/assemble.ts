import { hashSurface, type Slot, type Surface } from '@swissspidy/graft-core';
import { normalizeWordPressSchema } from './normalize-schema.ts';
import type { HostDump, WordPressModel } from './surface-types.ts';

// Browser-safe: the admin screen assembles a site's own surface with it.

/**
 * Turns the plugin's host dump into a surface: schemas normalized to draft 2020-12, maps sorted for stable
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
		capabilities,
		scopes: mapSorted(dump.scopes, (s) => s),
		audiences: [...dump.audiences],
		...(dump.model ? { model: normalizeModel(dump.model) } : {}),
	};
	const header = { graft: 1, host: dump.host, hostVersion: dump.hostVersion } as const;
	const hash = await hashSurface({ ...header, ...contract });
	// Key order is for readable diffs: header, hash, then the contract.
	return { ...header, hash, fingerprint: dump.fingerprint, ...contract, migrations: [] };
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
