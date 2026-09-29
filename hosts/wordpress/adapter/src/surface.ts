import { hashSurface, validateSurface, type Diagnostic, type Slot, type Surface } from '@graft/core';
import { components } from './components.ts';
import { normalizeWordPressSchema } from './normalize-schema.ts';
import { lastJsonLine, runPhp } from './playground.ts';

/** The host half of the surface as printed by the plugin (see dump-surface.php). */
export interface HostDump {
	graft: 1;
	host: 'wordpress';
	hostVersion: string;
	slots: Record<string, Slot> | [];
	capabilities: Record<string, Surface['capabilities'][string]> | [];
	scopes: Record<string, Surface['scopes'][string]> | [];
	audiences: string[];
	fingerprint: string;
}

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

/** Boots WordPress `wp` in Playground and generates its surface. */
export async function generateSurface(wp: string): Promise<GeneratedSurface> {
	const output = await runPhp({ wp, script: '/graft-playground/dump-surface.php' });
	const surface = await assembleSurface(lastJsonLine(output) as HostDump);
	const { diagnostics } = await validateSurface(surface);
	return { surface, diagnostics };
}

function mapSorted<T, U>(map: Record<string, T> | [], fn: (value: T) => U): Record<string, U> {
	return Object.fromEntries(
		Object.entries(Array.isArray(map) ? {} : map)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, value]) => [key, fn(value as T)]),
	);
}
