import type { JsonSchema, Scope, Surface } from '@graft/core';

/**
 * A synthetic host change for the canary: what a future EmDash (or a future
 * version of this adapter) might do to the surface. The sandbox applies it
 * to the surface it reports and to the calls it runs, so builds really meet
 * the changed host.
 */
export interface HostPatch {
	capabilities?: {
		/** Old name → new name. */
		rename?: Record<string, string>;
		remove?: string[];
		/** Capability → the scopes it needs instead. */
		scopes?: Record<string, string[]>;
		/** content.list takes "statuses" (a list) instead of "status". */
		statuses?: boolean;
	};
	slots?: {
		/** New slot → the existing slot it renders like. */
		alias?: Record<string, string>;
		/** Old slot → its successor; the old slot is deprecated. */
		deprecate?: Record<string, string>;
	};
	scopes?: { add?: Record<string, Scope> };
}

const renamedTo = (patch: HostPatch, name: string) => patch.capabilities?.rename?.[name] ?? name;

/** The surface as the patched host reports it (without a hash). */
export function patchSurface(surface: Surface, patch: HostPatch): Surface {
	const next = structuredClone(surface);
	delete next.hash;
	const caps = patch.capabilities ?? {};
	next.capabilities = {};
	for (const [name, capability] of Object.entries(surface.capabilities)) {
		if (caps.remove?.includes(name)) {
			continue;
		}
		const copy = structuredClone(capability);
		if (caps.scopes?.[name]) {
			copy.scopes = caps.scopes[name]!;
		}
		if (caps.statuses && name === 'content.list') {
			const input = copy.input as { properties: Record<string, JsonSchema> };
			const status = input.properties.status!;
			delete input.properties.status;
			input.properties.statuses = { description: 'Statuses to include.', type: 'array', items: status, minItems: 1, uniqueItems: true };
		}
		next.capabilities[renamedTo(patch, name)] = copy;
	}
	for (const [name, scope] of Object.entries(patch.scopes?.add ?? {})) {
		next.scopes[name] = scope;
	}
	for (const [alias, existing] of Object.entries(patch.slots?.alias ?? {})) {
		const slot = surface.slots[existing];
		if (slot) {
			next.slots[alias] = { ...structuredClone(slot), title: `${slot.title} (new)` };
		}
	}
	for (const [old, successor] of Object.entries(patch.slots?.deprecate ?? {})) {
		const slot = next.slots[old];
		if (slot) {
			slot.deprecated = true;
			slot.successor = successor;
		}
	}
	return next;
}

/** The slot the unpatched host renders for a (possibly new) slot name. */
export function baseSlot(patch: HostPatch, slot: string): string {
	return patch.slots?.alias?.[slot] ?? slot;
}

/**
 * Maps a call on the patched host to the capability and input the
 * adapter implements, or undefined when the patched host has no such
 * capability.
 */
export function resolveCall(patch: HostPatch, name: string, input: Record<string, unknown>): { name: string; input: Record<string, unknown>; statuses?: string[] } | undefined {
	const caps = patch.capabilities ?? {};
	const base = Object.entries(caps.rename ?? {}).find(([, to]) => to === name)?.[0] ?? (caps.rename?.[name] ? undefined : name);
	if (!base || caps.remove?.includes(base)) {
		return undefined;
	}
	if (caps.statuses && base === 'content.list') {
		if ('status' in input) {
			return undefined;
		}
		const { statuses, ...rest } = input as { statuses?: string[] };
		return statuses?.length === 1 ? { name: base, input: { ...rest, status: statuses[0] } } : { name: base, input: rest, ...(statuses ? { statuses } : {}) };
	}
	return { name: base, input };
}
